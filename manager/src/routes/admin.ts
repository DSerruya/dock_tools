import { Router } from 'express';
import { spawn } from 'child_process';
import * as fs     from 'fs';
import * as os     from 'os';
import * as path   from 'path';
import Dockerode   from 'dockerode';
import multer      from 'multer';
import simpleGit   from 'simple-git';
import * as userService  from '../services/userService';
import * as auditService from '../services/auditService';
import { requireRole }   from '../middleware/auth';
import { getUser }       from '../utils/getUser';

const router = Router();

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')              // CSI sequences
    .replace(/\x1b[@-Z\\-_]/g, '')                        // other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');  // stray control chars
}

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

// Locate own container: Docker sets hostname = short container ID, so try that first,
// then fall back to the well-known compose name in case the hostname was overridden.
async function getSelfContainer(): Promise<{ container: Dockerode.Container; info: Dockerode.ContainerInspectInfo }> {
  const hostname = os.hostname();
  try {
    const ctr  = docker.getContainer(hostname);
    const info = await ctr.inspect();
    return { container: ctr, info };
  } catch (_) {}

  const ctr  = docker.getContainer('script-manager');
  const info = await ctr.inspect();
  return { container: ctr, info };
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

    const { container: selfCtr, info: selfInfo } = await getSelfContainer();
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
  group?:      string;
  container:   string;
  checkCmd:    string[];
  checkFn:     (output: string) => boolean;
  installCmd:  string[];
  removeCmd:   string[];
}

function ollamaAddon(tag: string, label: string, description: string, group: string): AddonDef {
  const id = 'ollama-' + tag.replace(/[:.]/g, '-').replace(/-+/g, '-').replace(/-$/, '');
  return {
    id,
    name:        `Ollama – ${label}`,
    description,
    group,
    container:   'ollama',
    checkCmd:    ['ollama', 'list'],
    checkFn:     (out) => out.toLowerCase().includes(tag.toLowerCase()),
    installCmd:  ['ollama', 'pull', tag],
    removeCmd:   ['ollama', 'rm',   tag],
  };
}

