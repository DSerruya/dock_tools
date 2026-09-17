import Dockerode from 'dockerode';
import * as tar from 'tar-fs';
import { PlatformAppConfig, GitSource, PlatformAppBuildPhase, PlatformAppBuildState } from '../types';
import * as gitService from './gitService';
import * as dockerPlatformAppService from './dockerPlatformAppService';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

// In-memory only — install/update run as a background setImmediate() job off the request that
// kicked them off (routes/platform-apps.ts), so this is the one place that actually knows a
// clone/pull+build+apply is still running vs. done. Lost on a manager restart, same as every other
// purely in-process job-tracking in this codebase (e.g. dockerPlatformAppService's liveness
// timers) — acceptable since a manager restart mid-build kills the build itself too.
const buildState = new Map<string, PlatformAppBuildState>();

export function getBuildState(name: string): PlatformAppBuildState | undefined {
  return buildState.get(name);
}

// Routes gate start/stop/restart/update/edit on this so they can't race the apply() at the end of
// an in-flight install/update. A failed attempt (buildState still set, but with `error`) does NOT
// count as "deploying" — nothing is still running in the background to race with.
export function isDeploying(name: string): boolean {
  const state = buildState.get(name);
  return !!state && !state.error;
}

async function runBuild(name: string, phase: PlatformAppBuildPhase, fn: () => Promise<void>): Promise<void> {
  buildState.set(name, { phase, startedAt: new Date().toISOString() });
  try {
    await fn();
    buildState.delete(name);
  } catch (err: any) {
    buildState.set(name, { phase, startedAt: new Date().toISOString(), error: err?.message || String(err) });
    throw err;
  }
}

// PlatformApp repos are cloned under DATA_DIR/platform-apps/<name>/repo purely by giving
// gitService a composite "name" — no changes to gitService's path logic needed, it already joins
// DATA_DIR/<name>/repo for whatever name it's given.
function gitSource(config: PlatformAppConfig): GitSource {
  return { name: `platform-apps/${config.name}`, repo: config.repo, branch: config.branch, repoToken: config.repoToken };
}

function buildContextDir(config: PlatformAppConfig): string {
  return gitService.getLocalPath(`platform-apps/${config.name}`);
}

// Excludes .git from the image build context. A git-based clone's .git/config can contain the
// embedded repoToken (gitService's authUrl sets the remote URL to https://<token>@...) — fine to
// have on local disk (every git-based ScriptConfig clone already carries the same thing), but it
// must never end up baked into a distributable image layer.
function packBuildContext(dir: string) {
  return tar.pack(dir, { ignore: name => name.split('/').includes('.git') });
}

async function buildImage(config: PlatformAppConfig): Promise<void> {
  const tarStream = packBuildContext(buildContextDir(config));
  const buildStream = await docker.buildImage(tarStream as any, { t: `${config.name}:latest` });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(buildStream, (err: Error | null, output: Array<{ error?: string }>) => {
      if (err) return reject(err);
      const buildErr = output.find(o => o.error);
      if (buildErr) return reject(new Error(buildErr.error));
      resolve();
    });
  });
}

export async function install(config: PlatformAppConfig): Promise<void> {
  await runBuild(config.name, 'installing', async () => {
    await gitService.clone(gitSource(config));
    await buildImage(config);
    await dockerPlatformAppService.apply(config);
  });
}

export async function update(config: PlatformAppConfig): Promise<void> {
  await runBuild(config.name, 'updating', async () => {
    await gitService.pull(gitSource(config));
    await buildImage(config);
    await dockerPlatformAppService.apply(config);
  });
}

export async function start(name: string): Promise<void>          { await dockerPlatformAppService.start(name); }
export async function stop(name: string): Promise<void>           { await dockerPlatformAppService.stop(name); }
export async function restart(config: PlatformAppConfig): Promise<void> { await dockerPlatformAppService.apply(config); }

export async function uninstall(name: string): Promise<void> {
  await dockerPlatformAppService.deleteApp(name);
  gitService.deleteClone(`platform-apps/${name}`);
}
