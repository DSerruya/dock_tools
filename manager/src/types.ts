export type RunMode = 'persistent' | 'scheduled';
export type Language = 'python' | 'ruby' | 'node' | 'typescript';
export type ContainerStatus = 'running' | 'stopped' | 'error' | 'not_cloned';

export interface ScriptConfig {
  name: string;
  language: Language;
  repo: string;
  branch: string;
  entryPoint: string;
  port?: number;
  env?: Record<string, string>;
  buildCommand?: string;   // optional pre-start step, e.g. "npm install && npm run build"
                           // when set, entryPoint is treated as the start command (e.g. "npm start")
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
}

export interface ScriptStatus {
  config: ScriptConfig;
  status: ContainerStatus;
  nextRun?: string | null;
}
