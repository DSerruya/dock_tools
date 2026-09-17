import { Router } from 'express';
import * as configService from '../services/platformAppConfigService';
import * as platformAppService from '../services/platformAppService';
import * as dockerPlatformAppService from '../services/dockerPlatformAppService';
import * as auditService from '../services/auditService';
import { getUser } from '../utils/getUser';
import { requireRole } from '../middleware/auth';
import { PlatformAppConfig } from '../types';
import { validateRepo, validateEnvKeys } from '../utils/validation';

const router = Router();

// Strip the repoToken from configs sent over the wire — same convention as scripts.ts's
// sanitizeConfig, so the UI can show "(token configured)" without exposing the actual secret.
function sanitize(config: PlatformAppConfig): Omit<PlatformAppConfig, 'repoToken'> & { repoToken?: string } {
  const { repoToken, ...rest } = config;
  return repoToken ? { ...rest, repoToken: '***' } : rest;
}

function validateFields(body: Partial<PlatformAppConfig>): string | null {
  if (body.repo) {
    const err = validateRepo(body.repo);
    if (err) return err;
  }
  if (body.env) {
    const err = validateEnvKeys(body.env);
    if (err) return err;
  }
  if (body.containerPort !== undefined && (!Number.isInteger(body.containerPort) || body.containerPort <= 0)) {
    return 'containerPort must be a positive integer';
  }
  if (body.hostPort !== undefined && (!Number.isInteger(body.hostPort) || body.hostPort <= 0)) {
    return 'hostPort must be a positive integer';
  }
  if (body.healthCheckPath !== undefined && !body.healthCheckPath.startsWith('/')) {
    return 'healthCheckPath must start with "/"';
  }
  return null;
}

