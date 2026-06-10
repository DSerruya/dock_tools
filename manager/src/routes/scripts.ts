import { Router } from 'express';
import * as path from 'path';
import * as fs   from 'fs';
import { spawn } from 'child_process';
import multer from 'multer';
import * as configService from '../services/configService';
import * as dockerService from '../services/dockerService';
import * as gitService    from '../services/gitService';
import * as cronService   from '../services/cronService';
import * as logService    from '../services/logService';
import * as auditService  from '../services/auditService';
import { getUser }        from '../utils/getUser';
import { requireRole }    from '../middleware/auth';
import { ScriptConfig }   from '../types';
import {
  validateLanguage,
  validateRepo,
  validateShellCommand,
  validateEnvKeys,
} from '../utils/validation';

const router  = Router();
const DATA_DIR = process.env.DATA_DIR || '/app/scripts-data';
const VPN_DIR  = path.join(DATA_DIR, 'vpn');
const vpnUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

// Strip the repoToken from configs sent over the wire.
// When a token IS configured, return '***' so the UI can show "(token configured)"
// without exposing the actual secret.
function sanitizeConfig(config: ScriptConfig): Omit<ScriptConfig, 'repoToken'> & { repoToken?: string } {
  const { repoToken, ...rest } = config;
  return repoToken ? { ...rest, repoToken: '***' } : rest;
}

function validateScriptFields(body: Partial<ScriptConfig>): string | null {
  if (body.language) {
    const err = validateLanguage(body.language);
    if (err) return err;
  }
  if (body.repo) {
    const err = validateRepo(body.repo);
    if (err) return err;
  }
  if (body.entryPoint) {
    const err = validateShellCommand(body.entryPoint, 'entryPoint');
    if (err) return err;
  }
  if (body.buildCommand) {
    const err = validateShellCommand(body.buildCommand, 'buildCommand');
    if (err) return err;
  }
  if (body.env) {
    const err = validateEnvKeys(body.env);
    if (err) return err;
  }
  return null;
}

router.get('/', async (_req, res) => {
  const configs = configService.loadAll();
  const results = await Promise.all(configs.map(async config => {
    const cloned  = gitService.isCloned(config.name);
    const status  = cloned ? await dockerService.getStatus(config.name) : 'not_cloned';
    const nextRun = config.runMode === 'scheduled' ? cronService.getNextRun(config.name) : null;
    return { config: sanitizeConfig(config), status, nextRun };
  }));
  res.json(results);
});

router.post('/', requireRole('admin', 'agent'), async (req, res) => {
  const body = req.body as Partial<ScriptConfig>;
  const user = getUser(req);

  if (!body.name || !body.language || !body.repo || !body.entryPoint)
    return res.status(400).json({ error: 'name, language, repo, and entryPoint are required' });
  if (!/^[a-z0-9-]+$/.test(body.name))
    return res.status(400).json({ error: 'name must be lowercase letters, numbers, and hyphens only' });
  if (configService.get(body.name))
    return res.status(409).json({ error: `Script "${body.name}" already exists` });
  if (body.runMode === 'scheduled' && body.schedule && !cronService.isValidExpression(body.schedule))
    return res.status(400).json({ error: 'Invalid cron expression' });

  const validationError = validateScriptFields(body);
  if (validationError) return res.status(400).json({ error: validationError });

  const config: ScriptConfig = {
    name:         body.name,
    language:     body.language,
    repo:         body.repo,
    entryPoint:   body.entryPoint,
    branch:       body.branch       || 'main',
    runMode:      body.runMode      || 'persistent',
    port:         body.port,
    env:          body.env,
    buildCommand: body.buildCommand || undefined,
    repoToken:    body.repoToken    || undefined,
    schedule:     body.schedule,
    timezone:     body.timezone,
    createdAt:    new Date().toISOString(),
  };

  configService.save(config);
  auditService.record(user, 'script.created', config.name, auditService.configAsChanges(config));

  setImmediate(async () => {
    try {
      await gitService.cloneOrPull(config);
      configService.save({ ...config, lastSync: new Date().toISOString() });
      if (config.runMode === 'persistent') {
        const runId = logService.createRun(config.name, config.language, config.runMode);
        await dockerService.start(config, runId);
      } else if (config.runMode === 'scheduled' && config.schedule) {
        cronService.register(config);
      }
    } catch (err) { console.error(`[setup] ${config.name}:`, err); }
  });

  res.status(201).json({ message: 'Script added. Cloning repository in background...' });
});

