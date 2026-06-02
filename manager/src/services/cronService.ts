import * as nodeCron from 'node-cron';
import { parseExpression } from 'cron-parser';
import { ScriptConfig } from '../types';
import * as dockerService from './dockerService';
import * as configService from './configService';
import * as logService from './logService';

const jobs = new Map<string, nodeCron.ScheduledTask>();
const running = new Set<string>();

export function isValidExpression(expression: string): boolean {
  return nodeCron.validate(expression);
}

export function getNextRun(name: string): string | null {
  if (!jobs.has(name)) return null;
  const config = configService.get(name);
  if (!config?.schedule) return null;
  try {
    const interval = parseExpression(config.schedule, {
      tz: config.timezone || process.env.DEFAULT_TIMEZONE || 'UTC',
    });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

async function executeScript(config: ScriptConfig): Promise<void> {
  if (running.has(config.name)) {
    console.log(`[cron] Skipping ${config.name} — previous run still active`);
    return;
  }
  running.add(config.name);
  const runId = logService.createRun(config.name, config.language, config.runMode);
  try {
    console.log(`[cron] Starting ${config.name} (runId: ${runId})`);
    const result = await dockerService.runOnce(config, runId);
    logService.finishRun(runId, result.exitCode);
    const saved = configService.get(config.name);
    if (saved) configService.save({ ...saved, lastRun: new Date().toISOString() });
    console.log(`[cron] ${config.name} exited with code ${result.exitCode}`);
  } catch (err: any) {
    logService.markRunFailed(runId, err?.message);
    console.error(`[cron] ${config.name} error:`, err);
  } finally {
    running.delete(config.name);
  }
}

export function register(config: ScriptConfig): void {
  if (!config.schedule || !isValidExpression(config.schedule)) return;
  unregister(config.name);
  const task = nodeCron.schedule(
    config.schedule,
    () => { void executeScript(config); },
    {
      scheduled: true,
      timezone: config.timezone || process.env.DEFAULT_TIMEZONE || 'UTC',
    }
  );
  jobs.set(config.name, task);
  console.log(`[cron] Registered "${config.name}": ${config.schedule} (${config.timezone || 'UTC'})`);
}

export function unregister(name: string): void {
  const task = jobs.get(name);
  if (task) {
    task.stop();
    jobs.delete(name);
  }
}

export function reschedule(config: ScriptConfig): void {
  unregister(config.name);
  if (config.schedule) register(config);
}

export function initAll(configs: ScriptConfig[]): void {
  const scheduled = configs.filter(c => c.runMode === 'scheduled' && c.schedule);
  for (const config of scheduled) register(config);
  console.log(`[cron] Initialized ${scheduled.length} scheduled jobs`);
}

export function listActive(): Array<{ name: string; expression: string; nextRun: string | null }> {
  return Array.from(jobs.keys()).map(name => {
    const config = configService.get(name);
    return { name, expression: config?.schedule || '', nextRun: getNextRun(name) };
  });
}
