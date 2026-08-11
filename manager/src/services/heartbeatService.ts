import { ScriptConfig } from '../types';
import * as logService from './logService';

const TIMEOUT_MS = 5000;

// Dead-man's-switch style monitoring (e.g. Zenduty/Xurrent heartbeat check-ins): a successful run
// pings the configured URL; a failed run — or a failed ping itself — stays silent, since the whole
// point is that the monitor's own missed-heartbeat timeout is what raises the alert.
export function report(config: ScriptConfig, exitCode: number, runId?: string): void {
  if (exitCode !== 0) return;
  if (!config.heartbeatEnabled || !config.heartbeatUrl) return;
  void ping(config.name, config.heartbeatUrl, runId);
}

async function ping(scriptName: string, url: string, runId?: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) logFailure(scriptName, url, runId, `returned ${res.status}`);
  } catch (err: any) {
    logFailure(scriptName, url, runId, err?.message || String(err));
  } finally {
    clearTimeout(timeout);
  }
}

function logFailure(scriptName: string, url: string, runId: string | undefined, reason: string): void {
  const msg = `[heartbeat] ${scriptName}: ping to ${url} failed — ${reason}`;
  console.error(msg);
  if (runId) logService.appendLog(runId, `\n${msg}\n`);
}
