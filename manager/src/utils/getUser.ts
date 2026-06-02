import { Request } from 'express';

export function getUser(req: Request): string {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Basic ')) return 'anonymous';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.split(':')[0] || 'anonymous';
  } catch {
    return 'anonymous';
  }
}
