import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import * as gitService from './gitService';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });
  });
}

// Extracts an uploaded .tar.gz/.tgz buffer into the script's local source directory,
// replacing whatever was there before. The archive is expected to look like the .tar.gz
// produced by GET /api/scripts/:name/download — a single top-level directory wrapping the
// script's files — and is extracted with --strip-components=1 to normalize that away.
//
// Before anything is written, every entry path is listed and checked for path traversal
// (absolute paths, "../" segments) so a crafted archive can't write outside the target
// directory (zip-slip).
export async function extract(name: string, buffer: Buffer): Promise<void> {
  const repoPath = gitService.getLocalPath(name);
  const tmpFile  = path.join(os.tmpdir(), `upload-${name}-${crypto.randomBytes(8).toString('hex')}.tar.gz`);

  fs.writeFileSync(tmpFile, buffer);
  try {
    const listing = await run('tar', ['-tzf', tmpFile]);
    const entries = listing.split('\n').map(l => l.trim()).filter(Boolean);
    if (entries.length === 0) throw new Error('Archive is empty');

    for (const entry of entries) {
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`Archive contains an unsafe path: ${entry}`);
      }
    }

    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.mkdirSync(repoPath, { recursive: true });
    await run('tar', ['-xzf', tmpFile, '--strip-components=1', '-C', repoPath]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}
