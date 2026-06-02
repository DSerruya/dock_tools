import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';
import { ScriptConfig } from '../types';

const DATA_DIR = process.env.DATA_DIR || '/app/scripts-data';

export function getLocalPath(name: string): string {
  return path.join(DATA_DIR, name, 'repo');
}

export function isCloned(name: string): boolean {
  return fs.existsSync(path.join(getLocalPath(name), '.git'));
}

// Embed a PAT into a GitHub HTTPS URL without exposing it in logs
function authUrl(config: ScriptConfig): string {
  if (!config.repoToken) return config.repo;
  // https://github.com/... → https://<token>@github.com/...
  return config.repo.replace('https://', `https://${config.repoToken}@`);
}

export async function clone(config: ScriptConfig): Promise<string> {
  const repoPath = getLocalPath(config.name);
  fs.mkdirSync(repoPath, { recursive: true });
  const git = simpleGit();
  await git.clone(authUrl(config), repoPath, ['--branch', config.branch, '--depth', '1']);
  return repoPath;
}

export async function pull(config: ScriptConfig): Promise<void> {
  const repoPath = getLocalPath(config.name);
  const git      = simpleGit(repoPath);

  if (config.repoToken) {
    // Update the remote URL in case the token changed
    await git.remote(['set-url', 'origin', authUrl(config)]);
  }
  await git.pull('origin', config.branch);
}

export async function cloneOrPull(config: ScriptConfig): Promise<string> {
  if (isCloned(config.name)) {
    await pull(config);
  } else {
    await clone(config);
  }
  return getLocalPath(config.name);
}
