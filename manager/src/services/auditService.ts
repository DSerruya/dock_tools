import * as fs from 'fs';
import * as path from 'path';
import { ScriptConfig } from '../types';

const DATA_DIR   = process.env.DATA_DIR || '/app/scripts-data';
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES = 2000;

export interface ChangeDetail {
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;          // e.g. 'script.created', 'config.schedule.set'
  scriptName: string;
  changes: ChangeDetail[]; // field-level diffs
}

function load(): AuditEntry[] {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
  catch { return []; }
}

function save(entries: AuditEntry[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(entries, null, 2));
}

export function record(
  user: string,
  action: string,
  scriptName: string,
  changes: ChangeDetail[],
): void {
  const entries = load();
  entries.unshift({
    id:        `audit-${Date.now()}`,
    timestamp: new Date().toISOString(),
    user,
    action,
    scriptName,
    changes,
  });
  save(entries.slice(0, MAX_ENTRIES));
}

export function list(scriptName?: string): AuditEntry[] {
  const entries = load();
  return scriptName ? entries.filter(e => e.scriptName === scriptName) : entries;
}

// ── Diff helpers ──────────────────────────────────────────────────────────────

const TRACKED_FIELDS: (keyof ScriptConfig)[] = [
  'sourceType', 'repo', 'branch', 'entryPoint', 'buildCommand', 'preserveEnv', 'runMode',
  'schedule', 'timezone', 'port', 'env', 'language', 'repoToken',
];

// Fields whose values are masked or redacted in audit records
const MASKED_FIELDS  = new Set<string>(['repoToken']);
// env values can contain secrets — record only keys, not values
const ENV_KEYS_ONLY  = new Set<string>(['env']);

function maskValue(field: string, value: unknown): unknown {
  if (MASKED_FIELDS.has(field) && value) return '***';
  if (ENV_KEYS_ONLY.has(field) && value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `{keys: ${keys.join(', ')}}` : '{}';
  }
  return value;
}

export function diffConfigs(
  oldCfg: Partial<ScriptConfig>,
  newCfg: Partial<ScriptConfig>,
): ChangeDetail[] {
  const changes: ChangeDetail[] = [];
  for (const field of TRACKED_FIELDS) {
    const o = JSON.stringify(oldCfg[field] ?? null);
    const n = JSON.stringify(newCfg[field] ?? null);
    if (o !== n) {
      changes.push({
        field,
        oldValue: maskValue(field, oldCfg[field]),
        newValue: maskValue(field, newCfg[field]),
      });
    }
  }
  return changes;
}

export function configAsChanges(cfg: Partial<ScriptConfig>): ChangeDetail[] {
  return TRACKED_FIELDS
    .filter(f => cfg[f] !== undefined)
    .map(f => ({ field: f, oldValue: undefined, newValue: maskValue(f, cfg[f]) }));
}
