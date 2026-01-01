import { Router, Request, Response } from 'express';
import { getAccessCodeService } from '../services/accesscode.service';
import { getApiKeyService } from '../services/apikey.service';
import { getWalletService } from '../services/wallet.service';
import { prisma } from '../db';

const router = Router();
const accessCodeService = getAccessCodeService();
const apiKeyService = getApiKeyService();
const walletService = getWalletService();

/**
 * Admin Routes for SDK Management
 * 
 * All routes require x-admin-key header matching ADMIN_API_KEY env var
 * OR X-Admin-Secret header matching DISCOVERY_ADMIN_SECRET env var
 */

// Middleware to verify admin API key
const adminAuth = (req: Request, res: Response, next: Function) => {
  const adminKey = req.headers['x-admin-key'] as string;
  const adminSecret = req.headers['x-admin-secret'] as string;
  const expectedKey = process.env.ADMIN_API_KEY;
  const expectedSecret = process.env.DISCOVERY_ADMIN_SECRET;

  // Check if either x-admin-key or X-Admin-Secret is valid
  const isValidKey = expectedKey && adminKey && adminKey === expectedKey;
  const isValidSecret = expectedSecret && adminSecret && adminSecret === expectedSecret;

  if (!isValidKey && !isValidSecret) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }

  next();
};

// Apply admin auth to all routes
router.use(adminAuth);

/**
 * POST /admin/access-codes
 * Generate a new access code for a developer
 */
router.post('/access-codes', async (req: Request, res: Response) => {
  try {
    const { developerName, developerEmail, notes, maxUses, expiresInDays } = req.body;

    const result = await accessCodeService.createAccessCode({
      developerName,
      developerEmail,
      notes,
      maxUses: maxUses || 1,
      expiresInDays: expiresInDays || 30,
      createdBy: 'admin',
    });

    res.json({
      success: true,
      accessCode: result.code,
      id: result.id,
      expiresAt: result.expiresAt,
      maxUses: result.maxUses,
      message: 'Access code created. Share this with the developer.',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /admin/access-codes
 * List all access codes
 */
router.get('/access-codes', async (req: Request, res: Response) => {
  try {
    const codes = await accessCodeService.listAccessCodes();
    res.json({
      success: true,
      count: codes.length,
      accessCodes: codes,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /admin/access-codes/:codeOrId
 * Revoke an access code
 */
router.delete('/access-codes/:codeOrId', async (req: Request, res: Response) => {
  try {
    const { codeOrId } = req.params;
    const success = await accessCodeService.revokeAccessCode(codeOrId);
    
    if (success) {
      res.json({ success: true, message: 'Access code revoked' });
    } else {
      res.status(404).json({ error: 'Access code not found' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /admin/access-codes/bulk
 * Generate multiple access codes at once
 */
router.post('/access-codes/bulk', async (req: Request, res: Response) => {
  try {
    const { count, prefix, expiresInDays } = req.body;
    const numCodes = Math.min(count || 10, 100); // Max 100 at a time

    const codes = [];
    for (let i = 0; i < numCodes; i++) {
      const result = await accessCodeService.createAccessCode({
        developerName: prefix ? `${prefix}-${i + 1}` : undefined,
        expiresInDays: expiresInDays || 30,
        createdBy: 'admin-bulk',
      });
      codes.push(result.code);
    }

    res.json({
      success: true,
      count: codes.length,
      accessCodes: codes,
      message: `Generated ${codes.length} access codes`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /admin/generate-api-key
 * Generate an API key for a user by email (Discovery server)
 * This endpoint is used by the docs site to generate API keys without access codes
 */
router.post('/generate-api-key', async (req: Request, res: Response) => {
  try {
    const { email, name } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log(`[Admin] Generating API key for email: ${email}`);

    // Find or create user by externalId (email)
    let user = await prisma.user.findUnique({
      where: { externalId: email },
    });

    if (!user) {
      console.log(`[Admin] User not found, creating new user for: ${email}`);
      // Create new user (Discovery doesn't need wallet setup, but schema requires wallet)
      try {
        const result = await walletService.createUser(email);
        user = await prisma.user.findUnique({
          where: { id: result.userId },
        });
        console.log(`[Admin] User created successfully: ${result.userId}`);
      } catch (error: any) {
        console.error(`[Admin] Error creating user:`, error);
        // If user already exists (race condition), fetch it
        if (error.message?.includes('already exists')) {
          console.log(`[Admin] User already exists (race condition), fetching...`);
          user = await prisma.user.findUnique({
            where: { externalId: email },
          });
        } else {
          throw error;
        }
      }
    } else {
      console.log(`[Admin] User found: ${user.id}`);
    }

    // Double-check user exists after creation attempt
    if (!user) {
      // Final attempt to find user
      user = await prisma.user.findUnique({
        where: { externalId: email },
      });
    }

    if (!user) {
      console.error(`[Admin] Failed to create or find user for: ${email}`);
      return res.status(500).json({ error: 'Failed to create or find user' });
    }

    // Generate API key
    console.log(`[Admin] Generating API key for user: ${user.id}`);
    const keyResult = await apiKeyService.createApiKey(user.id, name || 'Docs Generated Key');
    console.log(`[Admin] API key generated successfully, prefix: ${keyResult.keyPrefix}`);

    // Return in the format expected by the Next.js route
    const response = {
      success: true,
      key: keyResult.apiKey,
      keyPrefix: keyResult.keyPrefix,
      name: name || 'Docs Generated Key',
      usage: {
        header: 'X-API-Key',
        example: `X-API-Key: ${keyResult.apiKey}`,
      },
    };

    res.json(response);
  } catch (error: any) {
    console.error('[Admin] Error generating API key:', error);
    res.status(500).json({ error: error.message || 'Failed to generate API key' });
  }
});

export { router as adminRoutes };
export default router;
