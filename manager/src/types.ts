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
  runMode: RunMode;
  schedule?: string;
  timezone?: string;
  createdAt: string;
  lastSync?: string;
  lastRun?: string;
}

export interface ScriptStatus {
  config: ScriptConfig;
  status: ContainerStatus;
  nextRun?: string | null;
}
