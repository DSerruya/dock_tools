import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/userService';

// ── In-memory brute-force protection ────────────────────────────────────────
const RATE_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const RATE_MAX        = 20;              // max failures per window per IP
const authFailures    = new Map<string, { count: number; windowStart: number }>();

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const rec = authFailures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > RATE_WINDOW_MS) { authFailures.delete(ip); return false; }
  return rec.count >= RATE_MAX;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = authFailures.get(ip);
  if (!rec || now - rec.windowStart > RATE_WINDOW_MS) {
    authFailures.set(ip, { count: 1, windowStart: now });
  } else {
    rec.count++;
  }
}

function clearFailures(ip: string): void { authFailures.delete(ip); }

// ── Attach the authenticated user to every request ───────────────────────────
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const users = userService.listUsers();

  // Open mode: no users configured — treat caller as anonymous admin.
  // WARNING: this means the UI is publicly accessible without a password.
  // Set UI_PASSWORD in your .env file to enable authentication.
  if (users.length === 0) {
    res.setHeader('X-Open-Mode-Warning', 'no-authentication-configured');
    (req as any).currentUser = { username: 'anonymous', role: 'admin' } as userService.User;
    return next();
  }

  const ip = clientIp(req);

  if (isRateLimited(ip)) {
    res.status(429).end('Too Many Requests — try again later');
    return;
  }

  const header = req.headers['authorization'];
  if (!header?.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Script Manager"');
    res.status(401).end('Unauthorized');
    return;
  }

  const decoded  = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);

  const user = await userService.authenticate(username, password);
  if (!user) {
    recordFailure(ip);
    res.setHeader('WWW-Authenticate', 'Basic realm="Script Manager"');
    res.status(401).end('Unauthorized');
    return;
  }

  clearFailures(ip);
  (req as any).currentUser = user;
  next();
}

// ── Role guard — use as per-route middleware ──────────────────────────────────
export function requireRole(...roles: userService.Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).currentUser as userService.User | undefined;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: `This action requires one of: ${roles.join(', ')}` });
      return;
    }
    next();
  };
}
