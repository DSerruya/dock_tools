import * as fs from 'fs';
import * as path from 'path';
import { ScriptConfig } from '../types';
import { encrypt, decrypt } from './encryptionService';

const DATA_DIR = process.env.DATA_DIR || '/app/scripts-data';
const CONFIG_FILE = path.join(DATA_DIR, 'scripts.json');

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify([], null, 2));
  }
}

export function loadAll(): ScriptConfig[] {
  ensureFile();
  try {
    const configs = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as ScriptConfig[];
    return configs.map(c => ({
      ...c,
      repoToken: c.repoToken ? decrypt(c.repoToken) : undefined,
    }));
  } catch {
    return [];
  }
}

export function save(config: ScriptConfig): void {
  const raw = loadAllRaw();
  const onDisk: ScriptConfig = {
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

function loadAllRaw(): ScriptConfig[] {
  ensureFile();
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as ScriptConfig[]; }
  catch { return []; }
}

export function remove(name: string): void {
  const raw = loadAllRaw().filter(c => c.name !== name);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
}

export function get(name: string): ScriptConfig | undefined {
  return loadAll().find(c => c.name === name);
}
