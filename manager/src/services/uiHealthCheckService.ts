import * as fs from 'fs';
import * as path from 'path';
import Dockerode from 'dockerode';

const DATA_DIR        = process.env.DATA_DIR || '/app/scripts-data';
const SETTINGS_FILE   = path.join(DATA_DIR, 'ui-health-check.json');
const NGINX_CONTAINER = 'script-nginx';
// Hits nginx (not the manager directly) so a failure here means the actual reverse-proxy
// path the browser uses is broken, not just the app server behind it.
const CHECK_URL        = process.env.UI_HEALTH_CHECK_URL || 'http://script-nginx/healthz';
const CHECK_TIMEOUT_MS = 5000;

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

export interface UiHealthCheckSettings {
  enabled: boolean;
  intervalMinutes: number;
}

const DEFAULT_SETTINGS: UiHealthCheckSettings = { enabled: false, intervalMinutes: 5 };

export interface UiHealthCheckStatus {
  lastCheckAt: string | null;
  lastResult: 'ok' | 'fail' | null;
  lastError?: string;
  consecutiveFailures: number;
  lastRestartAt: string | null;
  restartCount: number;
  checking: boolean;
}

function loadSettings(): UiHealthCheckSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      enabled:         !!raw.enabled,
      intervalMinutes: Number.isInteger(raw.intervalMinutes) && raw.intervalMinutes > 0
        ? raw.intervalMinutes
        : DEFAULT_SETTINGS.intervalMinutes,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings: UiHealthCheckSettings = loadSettings();

const status: UiHealthCheckStatus = {
  lastCheckAt:          null,
  lastResult:           null,
  consecutiveFailures:  0,
  lastRestartAt:        null,
  restartCount:         0,
  checking:             false,
};

let timer: NodeJS.Timeout | null = null;

export function getSettings(): UiHealthCheckSettings { return { ...settings }; }
export function getStatus(): UiHealthCheckStatus     { return { ...status }; }

export function saveSettings(next: UiHealthCheckSettings): UiHealthCheckSettings {
  settings = { enabled: next.enabled, intervalMinutes: next.intervalMinutes };
  persist();
  schedule();
  return getSettings();
}

function schedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (!settings.enabled) return;
  timer = setInterval(() => { void runCheck(); }, settings.intervalMinutes * 60 * 1000);
}

// Resumes a previously-enabled schedule — called once at server boot.
export function init(): void {
  schedule();
}

async function pingNginx(): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(CHECK_URL, { signal: controller.signal });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(t);
  }
}

async function restartNginx(): Promise<{ ok: boolean; error?: string }> {
  try {
    await docker.getContainer(NGINX_CONTAINER).restart({ t: 5 });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Pings nginx and, on failure, restarts it. Shared by the periodic timer and the
// manual "Check Now" button so both take identical action.
export async function runCheck(): Promise<UiHealthCheckStatus> {
  if (status.checking) return getStatus();
  status.checking = true;
  try {
    const result = await pingNginx();
    status.lastCheckAt = new Date().toISOString();
    if (result.ok) {
      status.lastResult = 'ok';
      status.lastError = undefined;
      status.consecutiveFailures = 0;
    } else {
      status.lastResult = 'fail';
      status.lastError = result.error;
      status.consecutiveFailures += 1;
      console.error(`[ui-health-check] nginx check failed: ${result.error} — restarting ${NGINX_CONTAINER}`);
      const restart = await restartNginx();
      if (restart.ok) {
        status.lastRestartAt = new Date().toISOString();
        status.restartCount += 1;
      } else {
        console.error(`[ui-health-check] failed to restart ${NGINX_CONTAINER}: ${restart.error}`);
      }
    }
  } finally {
    status.checking = false;
  }
  return getStatus();
}
