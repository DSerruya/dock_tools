import * as fs from 'fs';
import * as path from 'path';
import { ScriptConfig } from '../types';
import * as configService from './configService';
import * as userService   from './userService';
import * as auditService  from './auditService';
import * as gitService    from './gitService';
import * as dockerService from './dockerService';
import * as cronService   from './cronService';
import * as logService    from './logService';
import { encrypt, decrypt } from './encryptionService';

const DATA_DIR   = process.env.DATA_DIR || '/app/scripts-data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');

const ADMIN_VPN_DIR    = path.join(DATA_DIR, 'admin-vpn');
const ADMIN_VPN_CONFIG = path.join(ADMIN_VPN_DIR, 'config.ovpn');
const SQLT_VPN_DIR     = path.join(DATA_DIR, 'sql-test-vpn');
const SQLT_VPN_CONFIG  = path.join(SQLT_VPN_DIR, 'config.ovpn');

const BUNDLE_VERSION = 1;

export interface BackupBundle {
  version: number;
  createdAt: string;
  scripts: ScriptConfig[];
  users: userService.User[];
  audit: auditService.AuditEntry[];
  adminVpnConfig?: string;
  sqlTestVpnConfig?: string;
}

export interface RestoreSummary {
  scripts: number;
  users: number;
  vpnConfigsRestored: number;
}

function readVpnConfig(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

export function buildBundle(): BackupBundle {
  return {
    version:          BUNDLE_VERSION,
    createdAt:        new Date().toISOString(),
    scripts:          configService.loadAll(),
    users:            userService.listUsers(),
    audit:            auditService.list(),
    adminVpnConfig:   readVpnConfig(ADMIN_VPN_CONFIG),
    sqlTestVpnConfig: readVpnConfig(SQLT_VPN_CONFIG),
  };
}

export function encryptBundle(bundle: BackupBundle): string {
  if (!process.env.WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET is not configured — set it before creating a backup, so the file can be encrypted.');
  }
  return encrypt(JSON.stringify(bundle));
}

export function decryptBundle(raw: string): BackupBundle {
  if (!process.env.WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET is not configured — it is required to decrypt a backup file.');
  }
  if (!raw.startsWith('enc:v1:')) {
    throw new Error('Not a valid backup file (missing encryption header).');
  }
  const json = decrypt(raw);
  if (!json) {
    throw new Error('Could not decrypt this backup — WEBHOOK_SECRET does not match the one it was created with.');
  }

  let bundle: BackupBundle;
  try { bundle = JSON.parse(json); }
  catch { throw new Error('Backup content is not valid JSON after decryption.'); }

  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.scripts) || !Array.isArray(bundle.users)) {
    throw new Error('Backup file is missing required fields (scripts/users).');
  }
  return bundle;
}

export async function restoreBundle(bundle: BackupBundle, actor: string): Promise<RestoreSummary> {
  const currentConfigs = configService.loadAll();
  const keptNames      = new Set(bundle.scripts.map(c => c.name));

  // Tear down anything currently on this instance that the backup doesn't have,
  // mirroring the existing DELETE /api/scripts/:name route.
  for (const config of currentConfigs) {
    if (keptNames.has(config.name)) continue;
    cronService.unregister(config.name);
    await dockerService.removeContainer(config.name, config.vpnEnabled).catch(() => {});
  }

  configService.replaceAll(bundle.scripts);
  userService.replaceAll(bundle.users);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(bundle.audit || [], null, 2));
  auditService.record(actor, 'environment.restored', '-', [
    { field: 'scripts', newValue: bundle.scripts.length },
    { field: 'users',   newValue: bundle.users.length },
  ]);

  let vpnConfigsRestored = 0;
  if (bundle.adminVpnConfig) {
    fs.mkdirSync(ADMIN_VPN_DIR, { recursive: true });
    fs.writeFileSync(ADMIN_VPN_CONFIG, bundle.adminVpnConfig);
    vpnConfigsRestored++;
  } else if (fs.existsSync(ADMIN_VPN_CONFIG)) {
    fs.unlinkSync(ADMIN_VPN_CONFIG);
  }
  if (bundle.sqlTestVpnConfig) {
    fs.mkdirSync(SQLT_VPN_DIR, { recursive: true });
    fs.writeFileSync(SQLT_VPN_CONFIG, bundle.sqlTestVpnConfig);
    vpnConfigsRestored++;
  } else if (fs.existsSync(SQLT_VPN_CONFIG)) {
    fs.unlinkSync(SQLT_VPN_CONFIG);
  }

  // Re-provision every script from the restored config — mirrors the
  // post-create setImmediate block in scripts.ts / import.ts exactly:
  // clone/pull always comes first, since a scheduled script's cron job
  // still needs the repo on disk before it can ever run.
  for (const config of bundle.scripts) {
    try {
      await gitService.cloneOrPull(config);
      configService.save({ ...config, lastSync: new Date().toISOString() });
      if (config.runMode === 'persistent') {
        const runId = logService.createRun(config.name, config.language, config.runMode);
        await dockerService.start(config, runId);
      } else if (config.runMode === 'scheduled' && config.schedule) {
        cronService.register(config);
      }
    } catch (err) {
      console.error(`[restore] ${config.name}:`, err);
    }
  }

  return {
    scripts: bundle.scripts.length,
    users:   bundle.users.length,
    vpnConfigsRestored,
  };
}
