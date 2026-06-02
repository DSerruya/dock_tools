import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/userService';

// ── Attach the authenticated user to every request ───────────────────────────
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const users = userService.listUsers();

  // Open mode: no users configured — treat caller as anonymous admin
  if (users.length === 0) {
    (req as any).currentUser = { username: 'anonymous', role: 'admin' } as userService.User;
    return next();
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
    res.setHeader('WWW-Authenticate', 'Basic realm="Script Manager"');
    res.status(401).end('Unauthorized');
    return;
  }

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
