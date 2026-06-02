import Dockerode from 'dockerode';
import { ScriptConfig, ContainerStatus } from '../types';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const DOCKER_NETWORK = process.env.DOCKER_NETWORK || 'script-network';
const HOST_SCRIPTS_DATA_PATH = process.env.HOST_SCRIPTS_DATA_PATH || '/app/scripts-data';

const IMAGE_MAP: Record<string, string> = {
  python:     'python:3.12-slim',
  ruby:       'ruby:3.3-slim',
  node:       'node:20-slim',
  typescript: 'node:20-slim',
};

const CMD_MAP: Record<string, (entry: string) => string[]> = {
  python:     entry => ['python', entry],
  ruby:       entry => ['ruby', entry],
  node:       entry => ['node', entry],
  typescript: entry => ['node', entry],
};

function containerName(name: string): string {
  return `script-${name}`;
}

function hostRepoPath(name: string): string {
  return `${HOST_SCRIPTS_DATA_PATH}/${name}/repo`;
}

async function getContainer(name: string): Promise<Dockerode.Container | null> {
  try {
    const c = docker.getContainer(containerName(name));
    await c.inspect();
    return c;
  } catch {
    return null;
  }
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
  try {
    await docker.getImage(image).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }
}

async function removeIfExists(name: string): Promise<void> {
  const c = await getContainer(name);
  if (!c) return;
  try {
    const info = await c.inspect();
    if (info.State.Running) await c.stop({ t: 5 });
  } catch { /* already stopped */ }
  await c.remove({ force: true });
}

async function createContainer(
  config: ScriptConfig,
  restartPolicy: string
): Promise<Dockerode.Container> {
  const image = IMAGE_MAP[config.language] || 'node:20-slim';
  const cmd = (CMD_MAP[config.language] || CMD_MAP.node)(config.entryPoint);

  await pullImage(image);

  const envVars = Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`);

  const opts: Dockerode.ContainerCreateOptions = {
    name: containerName(config.name),
    Image: image,
    Cmd: cmd,
    WorkingDir: '/app',
    Env: envVars,
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

export async function start(config: ScriptConfig): Promise<void> {
  await removeIfExists(config.name);
  const c = await createContainer(config, 'unless-stopped');
  await c.start();
}

export async function stop(name: string): Promise<void> {
  const c = await getContainer(name);
  if (!c) return;
  try {
    const info = await c.inspect();
    if (info.State.Running) await c.stop({ t: 10 });
  } catch { /* already stopped */ }
}

export async function restart(config: ScriptConfig): Promise<void> {
  await removeIfExists(config.name);
  const c = await createContainer(config, 'unless-stopped');
  await c.start();
}

export async function runOnce(config: ScriptConfig): Promise<{ exitCode: number }> {
  await removeIfExists(config.name);
  const c = await createContainer(config, 'no');
  await c.start();
  const result = await c.wait();
  try { await c.remove({ force: true }); } catch { /* ignore */ }
  return { exitCode: result.StatusCode };
}

export async function removeContainer(name: string): Promise<void> {
  await removeIfExists(name);
}

export async function getLogs(name: string, tail = 200): Promise<string> {
  const c = await getContainer(name);
  if (!c) return '';
  const buf = await c.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
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