router.put('/:name', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);
  const body = req.body as Partial<ScriptConfig>;

  if (body.runMode === 'scheduled' && body.schedule && !cronService.isValidExpression(body.schedule))
    return res.status(400).json({ error: 'Invalid cron expression' });

  const validationError = validateScriptFields(body);
  if (validationError) return res.status(400).json({ error: validationError });

  // '***' means the client echoed back our masked placeholder — treat as no change
  const incomingToken = (body.repoToken && body.repoToken !== '***') ? body.repoToken : undefined;

  // Build updated config, preserving immutable/runtime fields
  const updated: ScriptConfig = {
    ...config,
    language:     (body.language     ?? config.language),
    repo:         (body.repo         ?? config.repo),
    branch:       (body.branch       ?? config.branch),
    entryPoint:   (body.entryPoint   ?? config.entryPoint),
    buildCommand: body.buildCommand  !== undefined ? (body.buildCommand  || undefined) : config.buildCommand,
    repoToken:    body.repoToken     !== undefined ? (incomingToken      || undefined) : config.repoToken,
    port:         body.port          !== undefined ?  body.port                        : config.port,
    env:          body.env           !== undefined ?  body.env                         : config.env,
    runMode:      (body.runMode      ?? config.runMode),
    schedule:     body.schedule      !== undefined ? (body.schedule      || undefined) : config.schedule,
    timezone:     body.timezone      !== undefined ? (body.timezone      || undefined) : config.timezone,
  };

  const changes = auditService.diffConfigs(config, updated);
  if (!changes.length) return res.json({ message: 'No changes detected' });

  const repoChanged = config.repo !== updated.repo || config.branch !== updated.branch;
  const prevStatus  = await dockerService.getStatus(config.name);
  const wasRunning  = prevStatus === 'running';

  // Stop any active run record
  const activeRun = logService.findRunningRun(config.name);
  if (activeRun) logService.markRunFailed(activeRun.runId, 'Config updated');

  // Unregister existing cron before saving so it uses the old config
  cronService.unregister(config.name);

  configService.save(updated);
  auditService.record(user, 'config.updated', config.name, changes);

  res.json({ message: 'Config saved. Applying changes in background...' });

  setImmediate(async () => {
    try {
      if (repoChanged) {
        // Wipe old clone so the next start re-clones from the new URL/branch
        gitService.deleteClone(config.name);
        console.log(`[edit] Deleted clone for ${config.name} — will re-clone on next start`);
      }

      const modeChanged = config.runMode !== updated.runMode;

      if (updated.runMode === 'persistent') {
        if (wasRunning || modeChanged) {
          await dockerService.removeContainer(config.name);
          if (!repoChanged) {
            // Pull latest if repo hasn't changed
            if (gitService.isCloned(config.name)) await gitService.pull(updated);
          } else {
            await gitService.clone(updated);
            configService.save({ ...updated, lastSync: new Date().toISOString() });
          }
          const runId = logService.createRun(updated.name, updated.language, updated.runMode);
          await dockerService.start(updated, runId);
        }
      } else if (updated.runMode === 'scheduled') {
        await dockerService.removeContainer(config.name);
        if (updated.schedule) cronService.register(updated);
      }
    } catch (err) { console.error(`[edit] ${config.name}:`, err); }
  });
});

