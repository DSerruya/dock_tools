import Dockerode from 'dockerode';
import * as http from 'http';
import { PlatformAppConfig, PlatformAppRuntimeStatus, PlatformAppResources } from '../types';
import * as configService from './configService';
import * as platformAppConfigService from './platformAppConfigService';
import { demuxLogs } from '../utils/dockerLogs';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

// Same network Scripts already join (dockerService.ts's DOCKER_NETWORK) — Platform Apps need to
// be reachable from the manager process itself (for the health checks below) and from each other,
// exactly like Scripts already are, with no separate "Service" concept needed the way k8s has one.
const NETWORK = process.env.DOCKER_NETWORK || 'bridge';
// Real host path the local dockerd resolves this bind against — same convention as
// dockerService.ts's HOST_SCRIPTS_DATA_PATH: this process's own filesystem view never touches it.
const HOST_DATA_ROOT = process.env.PLATFORM_APPS_DATA_ROOT || '/opt/dock-tools/platform-apps';

const MANAGED_LABEL_KEY   = 'managed-by';
const MANAGED_LABEL_VALUE = 'script-manager-platform-apps';
// Stashed on the container itself so getStatus()/getLogs() can stay name-only lookups — same
// convention as k8sService.ts, whose Deployment object already carried its own probe config.
const CONTAINER_PORT_LABEL    = 'platform-app.container-port';
const HEALTH_CHECK_PATH_LABEL = 'platform-app.health-check-path';

function containerName(name: string): string { return `platform-app-${name}`; }

async function getContainer(name: string): Promise<Dockerode.Container | null> {
  try {
    const c = docker.getContainer(containerName(name));
    await c.inspect();
    return c;
  } catch { return null; }
}

// ── name-collision guard ────────────────────────────────────────────────────────
//
// k8s's version of this guarded against an app name colliding with a Deployment/Service Platform
// Apps didn't own (manager/nginx/utility-tools-hub's own hand-authored resources), because the
// RBAC Role had no per-resource restriction. Docker containers are namespaced by the
// "platform-app-" prefix here, so an exact container-name collision with manager/nginx/ollama/
// health-checker (whose real container names are script-manager, script-nginx, etc.) is
// structurally impossible — but two risks the prefix does NOT rule out remain: a stray container
// someone created by hand named literally "platform-app-<name>", and a Script already using that
// same bare name, since both Scripts and Platform Apps register the bare name as a network alias
// (see buildContainerOptions below) and Docker does not error on a duplicate alias — it just makes
// the name resolve to whichever container answers, silently breaking either one.
export async function isNameTaken(name: string): Promise<boolean> {
  if (configService.get(name)) return true; // already used by a Script — same network-alias risk

  const c = docker.getContainer(containerName(name));
  try {
    const info = await c.inspect();
    return info.Config.Labels?.[MANAGED_LABEL_KEY] !== MANAGED_LABEL_VALUE;
  } catch { return false; }
}

// ── k8s-style resource quantity strings → Docker HostConfig fields ──────────────
//
// PlatformAppConfig.resources keeps the k8s quantity-string format ("250m", "256Mi") so existing
// configs/UI need no changes. Docker has no scheduler on a single host, so "requests" (a
// scheduling hint in k8s) map only loosely: CpuShares is a relative weight, not a guarantee, and
// MemoryReservation is a soft/advisory minimum, not enforced unless the host is under memory
// pressure. "limits" map directly and are hard-enforced by the kernel via cgroups either way.
function parseCpuQuantity(cpu: string): number {
  return cpu.endsWith('m') ? parseFloat(cpu) / 1000 : parseFloat(cpu);
}

function parseMemoryQuantity(mem: string): number {
  const units: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3,
  };
  const match = mem.match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
  if (!match) return 0;
  const [, num, unit] = match;
  return Math.round(parseFloat(num) * (units[unit] ?? 1));
}

function resourceHostConfig(resources?: PlatformAppResources): Partial<Dockerode.ContainerCreateOptions['HostConfig']> {
  const cfg: Partial<Dockerode.ContainerCreateOptions['HostConfig']> = {};
  if (resources?.limits?.cpu)      (cfg as any).NanoCpus          = Math.round(parseCpuQuantity(resources.limits.cpu) * 1e9);
  if (resources?.limits?.memory)   (cfg as any).Memory            = parseMemoryQuantity(resources.limits.memory);
  if (resources?.requests?.memory) (cfg as any).MemoryReservation = parseMemoryQuantity(resources.requests.memory);
  if (resources?.requests?.cpu)    (cfg as any).CpuShares         = Math.round(parseCpuQuantity(resources.requests.cpu) * 1024);
  return cfg;
}

function buildContainerOptions(config: PlatformAppConfig): Dockerode.ContainerCreateOptions {
  const binds: string[] = [];
  if (config.needsDockerSock) binds.push('/var/run/docker.sock:/var/run/docker.sock');
  if (config.needsDataVolume) binds.push(`${HOST_DATA_ROOT}/${config.name}-data:/app/data`);

  const opts: Dockerode.ContainerCreateOptions = {
    name: containerName(config.name),
    Image: `${config.name}:latest`, // built locally by platformAppService.buildImage, same convention as Scripts
    Env: Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [MANAGED_LABEL_KEY]: MANAGED_LABEL_VALUE,
      [CONTAINER_PORT_LABEL]: String(config.containerPort),
      ...(config.healthCheckPath ? { [HEALTH_CHECK_PATH_LABEL]: config.healthCheckPath } : {}),
    },
    HostConfig: {
      Binds: binds,
      RestartPolicy: { Name: 'unless-stopped' },
      ...resourceHostConfig(config.resources),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [NETWORK]: { Aliases: [config.name, containerName(config.name)] },
      },
    },
  };

  if (config.hostPort) {
    opts.ExposedPorts = { [`${config.containerPort}/tcp`]: {} };
    opts.HostConfig!.PortBindings = {
      [`${config.containerPort}/tcp`]: [{ HostPort: String(config.hostPort) }],
    };
  }

  return opts;
}