router.get('/', requireRole('admin', 'agent'), async (_req, res) => {
  const configs = configService.loadAll();
  const results = await Promise.all(configs.map(async config => ({
    config: sanitize(config),
    status: await dockerPlatformAppService.getStatus(config.name),
    build: platformAppService.getBuildState(config.name),
  })));
  res.json(results);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const body = req.body as Partial<PlatformAppConfig>;
  const user = getUser(req);

  if (!body.name || !body.repo || !body.branch || !body.containerPort) {
    return res.status(400).json({ error: 'name, repo, branch, and containerPort are required' });
  }
  if (!/^[a-z0-9-]+$/.test(body.name)) {
    return res.status(400).json({ error: 'name must be lowercase letters, numbers, and hyphens only' });
  }
  if (configService.get(body.name)) {
    return res.status(409).json({ error: `Platform app "${body.name}" already exists` });
  }
  const validationErr = validateFields(body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  // Guards against a name that collides with a container Platform Apps doesn't own — a Script
  // already using that name (both register the bare name as a Docker network alias) or a stray
  // container someone created by hand named "platform-app-<name>" — which apply() would
  // otherwise silently stop and remove.
  //
  // Any Docker Engine error here (socket hiccup, daemon restart mid-request) must be caught
  // explicitly: an uncaught rejection in an async Express handler crashes the whole process
  // (Express 4 doesn't catch it, and there's no unhandledRejection handler), which nginx then
  // surfaces as a 502.
  try {
    if (await dockerPlatformAppService.isNameTaken(body.name)) {
      return res.status(409).json({
        error: `"${body.name}" collides with an existing container Platform Apps doesn't manage`,
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to check for a name collision: ${err?.message || err}` });
  }

  const config: PlatformAppConfig = {
    name: body.name,
    repo: body.repo,
    branch: body.branch,
    repoToken: body.repoToken,
    containerPort: body.containerPort,
    hostPort: body.hostPort,
    env: body.env,
    needsDockerSock: !!body.needsDockerSock,
    needsDataVolume: !!body.needsDataVolume,
    healthCheckPath: body.healthCheckPath,
    resources: body.resources,
    createdAt: new Date().toISOString(),
  };

  configService.save(config);
  auditService.record(user, 'platform-app.created', config.name, [
    { field: 'repo', newValue: config.repo },
    { field: 'branch', newValue: config.branch },
    { field: 'containerPort', newValue: config.containerPort },
    { field: 'hostPort', newValue: config.hostPort },
    { field: 'needsDockerSock', newValue: config.needsDockerSock },
    { field: 'needsDataVolume', newValue: config.needsDataVolume },
    { field: 'healthCheckPath', newValue: config.healthCheckPath },
  ]);

  res.status(201).json({ message: 'Platform app added. Cloning and building in background...' });

  setImmediate(async () => {
    try {
      await platformAppService.install(config);
      configService.save({ ...config, lastSync: new Date().toISOString() });
    } catch (err) {
      console.error(`[platform-apps] install ${config.name}:`, err);
    }
  });
});

router.put('/:name', requireRole('admin'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (platformAppService.isDeploying(existing.name)) {
    return res.status(409).json({ error: `"${existing.name}" is still installing/updating — wait for it to finish` });
  }

  const body = req.body as Partial<PlatformAppConfig>;
  const validationErr = validateFields(body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const updated: PlatformAppConfig = {
    ...existing,
    branch: body.branch ?? existing.branch,
    repoToken: body.repoToken !== undefined ? body.repoToken : existing.repoToken,
    containerPort: body.containerPort ?? existing.containerPort,
    hostPort: body.hostPort !== undefined ? body.hostPort : existing.hostPort,
    env: body.env ?? existing.env,
    needsDockerSock: body.needsDockerSock ?? existing.needsDockerSock,
    needsDataVolume: body.needsDataVolume ?? existing.needsDataVolume,
    healthCheckPath: body.healthCheckPath ?? existing.healthCheckPath,
    resources: body.resources ?? existing.resources,
  };
  // repo/name are immutable after creation — same convention as ScriptConfig — since changing
  // either would silently detach this record from its already-cloned repo / already-running
  // container rather than actually re-pointing them.

  configService.save(updated);
  auditService.record(getUser(req), 'platform-app.updated', updated.name, [
    { field: 'containerPort', oldValue: existing.containerPort, newValue: updated.containerPort },
    { field: 'hostPort', oldValue: existing.hostPort, newValue: updated.hostPort },
  ]);

  res.json({ message: 'Updated. Applying...' });

  setImmediate(async () => {
    try {
      await dockerPlatformAppService.apply(updated);
    } catch (err) {
      console.error(`[platform-apps] apply ${updated.name}:`, err);
    }
  });
});

router.delete('/:name', requireRole('admin'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });

  try {
    await platformAppService.uninstall(existing.name);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
  configService.remove(existing.name);
  auditService.record(getUser(req), 'platform-app.deleted', existing.name, []);
  res.json({ message: 'deleted' });
});

// Start/stop/restart/update are all gated on isDeploying(): an in-flight install/update ends with
// its own apply() (stop+remove+create+start), so letting one of these race it could create two
// containers of the same name at once or leave the container the update just swapped in
// immediately stopped again.
router.post('/:name/start', requireRole('admin', 'agent'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (platformAppService.isDeploying(existing.name)) {
    return res.status(409).json({ error: `"${existing.name}" is still installing/updating` });
  }
  try {
    await platformAppService.start(existing.name);
    res.json({ message: 'started' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

router.post('/:name/stop', requireRole('admin', 'agent'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (platformAppService.isDeploying(existing.name)) {
    return res.status(409).json({ error: `"${existing.name}" is still installing/updating` });
  }
  try {
    await platformAppService.stop(existing.name);
    res.json({ message: 'stopped' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

router.post('/:name/restart', requireRole('admin', 'agent'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (platformAppService.isDeploying(existing.name)) {
    return res.status(409).json({ error: `"${existing.name}" is still installing/updating` });
  }
  try {
    await platformAppService.restart(existing);
    res.json({ message: 'restarted' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

router.post('/:name/update', requireRole('admin', 'agent'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (platformAppService.isDeploying(existing.name)) {
    return res.status(409).json({ error: `"${existing.name}" is already installing/updating` });
  }

  res.json({ message: 'Pulling and rebuilding in background...' });

  setImmediate(async () => {
    try {
      await platformAppService.update(existing);
      configService.save({ ...existing, lastSync: new Date().toISOString() });
    } catch (err) {
      console.error(`[platform-apps] update ${existing.name}:`, err);
    }
  });
});

router.get('/:name/logs', requireRole('admin', 'agent'), async (req, res) => {
  const existing = configService.get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const logs = await dockerPlatformAppService.getLogs(existing.name);
  res.json({ logs });
});

export default router;
