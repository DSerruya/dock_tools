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
  setupCommand?: string;   // optional OS-level setup (e.g. "apt-get install -y git"), run once as a
                           // Docker image layer on top of the base language image, before buildCommand.
                           // Cached by content hash (see dockerService.ts buildSetupImage) rather than
                           // the /app sentinel — buildCommand's cache model doesn't apply here because
                           // OS packages install outside /app and would otherwise vanish every time the
                           // container is recreated, sentinel or not.
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

// Narrow, structural interface gitService.ts's git operations accept — both ScriptConfig and
// PlatformAppConfig satisfy it as-is, so no adapter/mapping is needed at the call sites.
export interface GitSource {
  name: string;
  repo?: string;
  branch?: string;
  repoToken?: string;
}

// A k8s-deployed "platform app" — the less-sandboxed sibling of ScriptConfig for apps that need
// docker.sock, a persistent data volume, or a fixed host port (e.g. utility-tools-hub), none of
// which ScriptConfig's dockerService.ts ever grants a plain script. Kept as a separate type
// rather than new ScriptConfig fields so that elevated access stays an explicit, visible opt-in
// per app instead of something bolted onto the sandboxed-by-default script model.
export interface PlatformAppConfig {
  name: string;
  repo: string;
  branch: string;
  repoToken?: string;
  containerPort: number;      // port the app listens on inside its container
  hostPort?: number;          // published on the k8s node via the pod's hostPort — same
                               // "any host port" flexibility ScriptConfig's PortBindings give
                               // plain scripts, since k3s's NodePort range can't cover arbitrary
                               // ports like 9002
  env?: Record<string, string>;
  needsDockerSock?: boolean;  // mount /var/run/docker.sock — only for apps that must drive
                               // sibling containers (e.g. utility-tools-hub's onboarding runner)
  needsDataVolume?: boolean;  // mount a persistent hostPath at /app/data
  createdAt: string;
  lastSync?: string;
}

export type PlatformAppRuntimeStatus = 'running' | 'stopped' | 'error' | 'not_deployed';

export interface PlatformAppStatus {
  config: PlatformAppConfig;
  status: PlatformAppRuntimeStatus;
}
