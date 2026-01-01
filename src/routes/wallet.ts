import { Router, Request, Response, NextFunction } from 'express';
import { getWalletService, getKeyService } from '../services';
import { prisma } from '../db';
import { AppError } from '../middleware';

const router = Router();
const walletService = getWalletService();
const keyService = getKeyService();

/**
 * POST /api/wallet/create
 * Create a new wallet for a user - combines user creation + full setup
 * This is the endpoint the mobile app expects
 * 
 * Body: { externalId: string }
 * Returns: { userId, eoaAddress, safeAddress, status }
 */
router.post('/create', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.body;

    if (!externalId) {
      throw new AppError('externalId is required', 400);
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { externalId },
    });

    if (existingUser) {
      // User exists - check if fully set up
      if (existingUser.safeDeployed && existingUser.safeAddress) {
        return res.json({
          success: true,
          data: {
            userId: existingUser.id,
            eoaAddress: existingUser.eoaAddress,
            safeAddress: existingUser.safeAddress,
            status: existingUser.status,
            message: 'Wallet already exists and is ready.',
          },
        });
      } else {
        // User exists but not fully set up - complete setup
        const result = await walletService.fullSetup(existingUser.id);
        return res.json({
          success: true,
          data: {
            userId: existingUser.id,
            eoaAddress: existingUser.eoaAddress,
            safeAddress: result.safeAddress,
            status: result.status,
            message: 'Wallet setup completed.',
          },
        });
      }
    }

    // Create new user with wallet
    const createResult = await walletService.createUser(externalId);
    
    // Immediately do full setup (deploy Safe, set approvals, create credentials)
    const setupResult = await walletService.fullSetup(createResult.userId);

    res.status(201).json({
      success: true,
      data: {
        userId: createResult.userId,
        eoaAddress: createResult.eoaAddress,
        safeAddress: setupResult.safeAddress,
        status: setupResult.status,
        message: 'Wallet created and fully set up. Ready to trade.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/wallet/status
 * Get wallet status by externalId
 */
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.query;

    if (!externalId || typeof externalId !== 'string') {
      throw new AppError('externalId query parameter is required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { externalId },
    });

    if (!user) {
      return res.json({
        exists: false,
        message: 'No wallet found for this user. Call POST /api/wallet/create first.',
      });
    }

    const status = await walletService.getUserStatus(user.id);

    res.json({
      success: true,
      data: {
        exists: true,
        userId: user.id,
        ...status,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/wallet/balances
 * Get wallet balances by externalId
 */
router.get('/balances', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.query;

    if (!externalId || typeof externalId !== 'string') {
      throw new AppError('externalId query parameter is required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { externalId },
      select: { eoaAddress: true, safeAddress: true },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const eoaBalance = await keyService.getBalance(user.eoaAddress);
    const eoaUsdc = await keyService.getUsdcBalance(user.eoaAddress);

    let safeBalance = '0';
    let safeUsdc = '0';

    if (user.safeAddress) {
      safeBalance = await keyService.getBalance(user.safeAddress);
      safeUsdc = await keyService.getUsdcBalance(user.safeAddress);
    }

    res.json({
      success: true,
      data: {
        eoa: {
          address: user.eoaAddress,
          matic: eoaBalance,
          usdc: eoaUsdc,
        },
        safe: user.safeAddress ? {
          address: user.safeAddress,
          matic: safeBalance,
          usdc: safeUsdc,
        } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

export { router as walletRoutes };

