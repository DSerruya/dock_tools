import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type Role = 'admin' | 'agent' | 'viewer';

export interface User {
  username: string;
  passwordHash: string;
  salt: string;
  role: Role;
  createdAt: string;
}

const DATA_DIR   = process.env.DATA_DIR || '/app/scripts-data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export function listUsers(): User[] {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users: User[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise<string>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
  return { hash, salt };
}

async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const inputHash = await new Promise<string>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
  try {
    return crypto.timingSafeEqual(Buffer.from(inputHash, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

export async function authenticate(username: string, password: string): Promise<User | null> {
  const user = listUsers().find(u => u.username === username);
  if (!user) return null;
  const valid = await verifyPassword(password, user.passwordHash, user.salt);
  return valid ? user : null;
}

export async function createUser(username: string, password: string, role: Role): Promise<User> {
  const users = listUsers();
  if (users.find(u => u.username === username))
    throw new Error(`User "${username}" already exists`);
  const { hash, salt } = await hashPassword(password);
  const user: User = { username, passwordHash: hash, salt, role, createdAt: new Date().toISOString() };
  saveUsers([...users, user]);
  return user;
}

export async function updateUser(
  username: string,
  updates: { role?: Role; password?: string },
): Promise<User> {
  const users = listUsers();
  const idx   = users.findIndex(u => u.username === username);
  if (idx < 0) throw new Error(`User "${username}" not found`);

  if (updates.role && updates.role !== users[idx].role) {
    if (users[idx].role === 'admin') {
      const adminCount = users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) throw new Error('Cannot demote the last admin');
    }
    users[idx].role = updates.role;
  }
  if (updates.password) {
    const { hash, salt } = await hashPassword(updates.password);
    users[idx].passwordHash = hash;
    users[idx].salt = salt;
  }
  saveUsers(users);
  return users[idx];
}

export function deleteUser(username: string, requestingUser: string): void {
  const users = listUsers();
  const user  = users.find(u => u.username === username);
  if (!user)             throw new Error(`User "${username}" not found`);
  if (username === requestingUser) throw new Error('Cannot delete yourself');
  if (user.role === 'admin') {
    const adminCount = users.filter(u => u.role === 'admin').length;
    if (adminCount <= 1) throw new Error('Cannot delete the last admin');
  }
  saveUsers(users.filter(u => u.username !== username));
}

// Called on startup: if no users exist, seed from env vars
export async function initializeFromEnv(): Promise<void> {
  if (listUsers().length > 0) return;
  const username = process.env.UI_USERNAME || 'admin';
  const password = process.env.UI_PASSWORD || '';
  if (!password) {
    console.log('[auth] No UI_PASSWORD set — running without authentication (open mode)');
    return;
  }
  await createUser(username, password, 'admin');
  console.log(`[auth] Created initial admin user: "${username}"`);
}
