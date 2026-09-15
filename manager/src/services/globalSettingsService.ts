import * as fs from 'fs';
import * as path from 'path';
import { encrypt, decrypt } from './encryptionService';

const DATA_DIR = process.env.DATA_DIR || '/app/scripts-data';
const SETTINGS_FILE = path.join(DATA_DIR, 'global-settings.json');

// Single JSON blob for settings that apply across every Script/Platform App rather than to one
// of them — mirrors uiHealthCheckService.ts's own-file pattern rather than living inside
// scripts.json/platform-apps.json, since these values aren't per-entity.
interface GlobalSettings {
  fallbackGithubToken?: string; // encrypted at rest, same convention as ScriptConfig.repoToken
}

function load(): GlobalSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persist(settings: GlobalSettings): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Used by gitService as a last resort when a Script/Platform App has no repoToken of its own —
// decrypted here so gitService never has to know about the encryption layer.
export function getFallbackGithubToken(): string | undefined {
  const token = load().fallbackGithubToken;
  if (!token) return undefined;
  return decrypt(token) || undefined;
}

export function isFallbackGithubTokenConfigured(): boolean {
  return !!load().fallbackGithubToken;
}

export function setFallbackGithubToken(token: string | undefined): void {
  const settings = load();
  if (token) {
    settings.fallbackGithubToken = encrypt(token);
  } else {
    delete settings.fallbackGithubToken;
  }
  persist(settings);
}
