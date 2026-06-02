import * as fs from 'fs';
import * as path from 'path';
import { Language, RunMode } from '../types';

const DATA_DIR = process.env.DATA_DIR || '/app/scripts-data';
const LOGS_DIR  = path.join(DATA_DIR, 'logs');
const RUNS_FILE = path.join(LOGS_DIR, 'runs.json');

export interface RunRecord {
  runId: string;
  scriptName: string;
  language: Language;
  runMode: RunMode;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'failed';
  exitCode?: number;
}

function ensureDir(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function loadRuns(): RunRecord[] {
  ensureDir();
  if (!fs.existsSync(RUNS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); }
  catch { return []; }
}

function saveRuns(runs: RunRecord[]): void {
  ensureDir();
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
}

export function logFilePath(runId: string): string {
  return path.join(LOGS_DIR, `${runId}.log`);
}

export function createRun(
  scriptName: string,
  language: Language,
  runMode: RunMode,
): string {
  ensureDir();
  // sanitise name so it's safe as a filename
  const safe  = scriptName.replace(/[^a-z0-9-]/g, '-');
  const runId = `${safe}-${Date.now()}`;
  const record: RunRecord = {
    runId, scriptName, language, runMode,
    startTime: new Date().toISOString(),
    status: 'running',
  };
  const runs = loadRuns();
  runs.push(record);
  saveRuns(runs);
  return runId;
}

export function appendLog(runId: string, text: string): void {
  ensureDir();
  if (!text) return;
  fs.appendFileSync(logFilePath(runId), text);
}

export function finishRun(runId: string, exitCode: number): void {
  const runs = loadRuns();
  const run  = runs.find(r => r.runId === runId);
  if (!run || run.status !== 'running') return;
  run.status   = exitCode === 0 ? 'success' : 'failed';
  run.exitCode = exitCode;
  run.endTime  = new Date().toISOString();
  saveRuns(runs);
}

export function markRunFailed(runId: string, reason?: string): void {
  const runs = loadRuns();
  const run  = runs.find(r => r.runId === runId);
  if (!run || run.status !== 'running') return;
  run.status  = 'failed';
  run.endTime = new Date().toISOString();
  saveRuns(runs);
  if (reason) appendLog(runId, `\n[ERROR] ${reason}\n`);
}

export function listRuns(scriptName?: string): RunRecord[] {
  const runs = loadRuns();
  const filtered = scriptName ? runs.filter(r => r.scriptName === scriptName) : runs;
  return filtered.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
}

export function getRun(runId: string): RunRecord | undefined {
  return loadRuns().find(r => r.runId === runId);
}

export function getLogContent(runId: string): string {
  const file = logFilePath(runId);
  if (!fs.existsSync(file)) return '(no output captured)';
  return fs.readFileSync(file, 'utf8');
}

export function findRunningRun(scriptName: string): RunRecord | undefined {
  return loadRuns().find(r => r.scriptName === scriptName && r.status === 'running');
}

// On manager restart any 'running' record is stale — mark them failed.
export function recoverStaleRuns(): void {
  const runs = loadRuns();
  let changed = false;
  for (const run of runs) {
    if (run.status === 'running') {
      run.status  = 'failed';
      run.endTime = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveRuns(runs);
}
