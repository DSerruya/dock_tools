import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT      = 'docker-support-env-v1';
const PREFIX    = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, SALT, 32);
}

// Encrypts plaintext using the WEBHOOK_SECRET as key material.
// Returns plaintext unchanged if WEBHOOK_SECRET is not set (graceful degradation).
// NOTE: changing WEBHOOK_SECRET makes previously encrypted values unreadable.
export function encrypt(plaintext: string): string {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || !plaintext) return plaintext;
  try {
    const key        = deriveKey(secret);
    const iv         = crypto.randomBytes(12);
    const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag    = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  } catch {
    return plaintext;
  }
}

// Decrypts a value produced by encrypt(). Passes plaintext values through
// unchanged for backward compatibility with configs written before encryption
// was introduced.
export function decrypt(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return '';
  try {
    const key        = deriveKey(secret);
    const combined   = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv         = combined.subarray(0, 12);
    const authTag    = combined.subarray(12, 28);
    const ciphertext = combined.subarray(28);
    const decipher   = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
