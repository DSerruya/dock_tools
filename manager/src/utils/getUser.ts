import { Request } from 'express';
import { User } from '../services/userService';

export function getUser(req: Request): string {
  return ((req as any).currentUser as User | undefined)?.username ?? 'anonymous';
}

export function getCurrentUser(req: Request): User | undefined {
  return (req as any).currentUser as User | undefined;
}
