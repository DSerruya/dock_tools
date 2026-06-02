import { Router } from 'express';
import * as configService from '../services/configService';
import * as dockerService from '../services/dockerService';
import * as gitService    from '../services/gitService';
import * as cronService   from '../services/cronService';
import * as logService    from '../services/logService';
import * as auditService  from '../services/auditService';
import { getUser }        from '../utils/getUser';
import { requireRole }    from '../middleware/auth';
import { ScriptConfig }   from '../types';

const router = Router();

router.get('/', async (_req, res) => {
  const configs = configService.loadAll();
  const results = await Promise.all(configs.map(async config => {
    const cloned  = gitService.isCloned(config.name);
    const status  = cloned ? await dockerService.getStatus(config.name) : 'not_cloned';
    const nextRun = config.runMode === 'scheduled' ? cronService.getNextRun(config.name) : null;
    return { config, status, nextRun };
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

router.delete('/:name', requireRole('admin'), async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });
  const user = getUser(req);

  try {
    const activeRun = logService.findRunningRun(req.params.name);
    if (activeRun) logService.markRunFailed(activeRun.runId, 'Script deleted');
    cronService.unregister(req.params.name);
    await dockerService.removeContainer(req.params.name);
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
    await dockerService.stop(req.params.name);
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
  res.json({ config, status, nextRun });
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

export default router;
