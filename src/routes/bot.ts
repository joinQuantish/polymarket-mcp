import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { getApiKeyService } from '../services/apikey.service';
import { AppError } from '../middleware';

const router = Router();
const apiKeyService = getApiKeyService();

/**
 * POST /api/bot/credentials
 * Get or create credentials for a bot/mobile app
 * 
 * This endpoint is used by mobile apps to get the API key for a user.
 * Since API keys are hashed and can't be recovered, this will issue
 * a NEW API key for the mobile app (users can have multiple keys).
 * 
 * Body: { externalId: string }
 * Returns: { hasPolymarketCredentials, polymarketEoaAddress, safeAddress, mcpApiKey, mcpApiSecret }
 */
router.post('/credentials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.body;

    if (!externalId) {
      throw new AppError('externalId is required', 400);
    }

    // Find the user
    const user = await prisma.user.findUnique({
      where: { externalId },
      include: {
        apiKeys: {
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!user) {
      // User doesn't exist
      return res.json({
        hasPolymarketCredentials: false,
        polymarketEoaAddress: null,
        safeAddress: null,
        mcpApiKey: null,
        message: 'User not found. Call request_api_key first to create a wallet.'
      });
    }

    // Check if user is fully set up
    const isSetup = user.status === 'READY' && user.safeDeployed && user.safeAddress;

    // Generate a new API key for the mobile app
    // (We can't recover the original key since it's hashed)
    const keyResult = await apiKeyService.createApiKey(user.id, 'Mobile App');

    // Log this credential fetch
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'BOT_CREDENTIALS_ISSUED',
        resource: 'api_key',
        resourceId: keyResult.keyId,
        details: {
          keyPrefix: keyResult.keyPrefix,
          source: 'mobile_app',
        },
      },
    });

    res.json({
      hasPolymarketCredentials: isSetup,
      polymarketEoaAddress: user.eoaAddress,
      safeAddress: user.safeAddress,
      mcpApiKey: keyResult.apiKey,
      mcpApiSecret: keyResult.apiSecret,
      status: user.status,
      message: isSetup 
        ? 'Credentials issued successfully. Save the API key - it cannot be recovered.'
        : 'User exists but wallet setup is not complete. Call setup_wallet to complete setup.'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/bot/credentials/:externalId
 * Check if a user has credentials (without issuing new ones)
 */
router.get('/credentials/:externalId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.params;

    const user = await prisma.user.findUnique({
      where: { externalId },
      include: {
        apiKeys: {
          where: { isActive: true },
          select: {
            id: true,
            keyPrefix: true,
            name: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      return res.json({
        exists: false,
        hasPolymarketCredentials: false,
      });
    }

    res.json({
      exists: true,
      hasPolymarketCredentials: user.status === 'READY' && user.safeDeployed,
      polymarketEoaAddress: user.eoaAddress,
      safeAddress: user.safeAddress,
      status: user.status,
      activeKeyCount: user.apiKeys.length,
      // Show key prefixes so they know keys exist (but not the actual keys)
      apiKeyPrefixes: user.apiKeys.map(k => k.keyPrefix),
    });
  } catch (error) {
    next(error);
  }
});

export { router as botRoutes };




