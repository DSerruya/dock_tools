import Dockerode from 'dockerode';
import * as tar from 'tar-fs';
import { PlatformAppConfig, GitSource } from '../types';
import * as gitService from './gitService';
import * as k8sService from './k8sService';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

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
  await gitService.clone(gitSource(config));
  await buildImage(config);
  await k8sService.applyDeployment(config);
  await k8sService.applyService(config);
}

export async function update(config: PlatformAppConfig): Promise<void> {
  await gitService.pull(gitSource(config));
  await buildImage(config);
  await k8sService.forceRollout(config.name);
}

export async function start(name: string): Promise<void>   { await k8sService.scaleDeployment(name, 1); }
export async function stop(name: string): Promise<void>     { await k8sService.scaleDeployment(name, 0); }
export async function restart(name: string): Promise<void>  { await k8sService.forceRollout(name); }

export async function uninstall(name: string): Promise<void> {
  await k8sService.deleteApp(name);
  gitService.deleteClone(`platform-apps/${name}`);
}
