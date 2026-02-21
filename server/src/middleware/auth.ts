import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { safeCompare } from '../utils/crypto.js';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  if (!token || !safeCompare(token, config.authToken)) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  next();
}
