import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';
import { ScriptConfig, DEPS_SENTINEL } from '../types';

const DATA_DIR = process.env.DATA_DIR || '/app/scripts-data';

export function getLocalPath(name: string): string {
  return path.join(DATA_DIR, name, 'repo');
}

export function isCloned(name: string): boolean {
  return fs.existsSync(path.join(getLocalPath(name), '.git'));
}

// Source-agnostic readiness check. For upload-based scripts this must NOT delegate to
// isCloned(): an uploaded archive can legitimately contain a leftover .git directory (e.g. one
// re-uploaded from another script's /download backup), and treating that as "cloned" would let
// callers mistakenly run git operations against a stale/foreign remote. Upload readiness is
// purely "is there a non-empty directory here".
export function isReady(config: ScriptConfig): boolean {
  if (config.sourceType === 'upload') {
    const repoPath = getLocalPath(config.name);
    try {
      return fs.existsSync(repoPath) && fs.readdirSync(repoPath).length > 0;
    } catch {
      return false;
    }
  }
  return isCloned(config.name);
}

// repo/branch are only optional to accommodate upload-based configs; every function below is
// git-specific and must only ever be called (by routes) for sourceType === 'git' configs, where
// they're always populated. This narrows the type and fails loudly if that contract is broken.
function requireGitConfig(config: ScriptConfig): ScriptConfig & { repo: string; branch: string } {
  if (!config.repo || !config.branch) {
    throw new Error(`"${config.name}" has no repo/branch configured — not a git-based script`);
  }
  return config as ScriptConfig & { repo: string; branch: string };
}

// Embed a PAT into a GitHub HTTPS URL without exposing it in logs
function authUrl(config: ScriptConfig & { repo: string }): string {
  if (!config.repoToken) return config.repo;
  // https://github.com/... → https://<token>@github.com/...
  return config.repo.replace('https://', `https://${config.repoToken}@`);
}

export async function clone(rawConfig: ScriptConfig): Promise<string> {
  const config   = requireGitConfig(rawConfig);
  const repoPath = getLocalPath(config.name);
  fs.mkdirSync(repoPath, { recursive: true });
  const git = simpleGit();
  await git.clone(authUrl(config), repoPath, ['--branch', config.branch, '--depth', '1']);
  return repoPath;
}

export async function pull(rawConfig: ScriptConfig): Promise<void> {
  const config   = requireGitConfig(rawConfig);
  const repoPath = getLocalPath(config.name);
  const git      = simpleGit(repoPath);

  if (config.repoToken) {
    await git.remote(['set-url', 'origin', authUrl(config)]);
  }
  await git.fetch('origin', config.branch);
  await git.raw(['reset', '--hard', `origin/${config.branch}`]);
  // -e excludes the preserveEnv sentinel from clean. A pull always invalidates it (every
  // caller below passes forceRebuild), but that invalidation happens later, after the old
  // container is confirmed torn down — letting clean touch it here, while that container
  // might still be running a build against this same bind-mounted dir, would race it.
  await git.raw(['clean', '-fd', '-e', DEPS_SENTINEL]);
}

export function deleteClone(name: string): void {
  const repoPath = getLocalPath(name);
  if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true, force: true });
}

export async function cloneOrPull(config: ScriptConfig): Promise<string> {
  if (isCloned(config.name)) {
    await pull(config);
  } else {
    await clone(config);
  }
  return getLocalPath(config.name);
}

export async function checkForUpdates(rawConfig: ScriptConfig): Promise<{
  hasUpdate: boolean;
  behind: number;
  latestCommit?: string;
  latestMessage?: string;
}> {
  if (!isCloned(rawConfig.name)) return { hasUpdate: false, behind: 0 };
  const config = requireGitConfig(rawConfig);

  const repoPath = getLocalPath(config.name);
  const git = simpleGit(repoPath);

  if (config.repoToken) {
    await git.remote(['set-url', 'origin', authUrl(config)]);
  }

  await git.fetch('origin', config.branch);

  const countRaw = await git.raw(['rev-list', '--count', `HEAD..origin/${config.branch}`]);
  const behind = parseInt(countRaw.trim()) || 0;

  if (behind === 0) return { hasUpdate: false, behind: 0 };

  const logRaw = await git.raw(['log', '-1', '--format=%H|%s', `origin/${config.branch}`]);
  const pipeIdx = logRaw.trim().indexOf('|');
  const hash = pipeIdx > 0 ? logRaw.trim().slice(0, pipeIdx) : logRaw.trim().slice(0, 40);
  const msg  = pipeIdx > 0 ? logRaw.trim().slice(pipeIdx + 1) : '';

  return { hasUpdate: true, behind, latestCommit: hash.slice(0, 7), latestMessage: msg };
}
