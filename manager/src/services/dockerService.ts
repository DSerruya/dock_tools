import Dockerode from 'dockerode';
import { PassThrough } from 'stream';
import { ScriptConfig, ContainerStatus } from '../types';
import * as logService from './logService';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const DOCKER_NETWORK         = process.env.DOCKER_NETWORK         || 'bridge';
const HOST_SCRIPTS_DATA_PATH = process.env.HOST_SCRIPTS_DATA_PATH  || '/app/scripts-data';
const VPN_IMAGE              = 'alpine:3.19';

const IMAGE_MAP: Record<string, string> = {
  python:     'python:3.12-slim',
  ruby:       'ruby:3.3.8-slim',
  node:       'node:20-slim',
  typescript: 'node:20-slim',
};

// Always run via sh -c so the entry point is treated as a full shell command.
// This allows flags and prefixes such as:
//   'ruby main.rb'           -> sh -c 'ruby main.rb'
//   'stdbuf -o0 ruby main.rb'-> sh -c 'stdbuf -o0 ruby main.rb'
//   'python -u main.py'      -> sh -c 'python -u main.py'
// Previously the language name was prepended as the executable, which caused
// 'ruby: No such file or directory -- stdbuf -o0 ruby main.rb' errors when
// the entry point contained flags or multiple tokens.
const CMD_MAP: Record<string, (entry: string) => string[]> = {
  python:     e => ['sh', '-c', e],
  ruby:       e => ['sh', '-c', e],
  node:       e => ['sh', '-c', e],
  typescript: e => ['sh', '-c', e],
};

function containerName(name: string): string    { return `script-${name}`; }
function vpnContainerName(name: string): string { return `script-vpn-${name}`; }
function hostRepoPath(name: string): string     { return `${HOST_SCRIPTS_DATA_PATH}/${name}/repo`; }
function hostVpnConfigPath(name: string): string { return `${HOST_SCRIPTS_DATA_PATH}/vpn/${name}.ovpn`; }

async function getContainer(name: string): Promise<Dockerode.Container | null> {
  try {
    const c = docker.getContainer(containerName(name));
    await c.inspect();
    return c;
  } catch { return null; }
}

export async function getStatus(name: string): Promise<ContainerStatus> {
  const c = await getContainer(name);
  if (!c) return 'stopped';
  const info = await c.inspect();
  if (info.State.Running) return 'running';
  if (info.State.ExitCode !== 0) return 'error';
  return 'stopped';
}

async function pullImage(image: string): Promise<void> {
  try { await docker.getImage(image).inspect(); return; } catch {}
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: Error | null) => e ? reject(e) : resolve());
    });
  });
}

async function removeIfExists(name: string): Promise<void> {
  const c = await getContainer(name);
  if (!c) return;
  try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 5 }); } catch {}
  await c.remove({ force: true });
}

function resolveCmd(config: ScriptConfig): string[] {
  if (config.buildCommand) {
    // Build phase + custom start command (entryPoint is the shell start command, e.g. "npm start")
    return ['sh', '-c', `${config.buildCommand} && ${config.entryPoint}`];
  }
  return (CMD_MAP[config.language] || CMD_MAP.node)(config.entryPoint);
}

// ── VPN sidecar management ────────────────────────────────────────────────────

async function startVpnSidecar(name: string): Promise<void> {
  const existing = docker.getContainer(vpnContainerName(name));
  try {
    const info = await existing.inspect();
    if (info.State.Running) await existing.stop({ t: 5 });
    await existing.remove({ force: true });
  } catch { /* didn't exist */ }

  await pullImage(VPN_IMAGE);

  const c = await docker.createContainer({
    name: vpnContainerName(name),
    Image: VPN_IMAGE,
    Cmd: ['sh', '-c', 'apk add --no-cache openvpn 2>/dev/null; exec openvpn --config /vpn/config.ovpn'],
    HostConfig: {
      Binds:   [`${hostVpnConfigPath(name)}:/vpn/config.ovpn:ro`],
      CapAdd:  ['NET_ADMIN'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [DOCKER_NETWORK]: { Aliases: [name, vpnContainerName(name)] },
      },
    },
  });
  await c.start();

  // Poll logs until connected (up to 30 s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const buf = await c.logs({ stdout: true, stderr: true, tail: 30 }) as unknown as Buffer;
      if (demuxLogs(buf).includes('Initialization Sequence Completed')) return;
    } catch { break; }
  }
}

async function stopVpnSidecar(name: string): Promise<void> {
  const c = docker.getContainer(vpnContainerName(name));
  try {
    const info = await c.inspect();
    if (info.State.Running) await c.stop({ t: 5 });
    await c.remove({ force: true });
  } catch { /* already gone */ }
}

// ── Script container ──────────────────────────────────────────────────────────

