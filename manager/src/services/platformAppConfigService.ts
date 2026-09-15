import * as fs from 'fs';
import * as path from 'path';
import { PlatformAppConfig } from '../types';
import { encrypt, decrypt } from './encryptionService';

// Mirrors configService.ts's shape exactly, just against a separate JSON file — PlatformApps are
// a distinct registry from ScriptConfig's scripts.json, not a variant of it.
const DATA_DIR    = process.env.DATA_DIR || '/app/scripts-data';
const CONFIG_FILE = path.join(DATA_DIR, 'platform-apps.json');

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify([], null, 2));
  }
}

export function loadAll(): PlatformAppConfig[] {
  ensureFile();
  try {
    const configs = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as PlatformAppConfig[];
    return configs.map(c => ({
      ...c,
      repoToken: c.repoToken ? decrypt(c.repoToken) : undefined,
    }));
  } catch {
    return [];
  }
}

function loadAllRaw(): PlatformAppConfig[] {
  ensureFile();
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as PlatformAppConfig[]; }
  catch { return []; }
}

export function save(config: PlatformAppConfig): void {
  const raw = loadAllRaw();
  const onDisk: PlatformAppConfig = {
    ...config,
    repoToken: config.repoToken ? encrypt(config.repoToken) : undefined,
  };
  const idx = raw.findIndex(c => c.name === config.name);
  if (idx >= 0) {
    raw[idx] = onDisk;
  } else {
    raw.push(onDisk);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
}

export function remove(name: string): void {
  const raw = loadAllRaw().filter(c => c.name !== name);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
}

export function get(name: string): PlatformAppConfig | undefined {
  return loadAll().find(c => c.name === name);
}