router.delete('/:name', requireRole('admin'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  try {
    const activeRun = logService.findRunningRun(req.params.name);
    if (activeRun) logService.markRunFailed(activeRun.runId, 'Script deleted');
    cronService.unregister(req.params.name);
    await dockerService.removeContainer(req.params.name, config.vpnEnabled);
    configService.remove(req.params.name);
    auditService.record(user, 'script.deleted', req.params.name,
      auditService.configAsChanges(config).map(c => ({ field: c.field, oldValue: c.newValue, newValue: undefined }))
    );
    res.json({ message: `Script "${req.params.name}" removed` });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/:name/start', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  try {
    await gitService.cloneOrPull(config);
    configService.save({ ...config, lastSync: new Date().toISOString() });
    auditService.record(user, 'script.started', config.name, []);

    if (config.runMode === 'persistent') {
      const activeRun = logService.findRunningRun(config.name);
      if (activeRun) logService.markRunFailed(activeRun.runId, 'Script restarted');
      const runId = logService.createRun(config.name, config.language, config.runMode);
      await dockerService.start(config, runId);
      res.json({ message: 'Script started', runId });
    } else {
      if (config.schedule) cronService.register(config);
      res.json({ message: 'Scheduled script registered. Use "Run Now" to trigger immediately.' });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/:name/stop', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  try {
    await dockerService.stop(req.params.name, config.vpnEnabled);
    const activeRun = logService.findRunningRun(req.params.name);
    if (activeRun) logService.finishRun(activeRun.runId, 0);
    auditService.record(user, 'script.stopped', config.name, []);
    res.json({ message: 'Script stopped' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/:name/restart', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  try {
    await gitService.pull(config);
    const updated = { ...config, lastSync: new Date().toISOString() };
    configService.save(updated);

    const activeRun = logService.findRunningRun(config.name);
    if (activeRun) logService.markRunFailed(activeRun.runId, 'Script restarted');

    const runId = logService.createRun(config.name, config.language, config.runMode);
    await dockerService.restart(updated, runId);
    auditService.record(user, 'script.restarted', config.name, []);
    res.json({ message: 'Script restarted with latest code', runId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/:name/run-now', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  if (!gitService.isCloned(config.name))
    return res.status(400).json({ error: 'Repository not cloned yet. Start the script first.' });

  const runId = logService.createRun(config.name, config.language, config.runMode);
  auditService.record(user, 'run.triggered', config.name, []);
  res.json({ message: 'Execution triggered', runId });

  setImmediate(async () => {
    try {
      const result = await dockerService.runOnce(config, runId);
      logService.finishRun(runId, result.exitCode);
      configService.save({ ...config, lastRun: new Date().toISOString() });
    } catch (err: any) {
      logService.markRunFailed(runId, err.message);
    }
  });
});

router.get('/:name/logs', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  try {
    const tail = parseInt(req.query.tail as string) || 200;
    const logs = await dockerService.getLogs(req.params.name, tail);
    res.json({ logs });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/status', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const cloned  = gitService.isCloned(config.name);
  const status  = cloned ? await dockerService.getStatus(config.name) : 'not_cloned';
  const nextRun = config.runMode === 'scheduled' ? cronService.getNextRun(config.name) : null;
  res.json({ config: sanitizeConfig(config), status, nextRun });
});

router.put('/:name/schedule', requireRole('admin', 'agent'), (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  const { schedule, timezone } = req.body;
  if (!schedule) return res.status(400).json({ error: 'schedule is required' });
  if (!cronService.isValidExpression(schedule))
    return res.status(400).json({ error: 'Invalid cron expression' });

  const updated = { ...config, schedule, timezone: timezone || config.timezone, runMode: 'scheduled' as const };
  configService.save(updated);
  cronService.reschedule(updated);

  auditService.record(user, 'config.schedule.set', config.name,
    auditService.diffConfigs(config, updated)
  );
  res.json({ message: 'Schedule updated', nextRun: cronService.getNextRun(config.name) });
});

router.delete('/:name/schedule', requireRole('admin', 'agent'), (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  const updated = { ...config, schedule: undefined, runMode: 'persistent' as const };
  configService.save(updated);
  cronService.unregister(config.name);

  auditService.record(user, 'config.schedule.removed', config.name,
    auditService.diffConfigs(config, updated)
  );
  res.json({ message: 'Schedule removed — switched to persistent mode' });
});

router.get('/:name/check-update', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  if (!gitService.isCloned(config.name))
    return res.status(400).json({ error: 'Repository not cloned yet. Start the script first.' });
  try {
    const result = await gitService.checkForUpdates(config);
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/:name/update', requireRole('admin', 'agent'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  if (!gitService.isCloned(config.name))
    return res.status(400).json({ error: 'Repository not cloned yet. Start the script first.' });
  const user = getUser(req);

  try {
    await gitService.pull(config);
    // env is stored in scripts.json, not in the repo — preserved automatically
    const updated = { ...config, lastSync: new Date().toISOString() };
    configService.save(updated);
    auditService.record(user, 'script.updated', config.name, []);

    if (config.runMode === 'persistent') {
      const activeRun = logService.findRunningRun(config.name);
      if (activeRun) logService.markRunFailed(activeRun.runId, 'Script updated');
      const runId = logService.createRun(config.name, config.language, config.runMode);
      await dockerService.restart(updated, runId);
      res.json({ message: 'Update applied and script restarted' });
    } else {
      res.json({ message: 'Update applied' });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/scripts/:name/vpn — upload .ovpn config file
router.post('/:name/vpn', requireRole('admin', 'agent'), vpnUpload.single('ovpn'), (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.endsWith('.ovpn'))
    return res.status(400).json({ error: 'File must be a .ovpn file' });

  if (!fs.existsSync(VPN_DIR)) fs.mkdirSync(VPN_DIR, { recursive: true });
  fs.writeFileSync(path.join(VPN_DIR, `${config.name}.ovpn`), req.file.buffer);
  res.json({ message: 'VPN config uploaded' });
});

// DELETE /api/scripts/:name/vpn — remove .ovpn config file
router.delete('/:name/vpn', requireRole('admin', 'agent'), (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  const filePath = path.join(VPN_DIR, `${config.name}.ovpn`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ message: 'VPN config removed' });
});

// GET /api/scripts/:name/vpn — check if .ovpn config exists
router.get('/:name/vpn', requireRole('admin', 'agent'), (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  const filePath = path.join(VPN_DIR, `${config.name}.ovpn`);
  res.json({ configured: fs.existsSync(filePath) });
});

// GET /api/scripts/:name/download — streams the cloned repo as a .tar.gz archive
router.get('/:name/download', requireRole('admin', 'agent'), (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  if (!gitService.isCloned(config.name))
    return res.status(400).json({ error: 'Repository not cloned yet. Start the script first.' });

  const repoPath = gitService.getLocalPath(config.name);
  const filename = `${config.name}.tar.gz`;

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // tar -czf - -C <parentDir> <repoDir>
  const tar = spawn('tar', [
    '-czf', '-',
    '-C', path.dirname(repoPath),
    path.basename(repoPath),
  ]);

  tar.stdout.pipe(res);

  tar.on('error', err => {
    console.error(`[download] tar error for ${config.name}:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  tar.stderr.on('data', () => { /* suppress tar warnings */ });
});

export default router;
