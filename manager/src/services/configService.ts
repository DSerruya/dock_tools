import * as fs from 'fs';
import * as path from 'path';
import { ScriptConfig } from '../types';

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
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as ScriptConfig[];
  } catch {
    return [];
  }
}

export function save(config: ScriptConfig): void {
  const configs = loadAll();
  const idx = configs.findIndex(c => c.name === config.name);
  if (idx >= 0) {
    configs[idx] = config;
  } else {
    configs.push(config);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

export function remove(name: string): void {
  const configs = loadAll().filter(c => c.name !== name);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

export function get(name: string): ScriptConfig | undefined {
  return loadAll().find(c => c.name === name);
}
