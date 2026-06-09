import { Router } from 'express';
import { spawn }   from 'child_process';
import * as fs     from 'fs';
import * as os     from 'os';
import * as path   from 'path';
import Dockerode   from 'dockerode';
import simpleGit   from 'simple-git';
import * as userService  from '../services/userService';
import * as auditService from '../services/auditService';
import { requireRole }   from '../middleware/auth';
import { getUser }       from '../utils/getUser';

const router = Router();

// ── Self-update machinery ─────────────────────────────────────────────────────

const docker       = new Dockerode({ socketPath: '/var/run/docker.sock' });
const IMAGE_TAG    = 'dock-tools-manager:latest';
const PROJECT_REPO = process.env.PROJECT_REPO || 'https://github.com/DSerruya/dock_tools.git';

// Parse "DSerruya/dock_tools" from the repo URL for the GitHub API
const repoSlug = PROJECT_REPO
  .replace(/^https?:\/\/github\.com\//, '')
  .replace(/\.git$/, '');

type UpdateStatus = 'idle' | 'cloning' | 'building' | 'done' | 'error';
let updateState: { status: UpdateStatus; log: string; error?: string } =
  { status: 'idle', log: '' };

function appendLog(line: string): void {
  updateState.log += line + '\n';
  console.log('[update]', line);
}

async function buildImage(contextDir: string, commitSha: string): Promise<void> {
  const tarProc = spawn('tar', ['-c', '-C', contextDir, '.']);

  const buildStream = await docker.buildImage(tarProc.stdout as NodeJS.ReadableStream, {
    t:          IMAGE_TAG,
    buildargs:  { GIT_COMMIT: commitSha, BUILD_TIME: new Date().toISOString() },
  });

  return new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null) => { if (err) reject(err); else resolve(); },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) appendLog(event.stream.trimEnd());
        if (event.error)  reject(new Error(event.error));
      },
    );
  });
}

async function runUpdate(): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), 'dock-tools-update');
  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    updateState.status = 'cloning';
    appendLog(`Cloning ${PROJECT_REPO} …`);
    await simpleGit().clone(PROJECT_REPO, tmpDir, ['--depth', '1']);
    const commitSha = (await simpleGit(tmpDir).revparse(['HEAD'])).trim();
    appendLog(`Cloned at ${commitSha.slice(0, 7)}.`);

    updateState.status = 'building';
    appendLog('Building new Docker image …');
    await buildImage(path.join(tmpDir, 'manager'), commitSha);
    appendLog('Build complete. Recreating container with new image …');

    const selfCtr  = docker.getContainer('script-manager');
    const selfInfo = await selfCtr.inspect();
    const selfId   = selfInfo.Id;
    const network  = Object.keys(selfInfo.NetworkSettings.Networks)[0] || 'script-network';

    // Clean up any leftover containers from a previous failed update
    for (const leftover of ['script-manager-old']) {
      try {
        const c    = docker.getContainer(leftover);
        const info = await c.inspect();
        if (info.Id !== selfId) {
          if (info.State.Running) await c.stop({ t: 3 });
          await c.remove({ force: true });
          appendLog(`Removed stale container: ${leftover}`);
        }
      } catch (_) { /* doesn't exist — fine */ }
    }

    // Rename ourselves to free the container name
    await selfCtr.rename({ name: 'script-manager-old' });
    appendLog('Renamed old container.');

    // Create replacement container using NetworkingConfig in the create call
    // (more reliable than NetworkMode:'none' + separate connect)
    let newCtr: Dockerode.Container;
    try {
      newCtr = await docker.createContainer({
        name:  'script-manager',
        Image: IMAGE_TAG,
        Env:   selfInfo.Config.Env,
        HostConfig: {
          Binds:         selfInfo.HostConfig.Binds,
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [network]: { Aliases: ['manager', 'script-manager'] },
          },
        },
      });
    } catch (createErr: any) {
      appendLog(`Container create failed: ${createErr.message}. Rolling back rename…`);
      try { await docker.getContainer('script-manager-old').rename({ name: 'script-manager' }); } catch (_) {}
      throw createErr;
    }

    await newCtr.start();
    appendLog('New container started. Running health check…');

    // Health check — wait up to 20s for the new container to stay running.
    // If it crashes, roll back to the old container automatically.
    let healthy = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const info = await docker.getContainer('script-manager').inspect();
        if (info.State.Running && !info.State.Restarting) { healthy = true; break; }
      } catch (_) { break; }
    }

    if (!healthy) {
      appendLog('Health check failed — new container is not running. Rolling back…');
      try { await docker.getContainer('script-manager').stop(); } catch (_) {}
      try { await docker.getContainer('script-manager').remove({ force: true }); } catch (_) {}
      try { await docker.getContainer('script-manager-old').rename({ name: 'script-manager' }); } catch (_) {}
      throw new Error('New container failed health check. Rolled back to previous version — no downtime.');
    }

    appendLog('Health check passed. Shutting down old container…');
    updateState.status = 'done';

    // Update our own restart policy to 'no' so Docker does not restart us
    // with the old image after we stop ourselves.
    try { await selfCtr.update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } }); } catch (_) {}

    setTimeout(async () => {
      try { await docker.getContainer('script-manager-old').stop({ t: 3 }); } catch (_) {}
      // Process dies here — that's expected
    }, 500);
  } catch (err: any) {
    updateState.status = 'error';
    updateState.error  = err.message;
    appendLog(`Error: ${err.message}`);
    console.error('[update] failed:', err);
  }
}

