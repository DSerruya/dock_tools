import Dockerode from 'dockerode';
import { PassThrough } from 'stream';
import { ScriptConfig, ContainerStatus } from '../types';
import * as logService from './logService';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const DOCKER_NETWORK        = process.env.DOCKER_NETWORK        || 'bridge';
const HOST_SCRIPTS_DATA_PATH = process.env.HOST_SCRIPTS_DATA_PATH || '/app/scripts-data';

const IMAGE_MAP: Record<string, string> = {
  python:     'python:3.12-slim',
  ruby:       'ruby:3.3-slim',
  node:       'node:20-slim',
  typescript: 'node:20-slim',
};

const CMD_MAP: Record<string, (entry: string) => string[]> = {
  python:     e => ['python', e],
  ruby:       e => ['ruby',   e],
  node:       e => ['node',   e],
  typescript: e => ['node',   e],
};

function containerName(name: string): string { return `script-${name}`; }
function hostRepoPath(name: string): string  { return `${HOST_SCRIPTS_DATA_PATH}/${name}/repo`; }

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

async function createContainer(config: ScriptConfig, restartPolicy: string): Promise<Dockerode.Container> {
  const image = IMAGE_MAP[config.language] || 'node:20-slim';
  const cmd   = (CMD_MAP[config.language]  || CMD_MAP.node)(config.entryPoint);

  await pullImage(image);

  const opts: Dockerode.ContainerCreateOptions = {
    name: containerName(config.name),
    Image: image,
    Cmd: cmd,
    WorkingDir: '/app',
    Env: Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
    HostConfig: {
      Binds: [`${hostRepoPath(config.name)}:/app:ro`],
      RestartPolicy: { Name: restartPolicy },
      NetworkMode: DOCKER_NETWORK,
    },
  };

  if (config.port) {
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
  await removeIfExists(config.name);
  const c = await createContainer(config, 'unless-stopped');
  await c.start();
  startLogStream(c, runId, config.name);
}

export async function stop(name: string): Promise<void> {
  const c = await getContainer(name);
  if (!c) return;
  try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch {}
}

export async function restart(config: ScriptConfig, runId: string): Promise<void> {
  await removeIfExists(config.name);
  const c = await createContainer(config, 'unless-stopped');
  await c.start();
  startLogStream(c, runId, config.name);
}

export async function runOnce(config: ScriptConfig, runId: string): Promise<{ exitCode: number }> {
  await removeIfExists(config.name);
  const c = await createContainer(config, 'no');
  await c.start();

  const logDone = captureOnceLog(c, runId);
  const result  = await c.wait();
  await logDone;

  try { await c.remove({ force: true }); } catch {}
  return { exitCode: result.StatusCode };
}

export async function removeContainer(name: string): Promise<void> {
  await removeIfExists(name);
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
