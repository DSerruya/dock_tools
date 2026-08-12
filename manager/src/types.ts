export type RunMode = 'persistent' | 'scheduled';
export type Language = 'python' | 'ruby' | 'node' | 'typescript';
export type ContainerStatus = 'running' | 'stopped' | 'error' | 'not_cloned';
// 'git' (default, backward-compatible with configs predating this field) pulls code via
// gitService. 'upload' gets its code from a one-time or replaced .tar.gz archive and never
// touches git — no clone/pull/webhook-sync, even if the archive happens to contain a .git dir.
export type SourceType = 'git' | 'upload';

// Marker file dockerService touches inside the repo dir once buildCommand succeeds, so a
// preserveEnv run can skip reinstalling. Untracked, so gitService's post-pull `git clean -fd`
// must exclude it explicitly or every pull would wipe it and defeat the whole feature.
export const DEPS_SENTINEL = '.deps-installed';

export interface ScriptConfig {
  name: string;
  language: Language;
  sourceType?: SourceType;
  repo?: string;
  branch?: string;
  entryPoint: string;
  port?: number;
  env?: Record<string, string>;
  buildCommand?: string;   // optional pre-start step, e.g. "npm install && npm run build"
                           // when set, entryPoint is treated as the start command (e.g. "npm start")
  preserveEnv?: boolean;   // skip re-running buildCommand once it has succeeded, until buildCommand
                           // changes, "Update Deps" is triggered manually, or (for git-based scripts)
                           // the next pull brings in new commits — see dockerService.ts sentinel file
  repoToken?: string;      // GitHub Personal Access Token for private repos (stored, never logged)
  runMode: RunMode;
  schedule?: string;
  timezone?: string;
  createdAt: string;
  lastSync?: string;
  lastRun?: string;
  vpnEnabled?: boolean;
  vpnMssFix?: string;      // digits only, e.g. "1360" — OpenVPN --mssfix for this script's VPN sidecar,
                           // works around Path-MTU-Discovery blackholes on the tunnel (see MTU-VPN-DEBUGGING-PLAYBOOK.md)
  heartbeatEnabled?: boolean;
  heartbeatUrl?: string;   // dead-man's-switch monitor URL (e.g. Zenduty/Xurrent heartbeat check-in) —
                           // pinged (GET) after every run that exits 0; a failed run is never pinged, so
                           // the monitor's own missed-heartbeat timeout is what raises the alert
  heartbeatIntervalSec?: number; // persistent scripts only: also ping every N seconds while the
                           // container stays running, since a long-lived process may never exit
                           // on its own to trigger the on-exit ping above (min 30s)
}

export interface ScriptStatus {
  config: ScriptConfig;
  status: ContainerStatus;
  nextRun?: string | null;
}
