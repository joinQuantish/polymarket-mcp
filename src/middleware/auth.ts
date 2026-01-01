import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

// Extend Express Request to include auth info
declare global {
  namespace Express {
    interface Request {
      isAdmin?: boolean;
      apiKey?: string;
    }
  }
}

/**
 * API Key authentication middleware
 * Validates the x-api-key header against expected keys
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required',
    });
    return;
  }

  // Check if it's an admin key
  if (apiKey === config.admin.apiKey) {
    req.isAdmin = true;
    req.apiKey = apiKey;
    next();
    return;
  }

  // For now, we accept any API key for regular access
  // In production, you'd validate against a database of keys
  req.isAdmin = false;
  req.apiKey = apiKey;
  next();
}

/**
 * Admin-only authentication middleware
 */
export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAdmin) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
    return;
  }
  next();
}

/**
 * Optional auth - doesn't require authentication but parses it if present
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string;

  if (apiKey) {
    req.isAdmin = apiKey === config.admin.apiKey;
    req.apiKey = apiKey;
  }

  next();
}

