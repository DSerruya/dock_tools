import { Router } from 'express';
import * as configService from '../services/configService';
import * as dockerService from '../services/dockerService';
import * as gitService from '../services/gitService';
import * as cronService from '../services/cronService';
import { ScriptConfig } from '../types';

const router = Router();

router.get('/', async (_req, res) => {
  const configs = configService.loadAll();
  const results = await Promise.all(configs.map(async config => {
    const cloned = gitService.isCloned(config.name);
    const status = cloned ? await dockerService.getStatus(config.name) : 'not_cloned';
    const nextRun = config.runMode === 'scheduled' ? cronService.getNextRun(config.name) : null;
    return { config, status, nextRun };
  }));
  res.json(results);
});

router.post('/', async (req, res) => {
  const body = req.body as Partial<ScriptConfig>;

  if (!body.name || !body.language || !body.repo || !body.entryPoint) {
    return res.status(400).json({ error: 'name, language, repo, and entryPoint are required' });
  }
  if (!/^[a-z0-9-]+$/.test(body.name)) {
    return res.status(400).json({ error: 'name must be lowercase letters, numbers, and hyphens only' });
  }
  if (configService.get(body.name)) {
    return res.status(409).json({ error: `Script "${body.name}" already exists` });
  }
  if (body.runMode === 'scheduled' && body.schedule && !cronService.isValidExpression(body.schedule)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const config: ScriptConfig = {
    name: body.name,
    language: body.language,
    repo: body.repo,
    entryPoint: body.entryPoint,
    branch: body.branch || 'main',
    runMode: body.runMode || 'persistent',
    port: body.port,
    env: body.env,
    schedule: body.schedule,
    timezone: body.timezone,
    createdAt: new Date().toISOString(),
  };

  configService.save(config);

  // Clone and start in background
  setImmediate(async () => {
    try {
      await gitService.cloneOrPull(config);
      configService.save({ ...config, lastSync: new Date().toISOString() });

      if (config.runMode === 'persistent') {
        await dockerService.start(config);
      } else if (config.runMode === 'scheduled' && config.schedule) {
        cronService.register(config);
      }
    } catch (err) {
      console.error(`[setup] ${config.name}:`, err);
    }
  });

  res.status(201).json({ message: 'Script added. Cloning repository in background...' });
});

router.delete('/:name', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  try {
    cronService.unregister(req.params.name);
    await dockerService.removeContainer(req.params.name);
    configService.remove(req.params.name);
    res.json({ message: `Script "${req.params.name}" removed` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:name/start', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  try {
    await gitService.cloneOrPull(config);
    configService.save({ ...config, lastSync: new Date().toISOString() });

    if (config.runMode === 'persistent') {
      await dockerService.start(config);
      res.json({ message: 'Script started' });
    } else {
      if (config.schedule) cronService.register(config);
      res.json({ message: 'Scheduled script registered. Use "Run Now" to trigger immediately.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:name/stop', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  try {
    await dockerService.stop(req.params.name);
    res.json({ message: 'Script stopped' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:name/restart', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  try {
    await gitService.pull(config);
    const updated = { ...config, lastSync: new Date().toISOString() };
    configService.save(updated);
    await dockerService.restart(updated);
    res.json({ message: 'Script restarted with latest code' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:name/run-now', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  if (!gitService.isCloned(config.name)) {
    return res.status(400).json({ error: 'Repository not cloned yet. Start the script first.' });
  }

  res.json({ message: 'Execution triggered' });

  setImmediate(async () => {
    try {
      const result = await dockerService.runOnce(config);
      configService.save({ ...config, lastRun: new Date().toISOString() });
      console.log(`[run-now] ${config.name} exited with code ${result.exitCode}`);
    } catch (err) {
      console.error(`[run-now] ${config.name}:`, err);
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name/status', async (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  const cloned = gitService.isCloned(config.name);
  const status = cloned ? await dockerService.getStatus(config.name) : 'not_cloned';
  const nextRun = config.runMode === 'scheduled' ? cronService.getNextRun(config.name) : null;
  res.json({ config, status, nextRun });
});

router.put('/:name/schedule', (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  const { schedule, timezone } = req.body;
  if (!schedule) return res.status(400).json({ error: 'schedule is required' });
  if (!cronService.isValidExpression(schedule)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const updated = { ...config, schedule, timezone: timezone || config.timezone, runMode: 'scheduled' as const };
  configService.save(updated);
  cronService.reschedule(updated);
  res.json({ message: 'Schedule updated', nextRun: cronService.getNextRun(config.name) });
});

router.delete('/:name/schedule', (req, res) => {
  const config = configService.get(req.params.name);
  if (!config) return res.status(404).json({ error: 'Script not found' });

  const updated = { ...config, schedule: undefined, runMode: 'persistent' as const };
  configService.save(updated);
  cronService.unregister(config.name);
  res.json({ message: 'Schedule removed — switched to persistent mode' });
});

export default router;