async function removeIfExists(name: string): Promise<void> {
  const c = await getContainer(name);
  if (!c) return;
  try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch { /* already stopped */ }
  await c.remove({ force: true });
}

// ── liveness monitoring ──────────────────────────────────────────────────────────
//
// k8s's livenessProbe (initialDelaySeconds: 15, periodSeconds: 20, default failureThreshold: 3)
// auto-restarts a pod that stops answering even though it's still "running". Docker's own
// restart policies only react to the container process exiting, never to a failed health check,
// so that has no built-in equivalent here — this reimplements it as a manager-side poll (reusing
// the same readiness check below) with a cooldown so a genuinely broken app can't restart-loop
// tighter than once a minute.
const LIVENESS_PERIOD_MS       = 20_000;
const LIVENESS_FAILURE_THRESHOLD = 3;
const LIVENESS_RESTART_COOLDOWN_MS = 60_000;

const livenessTimers      = new Map<string, NodeJS.Timeout>();
const consecutiveFailures = new Map<string, number>();
const lastAutoRestart     = new Map<string, number>();

function stopLivenessMonitor(name: string): void {
  const timer = livenessTimers.get(name);
  if (timer) clearInterval(timer);
  livenessTimers.delete(name);
  consecutiveFailures.delete(name);
}

function startLivenessMonitor(config: PlatformAppConfig): void {
  stopLivenessMonitor(config.name);
  if (!config.healthCheckPath) return;
  const timer = setInterval(async () => {
    const healthy = await checkHealth(config.name, config.containerPort, config.healthCheckPath!);
    if (healthy) { consecutiveFailures.set(config.name, 0); return; }

    const failures = (consecutiveFailures.get(config.name) || 0) + 1;
    consecutiveFailures.set(config.name, failures);
    if (failures < LIVENESS_FAILURE_THRESHOLD) return;

    const lastRestart = lastAutoRestart.get(config.name) || 0;
    if (Date.now() - lastRestart < LIVENESS_RESTART_COOLDOWN_MS) return;

    console.error(`[platform-apps] ${config.name} failed ${failures} consecutive health checks — restarting`);
    lastAutoRestart.set(config.name, Date.now());
    consecutiveFailures.set(config.name, 0);
    try { await apply(config); } catch (err) { console.error(`[platform-apps] auto-restart of ${config.name} failed:`, err); }
  }, LIVENESS_PERIOD_MS);
  livenessTimers.set(config.name, timer);
}

function checkHealth(name: string, port: number, healthPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(
      { host: containerName(name), port, path: healthPath, timeout: 3000 },
      res => { resolve(!!res.statusCode && res.statusCode >= 200 && res.statusCode < 400); res.resume(); },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// ── Public API — same shape as k8sService.ts had, so platform-apps.ts barely changes ───────────

// Replaces k8sService's applyDeployment+applyService pair: Docker has no separate "Service"
// object, and container specs can't be patched in place the way a Deployment spec could, so
// install, edit (PUT), and "pick up a freshly rebuilt image" all reduce to the same operation —
// stop+remove whatever's there, create fresh from the current config, start it.
export async function apply(config: PlatformAppConfig): Promise<void> {
  await removeIfExists(config.name);
  const c = await docker.createContainer(buildContainerOptions(config));
  await c.start();
  startLivenessMonitor(config);
}

export async function start(name: string): Promise<void> {
  const c = await getContainer(name);
  if (!c) throw new Error(`Platform app "${name}" has no container — install it first`);
  await c.start();
  const config = platformAppConfigService.get(name); // re-arm liveness monitoring after a manual stop/start
  if (config) startLivenessMonitor(config);
}

export async function stop(name: string): Promise<void> {
  stopLivenessMonitor(name);
  const c = await getContainer(name);
  if (c) { try { const i = await c.inspect(); if (i.State.Running) await c.stop({ t: 10 }); } catch { /* already stopped */ } }
}

export async function deleteApp(name: string): Promise<void> {
  stopLivenessMonitor(name);
  await removeIfExists(name);
}

export async function getStatus(name: string): Promise<PlatformAppRuntimeStatus> {
  const c = await getContainer(name);
  if (!c) return 'not_deployed';

  const info = await c.inspect();
  if (!info.State.Running) return info.State.ExitCode === 0 ? 'stopped' : 'error';

  const healthCheckPath = info.Config.Labels?.[HEALTH_CHECK_PATH_LABEL];
  const containerPort   = info.Config.Labels?.[CONTAINER_PORT_LABEL];
  if (!healthCheckPath || !containerPort) return 'running';

  const healthy = await checkHealth(name, Number(containerPort), healthCheckPath);
  return healthy ? 'running' : 'error';
}

export async function getLogs(name: string, tail = 200): Promise<string> {
  const c = await getContainer(name);
  if (!c) return '';
  try {
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: true }) as unknown as Buffer;
    return demuxLogs(buf);
  } catch (err: any) {
    return `(failed to read logs: ${err?.message || err})`;
  }
}
