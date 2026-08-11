// Allowed language values that map to known Docker images
const ALLOWED_LANGUAGES = new Set(['python', 'ruby', 'node', 'typescript']);

// Backticks, $(...), ${...}, and process substitution are the primary shell
// injection vectors; block them while still allowing &&, ||, |, ;, redirects.
const SHELL_INJECTION_RE = /`|\$|<\(|>\(/;

// Repo must be HTTPS or SSH git URL
const REPO_RE = /^https?:\/\/.+|^git@.+/;

// Env variable names must be valid POSIX identifiers
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Heartbeat monitor URL (e.g. a Zenduty/Xurrent heartbeat check-in link)
const HEARTBEAT_URL_RE = /^https?:\/\/.+/;

export function validateLanguage(lang: string): string | null {
  if (!ALLOWED_LANGUAGES.has(lang))
    return `language must be one of: ${[...ALLOWED_LANGUAGES].join(', ')}`;
  return null;
}

export function validateRepo(repo: string): string | null {
  if (!REPO_RE.test(repo))
    return 'repo must be a valid https:// or git@ URL';
  return null;
}

export function validateShellCommand(value: string, field: string): string | null {
  if (SHELL_INJECTION_RE.test(value))
    return `${field} contains disallowed shell characters (backticks, $, <(), >())`;
  return null;
}

export function validateEnvKeys(env: Record<string, string>): string | null {
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_RE.test(key))
      return `env key "${key}" is invalid; keys must match [A-Za-z_][A-Za-z0-9_]*`;
  }
  return null;
}

export function validateHeartbeatUrl(url: string): string | null {
  if (!HEARTBEAT_URL_RE.test(url))
    return 'heartbeatUrl must be a valid http:// or https:// URL';
  return null;
}
