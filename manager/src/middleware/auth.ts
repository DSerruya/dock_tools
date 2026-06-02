import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

// Pads both buffers to the same fixed length so timingSafeEqual
// never leaks information about string length differences.
function safeEqual(a: string, b: string): boolean {
  const len = 512;
  const aBuf = Buffer.alloc(len);
  const bBuf = Buffer.alloc(len);
  aBuf.write(a, 'utf8');
  bBuf.write(b, 'utf8');
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const password = process.env.UI_PASSWORD;

  // Auth is disabled when no password is configured (dev / first-run)
  if (!password) {
    next();
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
  const inputPwd = decoded.slice(colonIdx + 1);

  const expectedUser = process.env.UI_USERNAME || 'admin';

  if (safeEqual(username, expectedUser) && safeEqual(inputPwd, password)) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Script Manager"');
    res.status(401).end('Unauthorized');
  }
}