const ADDONS: AddonDef[] = [
  // ── Low Memory – Under 10 GB RAM ──────────────────────────────────────────
  ollamaAddon('llama3.2:3b',        'Llama 3.2 (3B)',           "Meta's ultra-lightweight general assistant. Best for speed and low-power devices. ~2 GB RAM.",    'Low Memory – Under 10 GB'),
  ollamaAddon('qwen2.5:1.5b',       'Qwen 2.5 (1.5B)',          "Alibaba's tiny model with exceptional multilingual performance. ~1 GB RAM.",                      'Low Memory – Under 10 GB'),
  ollamaAddon('gemma2:2b',          'Gemma 2 (2B)',              "Google's highly efficient small model with high knowledge density. ~1.5 GB RAM.",                  'Low Memory – Under 10 GB'),
  ollamaAddon('phi3.5',             'Phi-3.5 (3.8B)',            "Microsoft's strong reasoning model trained on textbook-quality data. ~3 GB RAM.",                  'Low Memory – Under 10 GB'),
  ollamaAddon('deepseek-r1:1.5b',   'DeepSeek-R1 (1.5B)',       'Smallest reasoning model for basic logic tasks. ~1 GB RAM.',                                       'Low Memory – Under 10 GB'),
  ollamaAddon('qwen2.5-coder:1.5b', 'Qwen 2.5-Coder (1.5B)',    'Tiny autocomplete and basic coding assistant. ~1 GB RAM.',                                         'Low Memory – Under 10 GB'),
  ollamaAddon('llama3.2-vision:11b','Llama 3.2-Vision (11B)',    'Multimodal image + text model, quantized for lower memory. ~8 GB RAM.',                           'Low Memory – Under 10 GB'),
  ollamaAddon('smollm2:1.7b',       'SmolLM2 (1.7B)',            'Ultra-fast model optimized for local on-device agents. ~1 GB RAM.',                               'Low Memory – Under 10 GB'),
  ollamaAddon('stablelm2:1.6b',     'StableLM 2 (1.6B)',         "Stability AI's lightweight text model for fast drafting. ~1 GB RAM.",                             'Low Memory – Under 10 GB'),
  ollamaAddon('nemotron-mini',      'Nemotron Mini (4B)',         "NVIDIA's small model tuned for roleplay and structured dialogue. ~3 GB RAM.",                     'Low Memory – Under 10 GB'),
  // ── Medium Memory – 10–50 GB RAM ─────────────────────────────────────────
  ollamaAddon('llama3.1:8b',        'Llama 3.1 (8B)',            "Meta's reliable baseline for general knowledge and tool use. ~5 GB RAM.",                         'Medium Memory – 10–50 GB'),
  ollamaAddon('gemma2:9b',          'Gemma 2 (9B)',              "Google's mid-size model punching above its weight in benchmarks. ~6 GB RAM.",                      'Medium Memory – 10–50 GB'),
  ollamaAddon('mistral:7b',         'Mistral (7B)',               'Classic, highly versatile model for instruction following. ~4 GB RAM.',                           'Medium Memory – 10–50 GB'),
  ollamaAddon('qwen2.5-coder:32b',  'Qwen 2.5-Coder (32B)',     'State-of-the-art local coding assistant. ~20 GB RAM.',                                             'Medium Memory – 10–50 GB'),
  ollamaAddon('deepseek-r1:32b',    'DeepSeek-R1 (32B)',         'Distilled reasoning model for deep math and logic. ~20 GB RAM.',                                  'Medium Memory – 10–50 GB'),
  ollamaAddon('phi3:medium',        'Phi-3 Medium (14B)',         "Microsoft's highly capable mid-sized model. ~9 GB RAM.",                                          'Medium Memory – 10–50 GB'),
  ollamaAddon('hermes3:8b',         'Hermes 3 (8B)',              'Fine-tuned Llama 3.1 optimized for agentic workflows. ~5 GB RAM.',                                'Medium Memory – 10–50 GB'),
  ollamaAddon('command-r:35b',      'Command-R (35B)',            "Cohere's enterprise model built specifically for RAG tasks. ~22 GB RAM.",                         'Medium Memory – 10–50 GB'),
  ollamaAddon('yi:34b',             'Yi-1.5 (34B)',               'Excellent bilingual English/Chinese model with long context. ~20 GB RAM.',                       'Medium Memory – 10–50 GB'),
  ollamaAddon('solar:10.7b',        'Solar (10.7B)',               'Compact model using depth-up-scaling for speed and quality. ~6 GB RAM.',                         'Medium Memory – 10–50 GB'),
  // ── High Memory – 50–256 GB RAM ──────────────────────────────────────────
  ollamaAddon('llama3.1:70b',       'Llama 3.1 (70B)',           'High-tier reasoning, great for structured data extraction. ~40 GB RAM.',                          'High Memory – 50–256 GB'),
  ollamaAddon('qwen2.5:72b',        'Qwen 2.5 (72B)',            'Top-performing open-weights model matching proprietary clouds. ~45 GB RAM.',                      'High Memory – 50–256 GB'),
  ollamaAddon('deepseek-r1:70b',    'DeepSeek-R1 (70B)',         'Heavyweight reasoning for intense coding and logic problems. ~43 GB RAM.',                        'High Memory – 50–256 GB'),
  ollamaAddon('gemma2:27b',         'Gemma 2 (27B)',              "Google's large model offering near-lossless 70B-class performance. ~16 GB RAM.",                  'High Memory – 50–256 GB'),
  ollamaAddon('command-r-plus',     'Command-R+ (104B)',          "Cohere's massive multilingual model optimized for complex tool use. ~64 GB RAM.",                 'High Memory – 50–256 GB'),
  ollamaAddon('mixtral:8x22b',      'Mixtral 8x22B',             'High-speed Mixture-of-Experts model with broad knowledge base. ~141 GB RAM.',                    'High Memory – 50–256 GB'),
  ollamaAddon('llama3.3:70b',       'Llama 3.3 (70B)',           'Updated Llama iteration with sharper instruction following. ~43 GB RAM.',                         'High Memory – 50–256 GB'),
  ollamaAddon('wizardlm2:8x22b',    'WizardLM 2 (8x22B)',        'Microsoft fine-tune optimized for complex coding and logic. ~141 GB RAM.',                        'High Memory – 50–256 GB'),
  ollamaAddon('falcon:180b',        'Falcon (180B Q4)',           "TII's heavily quantized ultra-large model for deep textual analysis. ~100 GB RAM.",                'High Memory – 50–256 GB'),
  // ── GGUF Quantized ───────────────────────────────────────────────────────
  ollamaAddon('llama3.2:1b-instruct-q4_K_M',              'Llama 3.2 1B Q4_K_M',              'GGUF Q4_K_M quantized — smallest Llama variant, ideal for edge and fast autocomplete. ~0.7 GB RAM.',              'GGUF Quantized'),
  ollamaAddon('llama3.2:3b-instruct-q4_K_M',              'Llama 3.2 3B Q4_K_M',              'GGUF Q4_K_M quantized — great balance of speed and quality for everyday tasks. ~1.8 GB RAM.',                    'GGUF Quantized'),
  ollamaAddon('llama3.1:8b-instruct-q4_K_M',              'Llama 3.1 8B Q4_K_M',              'GGUF Q4_K_M quantized — highly popular 8B with minimal quality loss from full precision. ~4.7 GB RAM.',           'GGUF Quantized'),
  ollamaAddon('llama3.1:8b-instruct-q8_0',                'Llama 3.1 8B Q8_0',                'GGUF Q8_0 quantized — near-lossless 8-bit weights, highest fidelity for the 8B class. ~8.5 GB RAM.',              'GGUF Quantized'),
  ollamaAddon('mistral:7b-instruct-q4_K_M',               'Mistral 7B Q4_K_M',                'GGUF Q4_K_M quantized — fast and accurate instruction-following at low memory cost. ~4.1 GB RAM.',                'GGUF Quantized'),
  ollamaAddon('qwen2.5:7b-instruct-q4_K_M',               'Qwen 2.5 7B Q4_K_M',               "GGUF Q4_K_M quantized — Alibaba's strong multilingual model in a compact quantized form. ~4.7 GB RAM.",           'GGUF Quantized'),
  ollamaAddon('gemma2:9b-instruct-q4_K_M',                'Gemma 2 9B Q4_K_M',                "GGUF Q4_K_M quantized — Google's high-efficiency 9B model with low RAM footprint. ~5.5 GB RAM.",                  'GGUF Quantized'),
  ollamaAddon('qwen2.5-coder:7b-instruct-q4_K_M',         'Qwen 2.5-Coder 7B Q4_K_M',         'GGUF Q4_K_M quantized — strong code completion and explanation model, lean on memory. ~4.7 GB RAM.',              'GGUF Quantized'),
  ollamaAddon('deepseek-coder-v2:16b-lite-instruct-q4_K_M','DeepSeek Coder V2 16B Q4_K_M',    'GGUF Q4_K_M quantized — 16B coding specialist with MoE architecture, low active params. ~9.7 GB RAM.',           'GGUF Quantized'),
  ollamaAddon('llama3.1:70b-instruct-q4_K_M',             'Llama 3.1 70B Q4_K_M',             'GGUF Q4_K_M quantized — 70B flagship compressed to fit in ~40 GB, best quality-per-GB at this tier. ~42 GB RAM.', 'GGUF Quantized'),
  // ── Other ─────────────────────────────────────────────────────────────────
  {
    id:          'docker-health-check',
    name:        'Docker Health Check',
    description: 'Schedules a cron job every 30 minutes to check if the compose stack is running and restart it automatically if any service is down.',
    container:   'health-checker',
    checkCmd:    ['crontab', '-l'],
    checkFn:     (out) => out.includes('docker compose'),
    installCmd:  ['sh', '-c', 'echo "*/30 * * * * cd /project && docker compose up -d >> /var/log/healthcheck.log 2>&1" | crontab -'],
    removeCmd:   ['crontab', '-r'],
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

async function dockerExecCollect(containerName: string, cmd: string[]): Promise<string> {
  const exec = await docker.getContainer(containerName).exec({
    Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise<string>((resolve, reject) => {
    let out = '';
    stream.on('data',  (d: Buffer) => { out += d.toString(); });
    stream.on('end',   () => resolve(out));
    stream.on('error', reject);
  });
}

async function checkAddonInstalled(def: AddonDef): Promise<{ containerFound: boolean; installed: boolean }> {
  let info: any;
  try {
    info = await docker.getContainer(def.container).inspect();
  } catch {
    return { containerFound: false, installed: false };
  }
  if (!info.State.Running) return { containerFound: false, installed: false };
  try {
    const out = await dockerExecCollect(def.container, def.checkCmd);
    return { containerFound: true, installed: def.checkFn(out) };
  } catch {
    return { containerFound: true, installed: false };
  }
}

async function runAddonOp(id: string, op: 'install' | 'remove'): Promise<void> {
  const def   = ADDONS.find(a => a.id === id);
  const state = addonOpStates.get(id);
  if (!def || !state) return;

  state.log   = '';
  delete state.error;

  const cmd = op === 'install' ? def.installCmd : def.removeCmd;
  try {
    const containerInfo = await docker.getContainer(def.container).inspect().catch(() => null);
    if (!containerInfo) {
      state.status = 'error';
      state.error  = `Container "${def.container}" not found — is the stack running?`;
      return;
    }
    if (!containerInfo.State.Running) {
      state.status = 'error';
      state.error  = `Container "${def.container}" is not running — start it first.`;
      return;
    }
    const exec = await docker.getContainer(def.container).exec({
      Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => {
      stream.on('data',  (d: Buffer) => { state.log += stripAnsi(d.toString()); });
      stream.on('end',   async () => {
        try {
          const info = await exec.inspect();
          const code = (info as any).ExitCode ?? 0;
          state.status = code === 0 ? 'done' : 'error';
          if (code !== 0) state.error = `Exit code ${code}`;
        } catch { state.status = 'done'; }
        resolve();
      });
      stream.on('error', (err: Error) => {
        state.status = 'error';
        state.error  = err.message;
        reject(err);
      });
    });
  } catch (err: any) {
    state.status = 'error';
    state.error  = err.message;
    state.log   += '\n' + err.message;
  }
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
      group:          def.group,
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

// ── Ollama CPU diagnostics ────────────────────────────────────────────────────

// Shared helper: stop, remove and recreate the ollama container.
// envOverrides: keys to set (value) or clear (null).
// newImage: optional image tag override.
// hostConfigOverrides: merged on top of the existing HostConfig (e.g. { Memory: bytes }).
async function recreateOllama(
  envOverrides: Record<string, string | null>,
  newImage?: string,
  hostConfigOverrides?: Record<string, any>,
): Promise<void> {
  const container = docker.getContainer('ollama');
  const info = await container.inspect();

  let env: string[] = info.Config.Env || [];
  for (const [key, val] of Object.entries(envOverrides)) {
    env = env.filter((e: string) => !e.startsWith(`${key}=`));
    if (val !== null) env.push(`${key}=${val}`);
  }

  if (info.State.Running) await container.stop({ t: 15 });
  await container.remove();

  const newContainer = await docker.createContainer({
    name:    'ollama',
    Image:   newImage || info.Config.Image,
    Env:     env,
    HostConfig:       { ...info.HostConfig, ...(hostConfigOverrides || {}) },
    NetworkingConfig: { EndpointsConfig: info.NetworkSettings.Networks },
  });
  await newContainer.start();
}

function parseMemoryBytes(mem: string): number {
  const m = mem.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(g|m|k)?b?$/);
  if (!m) throw new Error(`Invalid memory value: "${mem}". Use formats like 8g, 512m, 0 (unlimited).`);
  const multipliers: Record<string, number> = { g: 1024 ** 3, m: 1024 ** 2, k: 1024, '': 1 };
  return Math.floor(parseFloat(m[1]) * (multipliers[m[2] || ''] ?? 1));
}

// GET /api/admin/ollama/cpu-check
router.get('/ollama/cpu-check', async (_req, res) => {
  try {
    await docker.getContainer('ollama').inspect();
  } catch {
    return res.json({ containerFound: false, flags: [], hasAmx: false, noAmxSet: false, noGgmlAmxSet: false });
  }

  try {
    const raw = await dockerExecCollect('ollama', [
      'sh', '-c',
      "grep -oE 'amx[^ ]+|avx[^ ]+' /proc/cpuinfo 2>/dev/null | sort -u || echo ''"
    ]);
    const flags = raw.trim().split('\n').map((f: string) => f.trim()).filter(Boolean);
    const hasAmx = flags.some((f: string) => f.startsWith('amx'));

    const info = await docker.getContainer('ollama').inspect();
    const env: string[] = info.Config.Env || [];
    const noAmxSet      = env.some((e: string) => e === 'OLLAMA_NO_AMX=1');
    const noGgmlAmxSet  = env.some((e: string) => e === 'GGML_NO_AMX=1');
    const avx2OnlySet   = env.some((e: string) => e === 'OLLAMA_CPU_FEATURES=avx2');
    const avx2RunnerSet = env.some((e: string) => e === 'OLLAMA_LLM_LIBRARY=cpu_avx2');
    const memoryBytes   = (info.HostConfig as any).Memory ?? 0; // 0 = unlimited

    res.json({ containerFound: true, flags, hasAmx, noAmxSet, noGgmlAmxSet, avx2OnlySet, avx2RunnerSet, memoryBytes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ollama/restart-no-amx
// Fix for CPUs that don't fully support AMX instructions.
router.post('/ollama/restart-no-amx', async (_req, res) => {
  try {
    await recreateOllama({ OLLAMA_NO_AMX: '1' });
    res.json({ message: 'Ollama restarted with OLLAMA_NO_AMX=1' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ollama/restart-no-ggml-amx
// Fix for CPUs that support AMX but hit Ollama's GGML AMX initialization bug.
router.post('/ollama/restart-no-ggml-amx', async (_req, res) => {
  try {
    await recreateOllama({ GGML_NO_AMX: '1' });
    res.json({ message: 'Ollama restarted with GGML_NO_AMX=1' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ollama/restart-no-both-amx
// Sets both OLLAMA_NO_AMX=1 and GGML_NO_AMX=1 — covers both server-init and inference-level AMX issues.
router.post('/ollama/restart-no-both-amx', async (_req, res) => {
  try {
    await recreateOllama({ OLLAMA_NO_AMX: '1', GGML_NO_AMX: '1' });
    res.json({ message: 'Ollama restarted with OLLAMA_NO_AMX=1 and GGML_NO_AMX=1' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ollama/restart-avx2-only
// Caps Ollama at AVX2 instruction set, preventing it from using AMX or AVX-512.
router.post('/ollama/restart-avx2-only', async (_req, res) => {
  try {
    await recreateOllama({ OLLAMA_CPU_FEATURES: 'avx2' });
    res.json({ message: 'Ollama restarted with OLLAMA_CPU_FEATURES=avx2' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ollama/restart-avx2-runner
// Forces Ollama to use the AVX2 CPU runner instead of auto-detecting AMX.
router.post('/ollama/restart-avx2-runner', async (_req, res) => {
  try {
    await recreateOllama({ OLLAMA_LLM_LIBRARY: 'cpu_avx2' });
    res.json({ message: 'Ollama restarted with OLLAMA_LLM_LIBRARY=cpu_avx2' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/ollama/set-memory  body: { memory: "16g" | "0" }
// Recreates the Ollama container with a hard memory limit (0 = unlimited).
router.post('/ollama/set-memory', async (req, res) => {
  const raw = (req.body?.memory ?? '0').toString();
  try {
    const bytes = parseMemoryBytes(raw);
    await recreateOllama({}, undefined, { Memory: bytes });
    const label = bytes === 0 ? 'unlimited' : raw;
    res.json({ message: `Ollama restarted with memory limit: ${label}` });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Ollama compose-version pin ────────────────────────────────────────────────

const COMPOSE_FILE = '/app/docker-compose.yml';

function readOllamaImageFromCompose(): string | null {
  try {
    const m = fs.readFileSync(COMPOSE_FILE, 'utf8').match(/image:\s*(ollama\/ollama:\S+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function writeOllamaImageToCompose(version: string): void {
  const content = fs.readFileSync(COMPOSE_FILE, 'utf8');
  const updated = content.replace(/^(\s+image:\s*ollama\/ollama:)\S+/m, `$1${version}`);
  if (updated === content) throw new Error('Pattern not found in docker-compose.yml — nothing changed.');
  fs.writeFileSync(COMPOSE_FILE, updated, 'utf8');
}

// GET /api/admin/ollama/compose-version
router.get('/ollama/compose-version', async (_req, res) => {
  const composeImage  = readOllamaImageFromCompose();
  const info          = await docker.getContainer('ollama').inspect().catch(() => null);
  const runningImage  = info?.Config?.Image || null;
  res.json({ composeImage, runningImage, composeAccessible: composeImage !== null });
});

// POST /api/admin/ollama/compose-version  body: { version, apply }
router.post('/ollama/compose-version', async (req, res) => {
  const { version, apply } = req.body;
  if (!version || typeof version !== 'string')
    return res.status(400).json({ error: 'version is required' });
  if (!/^[\w.\-]+$/.test(version))
    return res.status(400).json({ error: 'Invalid version string' });

  const imageTag = `ollama/ollama:${version}`;
  try { writeOllamaImageToCompose(version); }
  catch (err: any) { return res.status(500).json({ error: err.message }); }

  if (!apply) return res.json({ message: `docker-compose.yml pinned to ${imageTag}` });

  try {
    await new Promise<void>((resolve, reject) => {
      docker.pull(imageTag, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e: Error | null) => e ? reject(e) : resolve());
      });
    });
    await recreateOllama({}, imageTag);
    res.json({ message: `Pinned to ${imageTag} and container recreated` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ollama Version Tester ─────────────────────────────────────────────────────

const OLLAMA_TEST_VERSIONS = [
  '0.30.10','0.30.0','0.29.0','0.28.0','0.27.0','0.26.0','0.25.0','0.24.0','0.23.0','0.22.0',
  '0.21.0','0.20.0','0.19.0','0.18.0','0.17.0','0.16.0','0.15.0','0.14.0','0.13.0','0.12.0',
  '0.11.0','0.10.0','0.9.0','0.8.0','0.7.0','0.6.0',
];
const OLLAMA_TEST_MODELS    = ['gemma3:4b','gemma3:12b','llama3.2:1b','llama3'];
const OLLAMA_TEST_CONTAINER = 'ollama-version-test';
const OLLAMA_TEST_VOLUME    = 'ollama-version-test-cache';

type VTStatus = 'pending'|'pulling_image'|'starting'|'pulling_model'|'running'|'ok'|'too_old'|'segfault'|'skip'|'error';
interface VTResult { version: string; status: VTStatus; message?: string; }
interface VTState  { running: boolean; model: string; results: VTResult[]; log: string; aborted: boolean; }

let vtState: VTState = { running: false, model: '', results: [], log: '', aborted: false };

async function execOnContainer(
  container: Dockerode.Container,
  cmd: string[],
  timeoutMs: number,
): Promise<{ output: string; exitCode: number }> {
  const dockerExec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
  const stream = await dockerExec.start({ hijack: true, stdin: false });
  return new Promise(resolve => {
    let output = '', settled = false;
    const done = async () => {
      if (settled) return; settled = true;
      try { const i = await dockerExec.inspect(); resolve({ output, exitCode: (i as any).ExitCode ?? 0 }); }
      catch { resolve({ output, exitCode: 0 }); }
    };
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ output, exitCode: -1 }); } }, timeoutMs);
    stream.on('data',  (d: Buffer) => { output += d.toString(); });
    stream.on('end',   () => { clearTimeout(timer); done(); });
    stream.on('error', () => { clearTimeout(timer); done(); });
  });
}

async function runVersionTest(versions: string[], model: string): Promise<void> {
  vtState = { running: true, model, aborted: false, log: '', results: versions.map(v => ({ version: v, status: 'pending' })) };
  const set = (v: string, s: VTStatus, msg?: string) => {
    const r = vtState.results.find(r => r.version === v);
    if (r) { r.status = s; r.message = msg; }
  };
  const cleanupCtr = async () => {
    try {
      const c = docker.getContainer(OLLAMA_TEST_CONTAINER);
      const i = await c.inspect().catch(() => null);
      if (i) { if (i.State.Running) await c.stop({ t: 5 }).catch(() => {}); await c.remove({ force: true }).catch(() => {}); }
    } catch {}
  };
  try {
    for (const version of versions) {
      if (vtState.aborted) break;
      vtState.log += `\n── Testing ${version} ──\n`;
      set(version, 'pulling_image');

      try {
        await new Promise<void>((res, rej) => {
          docker.pull(`ollama/ollama:${version}`, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) return rej(err);
            docker.modem.followProgress(stream, (e: Error | null) => e ? rej(e) : res());
          });
        });
        vtState.log += `  Pulled ollama/ollama:${version}\n`;
      } catch (err: any) {
        const msg = err.message || '';
        if (/not found|404|manifest unknown/i.test(msg)) {
          set(version, 'skip', 'Image not on Docker Hub'); continue;
        }
        set(version, 'error', `Image pull failed: ${msg.slice(0, 80)}`); continue;
      }

      if (vtState.aborted) break;
      await cleanupCtr();

      set(version, 'starting');
      let ctr: Dockerode.Container;
      try {
        ctr = await docker.createContainer({
          name: OLLAMA_TEST_CONTAINER, Image: `ollama/ollama:${version}`,
          HostConfig: { SecurityOpt: ['seccomp=unconfined'], Binds: [`${OLLAMA_TEST_VOLUME}:/root/.ollama`] },
        });
        await ctr.start();
      } catch (err: any) {
        set(version, 'error', `Start failed: ${err.message}`); continue;
      }

      let ready = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try { await execOnContainer(ctr, ['ollama', 'list'], 3000); ready = true; break; } catch {}
      }
      if (!ready) { set(version, 'error', 'Container not ready'); await cleanupCtr(); continue; }
      if (vtState.aborted) { await cleanupCtr(); break; }

      set(version, 'pulling_model');
      vtState.log += `  Pulling ${model}...\n`;
      const { output: pullOut } = await execOnContainer(ctr, ['ollama', 'pull', model], 600_000);
      if (/412|newer version of Ollama/i.test(pullOut)) {
        set(version, 'too_old', '412 — model requires a newer Ollama'); await cleanupCtr(); continue;
      }
      if (/^Error/im.test(pullOut) && !/success|pulling manifest|already/i.test(pullOut)) {
        set(version, 'error', pullOut.trim().slice(0, 100)); await cleanupCtr(); continue;
      }
      if (vtState.aborted) { await cleanupCtr(); break; }

      set(version, 'running');
      vtState.log += `  Running model...\n`;
      const { output: runOut, exitCode } = await execOnContainer(ctr, ['ollama', 'run', model, 'say hello'], 120_000);
      if (/segmentation fault|signal: segmentation|core dumped|500 Internal/i.test(runOut)) {
        vtState.log += `  SEGFAULT\n`;
        set(version, 'segfault', 'Crashes on this kernel');
      } else if (exitCode === 0 && runOut.trim().length > 0 && !/^Error/i.test(runOut.trim())) {
        vtState.log += `  OK\n`;
        set(version, 'ok', runOut.trim().slice(0, 100));
      } else {
        set(version, 'error', runOut.trim().slice(0, 100) || `Exit ${exitCode}`);
      }
      await cleanupCtr();
    }
  } finally {
    await cleanupCtr();
    vtState.running = false;
    vtState.log += '\nDone.\n';
  }
}

// GET /api/admin/ollama/version-test/config
router.get('/ollama/version-test/config', (_req, res) => {
  res.json({ versions: OLLAMA_TEST_VERSIONS, models: OLLAMA_TEST_MODELS });
});

// GET /api/admin/ollama/version-test/status
router.get('/ollama/version-test/status', (_req, res) => res.json(vtState));

// POST /api/admin/ollama/version-test/run
router.post('/ollama/version-test/run', (req, res) => {
  if (vtState.running) return res.status(409).json({ error: 'Test already running' });
  const { versions, model } = req.body;
  if (!Array.isArray(versions) || !versions.length) return res.status(400).json({ error: 'versions required' });
  if (!model) return res.status(400).json({ error: 'model required' });
  res.json({ message: 'Test started' });
  setImmediate(() => runVersionTest(versions, model));
});

// POST /api/admin/ollama/version-test/stop
router.post('/ollama/version-test/stop', (_req, res) => {
  vtState.aborted = true;
  res.json({ message: 'Stop requested' });
});

// POST /api/admin/ollama/version-test/clean
router.post('/ollama/version-test/clean', async (_req, res) => {
  try {
    try { const c = docker.getContainer(OLLAMA_TEST_CONTAINER); await c.stop({ t: 3 }).catch(() => {}); await c.remove({ force: true }); } catch {}
    try { await (docker.getVolume(OLLAMA_TEST_VOLUME) as any).remove(); } catch {}
    const images = await docker.listImages({ filters: { reference: ['ollama/ollama'] } as any });
    const removed: string[] = [];
    for (const img of images) {
      for (const tag of img.RepoTags || []) {
        if (!/^ollama\/ollama:\d/.test(tag)) continue;
        try { await docker.getImage(img.Id).remove({ force: false }); removed.push(tag); } catch {}
      }
    }
    res.json({ message: `Cleaned up. Images removed: ${removed.join(', ') || 'none'}` });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/ollama/models
router.delete('/ollama/models', async (_req, res) => {
  try {
    const info = await docker.getContainer('ollama').inspect().catch(() => null);
    if (!info?.State.Running) return res.status(400).json({ error: 'Ollama container is not running' });
    const listOut = await dockerExecCollect('ollama', ['ollama', 'list']);
    const models  = listOut.trim().split('\n').slice(1).map((l: string) => l.trim().split(/\s+/)[0]).filter(Boolean);
    if (!models.length) return res.json({ message: 'No models to remove' });
    for (const m of models) await dockerExecCollect('ollama', ['ollama', 'rm', m]).catch(() => {});
    res.json({ message: `Removed ${models.length} model(s): ${models.join(', ')}` });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/ollama/update
// Pulls the latest ollama/ollama image and recreates the container with it.
router.post('/ollama/update', async (_req, res) => {
  try {
    await new Promise<void>((resolve, reject) => {
      docker.pull('ollama/ollama:latest', (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e: Error | null) => e ? reject(e) : resolve());
      });
    });
    await recreateOllama({}, 'ollama/ollama:latest');
    res.json({ message: 'Ollama updated to latest and restarted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── System resources ──────────────────────────────────────────────────────────

// GET /api/admin/system/resources
router.get('/system/resources', async (_req, res) => {
  try {
    // Disk — read from inside the container (overlay maps to host disk)
    const dfOut = await new Promise<string>(resolve => {
      const proc = spawn('df', ['-B1', '/']);
      let out = '';
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', () => resolve(out));
      proc.on('error', () => resolve(''));
    });
    const dfParts  = (dfOut.trim().split('\n')[1] || '').split(/\s+/);
    const diskTotal = parseInt(dfParts[1]) || 0;
    const diskUsed  = parseInt(dfParts[2]) || 0;
    const diskFree  = parseInt(dfParts[3]) || 0;

    // Memory — from /proc/meminfo (reflects host totals on Linux)
    const memRaw  = fs.readFileSync('/proc/meminfo', 'utf8');
    const memKb   = (key: string) => parseInt((memRaw.match(new RegExp(`${key}:\\s+(\\d+)\\s+kB`)) || [])[1] || '0') * 1024;
    const memTotal     = memKb('MemTotal');
    const memAvailable = memKb('MemAvailable');
    const memUsed      = memTotal - memAvailable;

    // Per-container stats (memory + writable disk layer)
    const ctrs = await docker.listContainers();
    const containerStats = await Promise.all(ctrs.map(async c => {
      const name = (c.Names[0] || '').replace(/^\//, '');
      try {
        const stats: any = await new Promise((resolve, reject) =>
          (docker.getContainer(c.Id) as any).stats({ stream: false }, (err: any, data: any) =>
            err ? reject(err) : resolve(data)));
        const info: any = await (docker.getContainer(c.Id) as any).inspect({ size: true }).catch(() => null);
        // Match docker stats CLI: subtract page cache so RSS aligns with /proc/meminfo
        const memCache  = stats?.memory_stats?.stats?.inactive_file   // cgroups v2
                       ?? stats?.memory_stats?.stats?.cache           // cgroups v1
                       ?? 0;
        const memUsage  = Math.max(0, (stats?.memory_stats?.usage || 0) - memCache);
        const memLimit  = stats?.memory_stats?.limit || memTotal;
        const diskRw    = info?.SizeRw || 0;
        return { name, memUsage, memLimit, diskRw };
      } catch {
        return { name, memUsage: 0, memLimit: memTotal, diskRw: 0 };
      }
    }));

    res.json({
      disk:       { total: diskTotal, used: diskUsed, free: diskFree },
      memory:     { total: memTotal, used: memUsed, available: memAvailable },
      containers: containerStats,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ollama reset all env flags ────────────────────────────────────────────────

// POST /api/admin/ollama/reset-flags
// Removes all CPU-override env vars and recreates the container.
router.post('/ollama/reset-flags', async (_req, res) => {
  try {
    await recreateOllama({
      OLLAMA_NO_AMX:        null,
      GGML_NO_AMX:          null,
      OLLAMA_CPU_FEATURES:  null,
      OLLAMA_LLM_LIBRARY:   null,
      OLLAMA_FLASH_ATTENTION: null,
    });
    res.json({ message: 'All CPU flags removed and Ollama restarted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── OpenVPN connection test ───────────────────────────────────────────────────
//
// Lets an admin upload a standalone .ovpn profile (not tied to any script) and
// verify it actually works: spins up a throwaway container that connects, then
// proves data moves across the tunnel by reading tun0's kernel byte counters
// before/after a request instead of trusting the "connected" log line alone.

const ADMIN_DATA_DIR   = process.env.DATA_DIR || '/app/scripts-data';
const ADMIN_VPN_DIR    = path.join(ADMIN_DATA_DIR, 'admin-vpn');
const ADMIN_VPN_CONFIG = path.join(ADMIN_VPN_DIR, 'config.ovpn');
const ADMIN_VPN_UPLOAD = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

// Binds passed to docker.createContainer() are resolved by the daemon against the
// HOST filesystem, not this container's — mirrors dockerService.ts's HOST_SCRIPTS_DATA_PATH.
const ADMIN_VPN_HOST_CONFIG = path.join(
  process.env.HOST_SCRIPTS_DATA_PATH || '/app/scripts-data', 'admin-vpn', 'config.ovpn',
);

const ADMIN_VPN_IMAGE     = 'alpine:3.19';
const ADMIN_VPN_CONTAINER = 'admin-vpn-test';
const ADMIN_VPN_NETWORK   = process.env.DOCKER_NETWORK || 'bridge';

type AdminVpnStatus =
  | 'idle' | 'pulling_image' | 'starting' | 'connecting' | 'testing_data'
  | 'success' | 'partial' | 'failed';

interface AdminVpnResult {
  publicIp?: string;
  rxBytesDelta: number;
  txBytesDelta: number;
  fullTunnelRouting: boolean;
}

interface AdminVpnState {
  running: boolean;
  status:  AdminVpnStatus;
  log:     string;
  result?: AdminVpnResult;
  error?:  string;
  aborted: boolean;
}

let adminVpnState: AdminVpnState = { running: false, status: 'idle', log: '', aborted: false };

function adminVpnLog(line: string): void {
  adminVpnState.log += line + '\n';
}

async function cleanupAdminVpnContainer(): Promise<void> {
  try {
    const c    = docker.getContainer(ADMIN_VPN_CONTAINER);
    const info = await c.inspect().catch(() => null);
    if (info) {
      if (info.State.Running) await c.stop({ t: 5 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    }
  } catch { /* nothing to clean up */ }
}

async function pullDockerImage(image: string): Promise<void> {
  try { await docker.getImage(image).inspect(); return; } catch {}
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: Error | null) => e ? reject(e) : resolve());
    });
  });
}

function readTunByteCounters(output: string): { rx: number; tx: number } | null {
  const parts = output.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  return { rx: parts[0], tx: parts[1] };
}

async function runAdminVpnTest(): Promise<void> {
  adminVpnState = { running: true, status: 'starting', log: '', aborted: false };
  try {
    await cleanupAdminVpnContainer();

    adminVpnState.status = 'pulling_image';
    adminVpnLog(`Pulling ${ADMIN_VPN_IMAGE}...`);
    await pullDockerImage(ADMIN_VPN_IMAGE);

    adminVpnState.status = 'starting';
    adminVpnLog('Starting VPN test container...');
    const container = await docker.createContainer({
      name:  ADMIN_VPN_CONTAINER,
      Image: ADMIN_VPN_IMAGE,
      Tty:   true, // avoid stream demuxing when polling container.logs()
      Cmd:   ['sh', '-c', 'apk add --no-cache openvpn curl >/dev/null 2>&1; exec openvpn --config /vpn/config.ovpn'],
      HostConfig: {
        Binds:   [`${ADMIN_VPN_HOST_CONFIG}:/vpn/config.ovpn:ro`],
        CapAdd:  ['NET_ADMIN'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      },
      NetworkingConfig: {
        EndpointsConfig: { [ADMIN_VPN_NETWORK]: {} },
      },
    });
    await container.start();

    adminVpnState.status = 'connecting';
    adminVpnLog('Waiting for VPN handshake...');
    let connected = false;
    for (let i = 0; i < 30; i++) {
      if (adminVpnState.aborted) { adminVpnLog('Aborted.'); break; }
      await new Promise(r => setTimeout(r, 1000));
      const buf  = await container.logs({ stdout: true, stderr: true, tail: 100 }).catch(() => null) as unknown as Buffer | null;
      const text = buf ? buf.toString('utf8') : '';
      if (text.includes('Initialization Sequence Completed')) { connected = true; break; }
    }

    if (adminVpnState.aborted) {
      adminVpnState.status = 'failed';
      adminVpnState.error  = 'Test aborted';
      return;
    }

    if (!connected) {
      const buf = await container.logs({ stdout: true, stderr: true, tail: 40 }).catch(() => null) as unknown as Buffer | null;
      if (buf) adminVpnLog(buf.toString('utf8'));
      adminVpnState.status = 'failed';
      adminVpnState.error  = 'VPN did not connect within 30s — see log for details';
      return;
    }

    adminVpnLog('VPN connected (Initialization Sequence Completed).');
    adminVpnState.status = 'testing_data';

    const before = readTunByteCounters(await dockerExecCollect(ADMIN_VPN_CONTAINER, [
      'sh', '-c', 'cat /sys/class/net/tun0/statistics/rx_bytes /sys/class/net/tun0/statistics/tx_bytes 2>/dev/null || echo "0 0"',
    ])) || { rx: 0, tx: 0 };

    adminVpnLog('Requesting data over the tunnel interface (curl --interface tun0)...');
    const tunCurl = await dockerExecCollect(ADMIN_VPN_CONTAINER, [
      'sh', '-c', 'curl -s --interface tun0 --max-time 10 https://api.ipify.org || echo __CURL_FAILED__',
    ]);
    const fullTunnelRouting = /^\d+\.\d+\.\d+\.\d+$/.test(tunCurl.trim());
    let publicIp = fullTunnelRouting ? tunCurl.trim() : undefined;

    if (!fullTunnelRouting) {
      adminVpnLog('No full-internet route via tun0 (likely a split-tunnel VPN) — falling back to a general connectivity check.');
      const generalCurl = await dockerExecCollect(ADMIN_VPN_CONTAINER, [
        'sh', '-c', 'curl -s --max-time 10 https://api.ipify.org || echo __CURL_FAILED__',
      ]);
      if (/^\d+\.\d+\.\d+\.\d+$/.test(generalCurl.trim())) publicIp = generalCurl.trim();
    }

    const after = readTunByteCounters(await dockerExecCollect(ADMIN_VPN_CONTAINER, [
      'sh', '-c', 'cat /sys/class/net/tun0/statistics/rx_bytes /sys/class/net/tun0/statistics/tx_bytes 2>/dev/null || echo "0 0"',
    ])) || before;

    const rxBytesDelta = Math.max(0, after.rx - before.rx);
    const txBytesDelta = Math.max(0, after.tx - before.tx);
    adminVpnLog(`tun0 bytes transferred during test — rx: ${rxBytesDelta}, tx: ${txBytesDelta}`);

    if (fullTunnelRouting && (rxBytesDelta > 0 || txBytesDelta > 0)) {
      adminVpnState.status = 'success';
      adminVpnState.result = { publicIp, rxBytesDelta, txBytesDelta, fullTunnelRouting: true };
      adminVpnLog(`Success — traffic routed through the VPN, exit IP: ${publicIp}`);
    } else if (rxBytesDelta > 0 || txBytesDelta > 0 || publicIp) {
      adminVpnState.status = 'partial';
      adminVpnState.result = { publicIp, rxBytesDelta, txBytesDelta, fullTunnelRouting: false };
      adminVpnLog('Partial success — VPN connected but full internet routing through the tunnel could not be confirmed (likely a split-tunnel config).');
    } else {
      adminVpnState.status = 'failed';
      adminVpnState.error  = 'VPN connected but no data could be transferred through the tunnel';
    }
  } catch (err: any) {
    adminVpnState.status = 'failed';
    adminVpnState.error  = err.message;
    adminVpnLog(`Error: ${err.message}`);
  } finally {
    await cleanupAdminVpnContainer();
    adminVpnState.running = false;
  }
}

// GET /api/admin/vpn/config
router.get('/vpn/config', (_req, res) => {
  res.json({ configured: fs.existsSync(ADMIN_VPN_CONFIG) });
});

// POST /api/admin/vpn/config — upload a global .ovpn profile
router.post('/vpn/config', ADMIN_VPN_UPLOAD.single('ovpn'), (req, res) => {
  if (adminVpnState.running) return res.status(409).json({ error: 'A test is currently running' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.endsWith('.ovpn'))
    return res.status(400).json({ error: 'File must be a .ovpn file' });

  if (!fs.existsSync(ADMIN_VPN_DIR)) fs.mkdirSync(ADMIN_VPN_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_VPN_CONFIG, req.file.buffer);
  adminVpnState = { running: false, status: 'idle', log: '', aborted: false };
  res.json({ message: 'VPN config uploaded' });
});

// DELETE /api/admin/vpn/config
router.delete('/vpn/config', (_req, res) => {
  if (adminVpnState.running) return res.status(409).json({ error: 'A test is currently running' });
  if (fs.existsSync(ADMIN_VPN_CONFIG)) fs.unlinkSync(ADMIN_VPN_CONFIG);
  adminVpnState = { running: false, status: 'idle', log: '', aborted: false };
  res.json({ message: 'VPN config removed' });
});

// GET /api/admin/vpn/test/status
router.get('/vpn/test/status', (_req, res) => res.json(adminVpnState));

// POST /api/admin/vpn/test/run
router.post('/vpn/test/run', (_req, res) => {
  if (adminVpnState.running) return res.status(409).json({ error: 'Test already running' });
  if (!fs.existsSync(ADMIN_VPN_CONFIG)) return res.status(400).json({ error: 'Upload a .ovpn config first' });
  res.json({ message: 'Test started' });
  setImmediate(() => runAdminVpnTest());
});

// POST /api/admin/vpn/test/stop
router.post('/vpn/test/stop', (_req, res) => {
  adminVpnState.aborted = true;
  res.json({ message: 'Stop requested' });
});

// POST /api/admin/vpn/test/clean — force-remove a stuck test container
router.post('/vpn/test/clean', async (_req, res) => {
  try {
    await cleanupAdminVpnContainer();
    adminVpnState = { running: false, status: 'idle', log: '', aborted: false };
    res.json({ message: 'Cleaned up' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── SQL over VPN test ─────────────────────────────────────────────────────────
//
// Lets an admin upload a dedicated .ovpn profile (separate from the general
// connectivity one above), connect through it, and run a single ad-hoc query
// against a database on the other side — confirms firewall/reachability
// before wiring a script to a client's DB.

const SQLT_VPN_DIR    = path.join(ADMIN_DATA_DIR, 'sql-test-vpn');
const SQLT_VPN_CONFIG = path.join(SQLT_VPN_DIR, 'config.ovpn');
const SQLT_VPN_UPLOAD = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

const SQLT_VPN_HOST_CONFIG = path.join(
  process.env.HOST_SCRIPTS_DATA_PATH || '/app/scripts-data', 'sql-test-vpn', 'config.ovpn',
);

const SQLT_IMAGE     = 'alpine:3.19';
const SQLT_CONTAINER = 'admin-sqltest';
const SQLT_NETWORK   = process.env.DOCKER_NETWORK || 'bridge';
const SQLT_PACKAGES  = 'openvpn postgresql-client mariadb-client freetds';

type SqlEngine = 'postgres' | 'mysql' | 'mssql';

type SqlTestStatus =
  | 'idle' | 'pulling_image' | 'starting' | 'connecting_vpn' | 'checking_reachability'
  | 'connecting_db' | 'running_query' | 'success' | 'failed';

interface SqlTestState {
  running: boolean;
  status:  SqlTestStatus;
  log:     string;
  error?:  string;
  aborted: boolean;
}

let sqlTestState: SqlTestState = { running: false, status: 'idle', log: '', aborted: false };

function sqlTestLog(line: string): void {
  sqlTestState.log += line + '\n';
}

async function cleanupSqlTestContainer(): Promise<void> {
  try {
    const c    = docker.getContainer(SQLT_CONTAINER);
    const info = await c.inspect().catch(() => null);
    if (info) {
      if (info.State.Running) await c.stop({ t: 5 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    }
  } catch { /* nothing to clean up */ }
}

// Cmd is always passed straight to execve — never through `sh -c` — so
// connection fields and the query itself can't be reinterpreted as shell
// syntax. Secrets go through Env, not argv, to keep them out of `docker top`.
// Exit code can lag a moment behind the output stream closing, so poll
// briefly instead of trusting a single inspect() right after 'end'.
async function dockerExecRun(
  containerName: string,
  cmd: string[],
  opts: { env?: string[] } = {},
): Promise<{ out: string; exitCode: number | null }> {
  const exec = await docker.getContainer(containerName).exec({
    Cmd: cmd, Env: opts.env, Tty: true, AttachStdout: true, AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = await new Promise<string>((resolve, reject) => {
    let buf = '';
    stream.on('data',  (d: Buffer) => { buf += d.toString(); });
    stream.on('end',   () => resolve(buf));
    stream.on('error', reject);
  });
  let exitCode: number | null = null;
  for (let i = 0; i < 10; i++) {
    const info = await exec.inspect().catch(() => null);
    if (info && !info.Running) { exitCode = info.ExitCode; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  return { out, exitCode };
}

// Zero-I/O TCP connect scan — purely diagnostic, doesn't affect the actual
// DB connection attempt below. Lets an admin tell "VPN up, port unreachable"
// apart from "port reachable, DB/auth/query itself failed".
async function checkTcpReachable(host: string, port: string): Promise<boolean> {
  const { exitCode } = await dockerExecRun(SQLT_CONTAINER, ['nc', '-z', '-w', '5', host, port]);
  return exitCode === 0;
}

async function runSqlOverVpnTest(params: {
  engine: SqlEngine; host: string; port: string; database: string;
  username: string; password: string; query: string;
}): Promise<void> {
  sqlTestState = { running: true, status: 'starting', log: '', aborted: false };
  try {
    await cleanupSqlTestContainer();

    sqlTestState.status = 'pulling_image';
    sqlTestLog(`Pulling ${SQLT_IMAGE}...`);
    await pullDockerImage(SQLT_IMAGE);

    sqlTestState.status = 'starting';
    sqlTestLog('Starting VPN + SQL client container...');
    const container = await docker.createContainer({
      name:  SQLT_CONTAINER,
      Image: SQLT_IMAGE,
      Tty:   true, // avoid stream demuxing when polling container.logs()
      Cmd:   ['sh', '-c', `apk add --no-cache ${SQLT_PACKAGES} >/dev/null 2>&1; exec openvpn --config /vpn/config.ovpn`],
      HostConfig: {
        Binds:   [`${SQLT_VPN_HOST_CONFIG}:/vpn/config.ovpn:ro`],
        CapAdd:  ['NET_ADMIN'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      },
      NetworkingConfig: { EndpointsConfig: { [SQLT_NETWORK]: {} } },
    });
    await container.start();

    sqlTestState.status = 'connecting_vpn';
    sqlTestLog('Waiting for VPN handshake...');
    let connected = false;
    for (let i = 0; i < 30; i++) {
      if (sqlTestState.aborted) { sqlTestLog('Aborted.'); break; }
      await new Promise(r => setTimeout(r, 1000));
      const buf  = await container.logs({ stdout: true, stderr: true, tail: 100 }).catch(() => null) as unknown as Buffer | null;
      const text = buf ? buf.toString('utf8') : '';
      if (text.includes('Initialization Sequence Completed')) { connected = true; break; }
    }

    if (sqlTestState.aborted) {
      sqlTestState.status = 'failed';
      sqlTestState.error  = 'Test aborted';
      return;
    }
    if (!connected) {
      const buf = await container.logs({ stdout: true, stderr: true, tail: 40 }).catch(() => null) as unknown as Buffer | null;
      sqlTestLog('--- container log (VPN never signaled a completed handshake) ---');
      sqlTestLog(buf ? buf.toString('utf8').trim() : '(no container output captured)');
      sqlTestState.status = 'failed';
      sqlTestState.error  = 'VPN did not connect within 30s — see log for details';
      return;
    }
    sqlTestLog('✓ VPN connected (Initialization Sequence Completed).');

    const routes = await dockerExecRun(SQLT_CONTAINER, ['sh', '-c', 'ip route 2>&1']).catch(() => null);
    if (routes && routes.out.trim()) {
      sqlTestLog('--- routing table after VPN connect ---');
      sqlTestLog(routes.out.trim());
    }

    // The package install kicked off alongside the VPN handshake above —
    // give it a little more room if it hasn't landed yet.
    sqlTestLog('Waiting for SQL client tools to finish installing (psql, mysql, tsql, nc)...');
    let toolsReady = false;
    for (let i = 0; i < 20; i++) {
      if (sqlTestState.aborted) break;
      const check = await dockerExecRun(SQLT_CONTAINER, ['sh', '-c', 'which psql mysql tsql nc >/dev/null 2>&1 && echo ready']);
      if (check.out.includes('ready')) { toolsReady = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (sqlTestState.aborted) {
      sqlTestState.status = 'failed';
      sqlTestState.error  = 'Test aborted';
      return;
    }

    sqlTestLog(toolsReady
      ? '✓ SQL client tools ready.'
      : '⚠ SQL client tools not confirmed ready after 20s — continuing anyway, the run below may fail if a binary is missing.');

    const { engine, host, port, database, username, password, query } = params;

    sqlTestState.status = 'checking_reachability';
    sqlTestLog(`Testing TCP reachability to ${host}:${port} over the tunnel (5s timeout, diagnostic only)...`);
    const reachable = await checkTcpReachable(host, port).catch(() => false);
    sqlTestLog(reachable
      ? `✓ ${host}:${port} is reachable through the tunnel.`
      : `✗ Could not reach ${host}:${port} within 5s — likely a VPN route or firewall issue for this host/port. Continuing to attempt the DB connection anyway.`);

    if (sqlTestState.aborted) {
      sqlTestState.status = 'failed';
      sqlTestState.error  = 'Test aborted';
      return;
    }

    sqlTestState.status = 'connecting_db';
    sqlTestLog(`Connecting to ${engine} at ${host}:${port}/${database} as '${username}'...`);

    sqlTestState.status = 'running_query';
    let result: { out: string; exitCode: number | null };
    try {
      if (engine === 'postgres') {
        sqlTestLog('Running psql...');
        result = await dockerExecRun(SQLT_CONTAINER,
          ['psql', '-h', host, '-p', port, '-U', username, '-d', database, '-c', query],
          { env: [`PGPASSWORD=${password}`] });
      } else if (engine === 'mysql') {
        sqlTestLog('Running mysql client...');
        result = await dockerExecRun(SQLT_CONTAINER,
          ['mysql', '-h', host, '-P', port, '-u', username, '-D', database, '-e', query],
          { env: [`MYSQL_PWD=${password}`] });
      } else {
        sqlTestLog('Running tsql...');
        // freetds' tsql has no "-c" flag for a single query — it's fed as a
        // batch terminated by a bare "go" line, same convention as isql/osql.
        // That's piped inside the container's own shell (via env-var-quoted
        // values, never string-concatenated) so we don't need to attach
        // stdin over the exec's hijacked stream, which is flaky combined
        // with Tty and was the likely cause of runs silently returning no
        // output and no exit code.
        result = await dockerExecRun(SQLT_CONTAINER,
          ['sh', '-c', 'printf "%s\\ngo\\nquit\\n" "$SQLT_Q" | tsql -H "$SQLT_HOST" -p "$SQLT_PORT" -U "$SQLT_USER" -P "$SQLT_PASS" -D "$SQLT_DB"'],
          { env: [
            `SQLT_Q=${query}`, `SQLT_HOST=${host}`, `SQLT_PORT=${port}`,
            `SQLT_USER=${username}`, `SQLT_PASS=${password}`, `SQLT_DB=${database}`,
          ] });
      }
    } catch (err: any) {
      sqlTestLog(`Error launching the ${engine} client: ${err.message}`);
      result = { out: '', exitCode: null };
    }

    sqlTestLog('--- client output ---');
    sqlTestLog(result.out.trim() || '(client produced no output)');
    sqlTestLog('--- end output ---');
    sqlTestLog(`Exit code: ${result.exitCode === null ? 'unknown' : result.exitCode}`);

    if (sqlTestState.aborted) {
      sqlTestState.status = 'failed';
      sqlTestState.error  = 'Test aborted';
      return;
    }

    if (result.exitCode === 0) {
      sqlTestState.status = 'success';
      sqlTestLog('Query finished successfully.');
    } else if (result.exitCode === null) {
      sqlTestState.status = 'failed';
      sqlTestState.error  = 'The client process never reported an exit code — see the log above for whether the client tools were ready and whether the port was reachable.';
    } else {
      sqlTestState.status = 'failed';
      sqlTestState.error  = `Query failed (exit code ${result.exitCode}) — see the client output above for details.`;
    }
  } catch (err: any) {
    sqlTestState.status = 'failed';
    sqlTestState.error  = err.message;
    sqlTestLog(`Error: ${err.message}`);
  } finally {
    await cleanupSqlTestContainer();
    sqlTestState.running = false;
  }
}

// GET /api/admin/sql-test/vpn/config
router.get('/sql-test/vpn/config', (_req, res) => {
  res.json({ configured: fs.existsSync(SQLT_VPN_CONFIG) });
});

// POST /api/admin/sql-test/vpn/config — upload a dedicated .ovpn profile
router.post('/sql-test/vpn/config', SQLT_VPN_UPLOAD.single('ovpn'), (req, res) => {
  if (sqlTestState.running) return res.status(409).json({ error: 'A test is currently running' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.endsWith('.ovpn'))
    return res.status(400).json({ error: 'File must be a .ovpn file' });

  if (!fs.existsSync(SQLT_VPN_DIR)) fs.mkdirSync(SQLT_VPN_DIR, { recursive: true });
  fs.writeFileSync(SQLT_VPN_CONFIG, req.file.buffer);
  sqlTestState = { running: false, status: 'idle', log: '', aborted: false };
  res.json({ message: 'VPN config uploaded' });
});

// DELETE /api/admin/sql-test/vpn/config
router.delete('/sql-test/vpn/config', (_req, res) => {
  if (sqlTestState.running) return res.status(409).json({ error: 'A test is currently running' });
  if (fs.existsSync(SQLT_VPN_CONFIG)) fs.unlinkSync(SQLT_VPN_CONFIG);
  sqlTestState = { running: false, status: 'idle', log: '', aborted: false };
  res.json({ message: 'VPN config removed' });
});

// GET /api/admin/sql-test/status
router.get('/sql-test/status', (_req, res) => res.json(sqlTestState));

// POST /api/admin/sql-test/run
router.post('/sql-test/run', (req, res) => {
  if (sqlTestState.running) return res.status(409).json({ error: 'Test already running' });
  if (!fs.existsSync(SQLT_VPN_CONFIG)) return res.status(400).json({ error: 'Upload a .ovpn config first' });

  const { engine, host, port, database, username, password, query } = req.body || {};
  if (!['postgres', 'mysql', 'mssql'].includes(engine))
    return res.status(400).json({ error: 'Invalid engine' });
  if (!host || !port || !database || !username || !query)
    return res.status(400).json({ error: 'Host, port, database, username and query are required' });

  res.json({ message: 'Test started' });
  setImmediate(() => runSqlOverVpnTest({
    engine, host, port: String(port), database, username,
    password: password || '', query,
  }));
});

// POST /api/admin/sql-test/stop
router.post('/sql-test/stop', (_req, res) => {
  sqlTestState.aborted = true;
  res.json({ message: 'Stop requested' });
});

// POST /api/admin/sql-test/clean — force-remove a stuck test container
router.post('/sql-test/clean', async (_req, res) => {
  try {
    await cleanupSqlTestContainer();
    sqlTestState = { running: false, status: 'idle', log: '', aborted: false };
    res.json({ message: 'Cleaned up' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