// GET /api/admin/version
router.get('/version', (_req, res) => {
  res.json({
    commit:    process.env.GIT_COMMIT || 'dev',
    buildTime: process.env.BUILD_TIME || null,
    repoSlug,
  });
});

// GET /api/admin/update/latest-commit — proxies GitHub API server-side
router.get('/update/latest-commit', requireRole('admin'), async (_req, res) => {
  try {
    const url  = `https://api.github.com/repos/${repoSlug}/commits/main`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'dock-tools-manager' },
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `GitHub API returned ${resp.status}` });
    const sha = (await resp.text()).trim();
    res.json({ sha });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/update/status
router.get('/update/status', requireRole('admin'), (_req, res) => {
  res.json(updateState);
});

// POST /api/admin/update
router.post('/update', requireRole('admin'), (req, res) => {
  if (updateState.status === 'cloning' || updateState.status === 'building')
    return res.status(409).json({ error: 'Update already in progress' });

  updateState = { status: 'cloning', log: '' };
  res.json({ message: 'Update started' });
  setImmediate(() => runUpdate());
});

// Every admin route requires admin role
router.use(requireRole('admin'));

// GET /api/admin/users
router.get('/users', (_req, res) => {
  const users = userService.listUsers().map(u => ({
    username:  u.username,
    role:      u.role,
    createdAt: u.createdAt,
  }));
  res.json(users);
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
  const { username, password, role } = req.body;
  const actor = getUser(req);

  if (!username || !password || !role)
    return res.status(400).json({ error: 'username, password, and role are required' });
  if (!['admin', 'agent', 'viewer'].includes(role))
    return res.status(400).json({ error: 'role must be admin, agent, or viewer' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return res.status(400).json({ error: 'username may only contain letters, numbers, _ and -' });
  if (password.length < 6)
    return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const user = await userService.createUser(username, password, role as userService.Role);
    auditService.record(actor, 'user.created', username, [
      { field: 'role', oldValue: undefined, newValue: role },
    ]);
    res.status(201).json({ username: user.username, role: user.role, createdAt: user.createdAt });
  } catch (err: any) { res.status(409).json({ error: err.message }); }
});

// PUT /api/admin/users/:username
router.put('/users/:username', async (req, res) => {
  const { role, password } = req.body;
  const actor = getUser(req);

  if (!role && !password)
    return res.status(400).json({ error: 'Provide role and/or password to update' });
  if (role && !['admin', 'agent', 'viewer'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  if (password && password.length < 6)
    return res.status(400).json({ error: 'password must be at least 6 characters' });

  try {
    const before = userService.listUsers().find(u => u.username === req.params.username);
    const user   = await userService.updateUser(req.params.username, { role, password });

    const changes: auditService.ChangeDetail[] = [];
    if (role && before?.role !== role)
      changes.push({ field: 'role', oldValue: before?.role, newValue: role });
    if (password)
      changes.push({ field: 'password', oldValue: '(changed)', newValue: '(changed)' });

    auditService.record(actor, 'user.updated', req.params.username, changes);
    res.json({ username: user.username, role: user.role });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/admin/users/:username
router.delete('/users/:username', (req, res) => {
  const actor = getUser(req);
  try {
    userService.deleteUser(req.params.username, actor);
    auditService.record(actor, 'user.deleted', req.params.username, []);
    res.json({ message: `User "${req.params.username}" deleted` });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

export default router;
