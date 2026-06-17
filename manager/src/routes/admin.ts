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
    const builtinNetworks = new Set(['none', 'bridge', 'host']);
    const network =
      process.env.DOCKER_NETWORK ||
      Object.keys(selfInfo.NetworkSettings.Networks).find(n => !builtinNetworks.has(n)) ||
      'script-network';

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
      // Strip image-baked vars so the new image's GIT_COMMIT/BUILD_TIME are used
      const inheritedEnv = (selfInfo.Config.Env || []).filter(
        (e: string) => !e.startsWith('GIT_COMMIT=') && !e.startsWith('BUILD_TIME='),
      );
      newCtr = await docker.createContainer({
        name:  'script-manager',
        Image: IMAGE_TAG,
        Env:   inheritedEnv,
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

    // Phase 1 — container running check (up to 30 s)
    let healthy = false;
    let lastState = 'unknown';
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const info = await docker.getContainer('script-manager').inspect();
        lastState = `Running=${info.State.Running} Restarting=${info.State.Restarting} Status=${info.State.Status}`;
        if (info.State.Running && !info.State.Restarting) { healthy = true; break; }
      } catch (e: any) { lastState = `inspect error: ${e.message}`; break; }
    }

    if (!healthy) {
      appendLog(`Health check failed (${lastState}). Capturing container logs…`);
      try {
        const logStream = await docker.getContainer('script-manager').logs({
          stdout: true, stderr: true, tail: 50,
        });
        appendLog('--- container logs (last 50 lines) ---');
        appendLog(logStream.toString().replace(/[\x00-\x08\x0b-\x1f]/g, ''));
        appendLog('--- end container logs ---');
      } catch (_) {}
      appendLog('Rolling back…');
      try { await docker.getContainer('script-manager').stop(); } catch (_) {}
      try { await docker.getContainer('script-manager').remove({ force: true }); } catch (_) {}
      try { await docker.getContainer('script-manager-old').rename({ name: 'script-manager' }); } catch (_) {}
      throw new Error('New container failed health check. Rolled back to previous version — no downtime.');
    }

    appendLog('Container running. Waiting for Express to be ready…');

    // Phase 2 — HTTP readiness check: poll /healthz until Express responds (up to 30 s).
    // "manager" resolves to the NEW container once selfCtr was renamed to script-manager-old.
    let httpReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await fetch('http://manager:3000/healthz');
        if (r.ok) { httpReady = true; break; }
      } catch (_) {}
    }
    appendLog(httpReady ? 'Express is ready.' : 'Warning: Express did not respond in time — proceeding anyway.');

    // Reload nginx BEFORE stopping the old container so it picks up the new
    // container IP without any gap. Without this, nginx keeps the old IP cached
    // from its upstream block and returns 502 until the next nginx restart.
    appendLog('Reloading nginx…');
    try {
      const nginxExec = await docker.getContainer('script-nginx').exec({
        Cmd: ['nginx', '-s', 'reload'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const nStream = await nginxExec.start({ hijack: false, stdin: false } as any);
      await new Promise<void>(r => { nStream.resume(); nStream.on('end', r); nStream.on('error', () => r()); });
      appendLog('nginx reloaded.');
    } catch (e: any) {
      appendLog(`nginx reload skipped: ${e.message}`);
    }

    appendLog('Shutting down old container…');
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
  // File-based values are written into the image at build time and are immune
  // to env copying during container recreation. Fall back to env for dev.
  let commit    = 'dev';
  let buildTime: string | null = null;
  try { commit    = fs.readFileSync('/app/COMMIT_SHA', 'utf8').trim() || 'dev'; } catch { commit    = process.env.GIT_COMMIT || 'dev'; }
  try { buildTime = fs.readFileSync('/app/BUILD_TIME_FILE', 'utf8').trim() || null; } catch { buildTime = process.env.BUILD_TIME || null; }
  res.json({ commit, buildTime, repoSlug });
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

// ── Addons ────────────────────────────────────────────────────────────────────

interface AddonDef {
  id:          string;
  name:        string;
  description: string;
  container:   string;
  checkCmd:    string[];
  checkFn:     (output: string) => boolean;
  installCmd:  string[];
  removeCmd:   string[];
}

const ADDONS: AddonDef[] = [
  {
    id:          'ollama-llama3',
    name:        'Ollama – llama3 model',
    description: 'One-time step after Dock Tools starts: pull the Ollama model by running docker exec ollama ollama pull llama3 once.',
    container:   'ollama',
    checkCmd:    ['ollama', 'list'],
    checkFn:     (out) => /llama3/i.test(out),
    installCmd:  ['ollama', 'pull', 'llama3'],
    removeCmd:   ['ollama', 'rm', 'llama3'],
  },
];

type AddonOpStatus = 'idle' | 'installing' | 'removing' | 'done' | 'error';

interface AddonOpState {
  status: AddonOpStatus;
  log:    string;
  error?: string;
}

const addonOpStates = new Map<string, AddonOpState>(
  ADDONS.map(a => [a.id, { status: 'idle', log: '' }])
);

function spawnCollect(cmd: string, args: string[]): Promise<{ output: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code: number | null) => resolve({ output, code: code ?? 1 }));
    proc.on('error', (err: Error) => resolve({ output: err.message, code: 1 }));
  });
}