async function createContainer(config: ScriptConfig, restartPolicy: string): Promise<Dockerode.Container> {
  const image = IMAGE_MAP[config.language] || 'node:20-slim';
  const cmd   = resolveCmd(config);

  await pullImage(image);

  // Read-write mount when a build step is needed (npm install writes node_modules, etc.)
  const bindMount = config.buildCommand
    ? `${hostRepoPath(config.name)}:/app`
    : `${hostRepoPath(config.name)}:/app:ro`;

  // Only the repo bind-mount is allowed — no extra binds, no host socket access
  const opts: Dockerode.ContainerCreateOptions = {
    name: containerName(config.name),
    Image: image,
    Cmd: cmd,
    WorkingDir: '/app',
    Env: Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
    HostConfig: {
      Binds:         [bindMount],
      RestartPolicy: { Name: restartPolicy },
      // Hardened defaults — not user-configurable.
      // Privileged stays false (most important guard).
      // Drop NET_RAW (raw packet crafting/sniffing) — the one default cap
      // that is genuinely dangerous. CapDrop ALL would break apt-get because
      // it needs SETUID/SETGID to drop to the _apt user during package installs.
      Privileged: false,
      CapAdd:     [],
      CapDrop:    ['NET_RAW'],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [DOCKER_NETWORK]: { Aliases: [config.name, containerName(config.name)] },
      },
    },
  };

  if (config.vpnEnabled) {
    // Share network namespace with VPN sidecar — port binding not available.
    // NetworkingConfig is rejected by Docker when joining another container's
    // network namespace, so it must be removed.
    opts.HostConfig!.NetworkMode = `container:${vpnContainerName(config.name)}`;
    delete opts.NetworkingConfig;
  } else if (config.port) {
    opts.ExposedPorts = { [`${config.port}/tcp`]: {} };
    opts.HostConfig!.PortBindings = {
      [`${config.port}/tcp`]: [{ HostPort: String(config.port) }],
    };
  }

  return docker.createContainer(opts);
}

// ── Log streaming ─────────────────────────────────────────────────────────────

function startLogStream(container: Dockerode.Container, runId: string, scriptName: string): void {
  container.logs(
    { stdout: true, stderr: true, follow: true, timestamps: true },
    (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) {
        logService.markRunFailed(runId, err?.message);
        return;
      }

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      (docker as any).modem.demuxStream(stream, stdout, stderr);

      const write = (chunk: Buffer) => logService.appendLog(runId, chunk.toString('utf8'));
      stdout.on('data', write);
      stderr.on('data', write);

      stream.on('end', async () => {
        try {
          const c    = docker.getContainer(containerName(scriptName));
          const info = await c.inspect();
          logService.finishRun(runId, info.State.ExitCode);
          if (info.State.ExitCode !== 0) {
            try { await c.stop({ t: 5 }); } catch {}
          }
        } catch {
          logService.finishRun(runId, 1);
        }
      });
    },
  );
}

async function captureOnceLog(container: Dockerode.Container, runId: string): Promise<void> {
  return new Promise<void>(resolve => {
    container.logs(
      { stdout: true, stderr: true, follow: true, timestamps: true },
      (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) { resolve(); return; }

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        (docker as any).modem.demuxStream(stream, stdout, stderr);

        const write = (chunk: Buffer) => logService.appendLog(runId, chunk.toString('utf8'));
        stdout.on('data', write);
        stderr.on('data', write);

        stream.on('end', resolve);
        stream.on('error', () => resolve());
      },
    );
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function start(config: ScriptConfig, runId: string): Promise<void> {
  if (config.vpnEnabled) {
    await startVpnSidecar(config.name);
    await prependVpnLogs(config.name, runId);
  }
  await removeIfExists(config.name);
  const c = await createContainer(config, 'unless-stopped');
  await c.start();
  startLogStream(c, runId, config.name);
}

export async function stop(name: string, vpnEnabled?: boolean): Promise<void> {
  const c = await getContainer(name);
  if (c) {
    try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch {}
  }
  if (vpnEnabled) await stopVpnSidecar(name);
}

export async function restart(config: ScriptConfig, runId: string): Promise<void> {
  if (config.vpnEnabled) {
    await startVpnSidecar(config.name);
    await prependVpnLogs(config.name, runId);
  }
  await removeIfExists(config.name);
  const c = await createContainer(config, 'unless-stopped');
  await c.start();
  startLogStream(c, runId, config.name);
}

export async function runOnce(config: ScriptConfig, runId: string): Promise<{ exitCode: number }> {
  if (config.vpnEnabled) {
    await startVpnSidecar(config.name);
    await prependVpnLogs(config.name, runId);
  }
  await removeIfExists(config.name);
  const c = await createContainer(config, 'no');
  await c.start();

  const logDone = captureOnceLog(c, runId);
  const result  = await c.wait();
  await logDone;

  try { await c.remove({ force: true }); } catch {}
  if (config.vpnEnabled) await stopVpnSidecar(config.name);
  return { exitCode: result.StatusCode };
}

export async function removeContainer(name: string, vpnEnabled?: boolean): Promise<void> {
  await removeIfExists(name);
  if (vpnEnabled) await stopVpnSidecar(name);
}

async function prependVpnLogs(name: string, runId: string): Promise<void> {
  const logs = await getVpnLogs(name);
  if (!logs) return;
  logService.appendLog(runId, `=== VPN sidecar (script-vpn-${name}) ===\n${logs}\n=== script output ===\n`);
}

export async function getVpnLogs(name: string, tail = 100): Promise<string> {
  try {
    const c   = docker.getContainer(vpnContainerName(name));
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: true }) as unknown as Buffer;
    return demuxLogs(buf);
  } catch { return ''; }
}

export async function getVpnStatus(name: string): Promise<'connected' | 'connecting' | 'off'> {
  try {
    const c    = docker.getContainer(vpnContainerName(name));
    const info = await c.inspect();
    if (!info.State.Running) return 'connecting';
    const buf = await c.logs({ stdout: true, stderr: true, tail: 50 }) as unknown as Buffer;
    return demuxLogs(buf).includes('Initialization Sequence Completed') ? 'connected' : 'connecting';
  } catch { return 'off'; }
}

export async function getLogs(name: string, tail = 200): Promise<string> {
  const c = await getContainer(name);
  if (!c) return '';
  const buf = await c.logs({
    stdout: true, stderr: true, tail, timestamps: true,
  }) as unknown as Buffer;
  return demuxLogs(buf);
}

function demuxLogs(buf: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    lines.push(buf.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return lines.join('');
}
