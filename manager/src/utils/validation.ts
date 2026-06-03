// Allowed language values that map to known Docker images
const ALLOWED_LANGUAGES = new Set(['python', 'ruby', 'node', 'typescript']);

// Backticks, $(...), ${...}, and process substitution are the primary shell
// injection vectors; block them while still allowing &&, ||, |, ;, redirects.
const SHELL_INJECTION_RE = /`|\$|<\(|>\(/;

// Repo must be HTTPS or SSH git URL
const REPO_RE = /^https?:\/\/.+|^git@.+/;

// Env variable names must be valid POSIX identifiers
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