async function checkAddonInstalled(def: AddonDef): Promise<{ containerFound: boolean; installed: boolean }> {
  const { code } = await spawnCollect('docker', ['inspect', '--format={{.Name}}', def.container]);
  if (code !== 0) return { containerFound: false, installed: false };
  const { output, code: listCode } = await spawnCollect('docker', ['exec', def.container, ...def.checkCmd]);
  return { containerFound: true, installed: listCode === 0 && def.checkFn(output) };
}

function runAddonOp(id: string, op: 'install' | 'remove'): void {
  const def   = ADDONS.find(a => a.id === id);
  const state = addonOpStates.get(id);
  if (!def || !state) return;

  state.log   = '';
  delete state.error;

  const cmd  = op === 'install' ? def.installCmd : def.removeCmd;
  const proc = spawn('docker', ['exec', def.container, ...cmd]);

  proc.stdout.on('data', (d: Buffer) => { state.log += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { state.log += d.toString(); });
  proc.on('close', (code: number | null) => {
    if (code === 0) {
      state.status = 'done';
    } else {
      state.status = 'error';
      state.error  = `Process exited with code ${code}`;
    }
  });
  proc.on('error', (err: Error) => {
    state.status = 'error';
    state.error  = err.message;
    state.log   += '\n' + err.message;
  });
}

// GET /api/admin/addons
router.get('/addons', async (_req, res) => {
  const results = await Promise.all(ADDONS.map(async (def) => {
    const opState = addonOpStates.get(def.id)!;
    const isBusy  = opState.status === 'installing' || opState.status === 'removing';
    let containerFound = false;
    let installed      = false;
    if (!isBusy) {
      ({ containerFound, installed } = await checkAddonInstalled(def));
    } else {
      containerFound = true;
    }
    return {
      id:             def.id,
      name:           def.name,
      description:    def.description,
      containerFound,
      installed,
      opStatus:       opState.status,
      log:            opState.log,
      error:          opState.error,
    };
  }));
  res.json(results);
});

// GET /api/admin/addons/:id/status
router.get('/addons/:id/status', (req, res) => {
  const state = addonOpStates.get(req.params.id);
  if (!state) return res.status(404).json({ error: 'Unknown addon' });
  res.json(state);
});

// POST /api/admin/addons/:id/install
router.post('/addons/:id/install', (req, res) => {
  const { id }  = req.params;
  const def     = ADDONS.find(a => a.id === id);
  const state   = addonOpStates.get(id);
  if (!def || !state) return res.status(404).json({ error: 'Unknown addon' });
  if (state.status === 'installing' || state.status === 'removing')
    return res.status(409).json({ error: 'Operation already in progress' });
  state.status = 'installing';
  res.json({ message: 'Install started' });
  setImmediate(() => runAddonOp(id, 'install'));
});

// POST /api/admin/addons/:id/remove
router.post('/addons/:id/remove', (req, res) => {
  const { id }  = req.params;
  const def     = ADDONS.find(a => a.id === id);
  const state   = addonOpStates.get(id);
  if (!def || !state) return res.status(404).json({ error: 'Unknown addon' });
  if (state.status === 'installing' || state.status === 'removing')
    return res.status(409).json({ error: 'Operation already in progress' });
  state.status = 'removing';
  res.json({ message: 'Remove started' });
  setImmediate(() => runAddonOp(id, 'remove'));
});

export default router;
