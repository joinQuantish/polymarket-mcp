import { Router, Request, Response, NextFunction } from 'express';
import { getWalletService, getKeyService } from '../services';
import { prisma } from '../db';
import { AppError } from '../middleware';

const router = Router();
const walletService = getWalletService();
const keyService = getKeyService();

/**
 * POST /api/users
 * Create a new user with generated wallet
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.body;

    if (!externalId) {
      throw new AppError('externalId is required', 400);
    }

    const result = await walletService.createUser(externalId);

    res.status(201).json({
      success: true,
      data: {
        userId: result.userId,
        eoaAddress: result.eoaAddress,
        message: 'User created. Call POST /api/users/:userId/setup to deploy Safe and create credentials.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/by-external/:externalId
 * Look up a user by their external ID (e.g., Privy DID, device ID)
 */
router.get('/by-external/:externalId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.params;

    const user = await prisma.user.findUnique({
      where: { externalId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      success: true,
      data: {
        userId: user.id,
        externalId: user.externalId,
        eoaAddress: user.eoaAddress,
        safeAddress: user.safeAddress,
        safeDeployed: user.safeDeployed,
        status: user.status,
        hasApiCredentials: !!user.encryptedApiKey,
        approvalsSet: {
          usdc: user.usdcApproved,
          ctf: user.ctfApproved,
          negRisk: user.negRiskApproved,
        },
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/setup
 * Full setup: deploy Safe wallet and create API credentials
 */
router.post('/:userId/setup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const result = await walletService.fullSetup(userId);

    res.json({
      success: true,
      data: {
        safeAddress: result.safeAddress,
        status: result.status,
        message: 'User fully setup and ready to trade.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/deploy-safe
 * Deploy Safe wallet only
 */
router.post('/:userId/deploy-safe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const safeAddress = await walletService.deploySafeWallet(userId);

    res.json({
      success: true,
      data: {
        safeAddress,
        message: 'Safe wallet deployed.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/recover-safe
 * Recover/sync Safe address for cases where deployment succeeded but DB wasn't updated
 * Useful when deployment timed out but Safe was actually deployed
 */
router.post('/:userId/recover-safe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { knownSafeAddress } = req.body;

    const safeAddress = await walletService.recoverSafeAddress(userId, knownSafeAddress);

    if (safeAddress) {
      res.json({
        success: true,
        data: {
          safeAddress,
          message: 'Safe address recovered and database updated. You can now continue with setup.',
        },
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Could not find or verify Safe address on-chain. The Safe may not have been deployed yet.',
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/sync
 * Sync user's wallet state from on-chain
 * Use when database is out of sync with on-chain state (e.g., Safe deployed but DB doesn't know)
 */
router.post('/:userId/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { continueSetup } = req.body; // If true, also set approvals and create credentials

    const result = await walletService.syncWalletState(userId, continueSetup);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/import
 * Alias for /sync - imports/syncs existing Safe wallet from on-chain
 */
router.post('/:userId/import', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { continueSetup } = req.body;

    const result = await walletService.syncWalletState(userId, continueSetup);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/create-credentials
 * Create CLOB API credentials
 */
router.post('/:userId/create-credentials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    await walletService.createApiCredentials(userId);

    res.json({
      success: true,
      data: {
        message: 'API credentials created.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/reset-credentials
 * Reset and regenerate CLOB API credentials
 * Use when existing credentials are corrupted or need refresh
 */
router.post('/:userId/reset-credentials', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    await walletService.resetApiCredentials(userId);

    res.json({
      success: true,
      data: {
        message: 'CLOB API credentials have been reset and regenerated.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/set-approvals
 * Set token approvals for trading (USDC, CTF, Neg Risk)
 * Query param: force=true to re-approve even if already set
 */
router.post('/:userId/set-approvals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const force = req.query.force === 'true' || req.body.force === true;

    await walletService.setTokenApprovals(userId, force);

    res.json({
      success: true,
      data: {
        message: force ? 'Token approvals re-set successfully (forced).' : 'Token approvals set successfully.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/sync-balance
 * Force Polymarket CLOB to re-sync balance/allowance data
 * Use when orders fail with "not enough balance" but on-chain data is correct
 */
router.post('/:userId/sync-balance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const result = await walletService.syncBalanceWithClob(userId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/:userId/verify-approvals
 * Verify that all required token approvals are in place
 */
router.get('/:userId/verify-approvals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const approvals = await walletService.verifyApprovals(userId);

    res.json({
      success: true,
      data: {
        ...approvals,
        message: approvals.allApproved 
          ? 'All approvals are in place.' 
          : 'Some approvals are missing. Call POST /api/users/:userId/set-approvals to set them.',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/:userId
 * Get user details and status
 */
router.get('/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const status = await walletService.getUserStatus(userId);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/external/:externalId
 * Get user by external ID
 */
router.get('/external/:externalId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { externalId } = req.params;

    const user = await prisma.user.findUnique({
      where: { externalId },
      select: {
        id: true,
        externalId: true,
        eoaAddress: true,
        safeAddress: true,
        status: true,
        safeDeployed: true,
        usdcApproved: true,
        ctfApproved: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/:userId/balances
 * Get user's wallet balances
 */
router.get('/:userId/balances', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
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

/**
 * GET /api/users
 * List all users (admin)
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = '50', offset = '0', status } = req.query;

    const users = await prisma.user.findMany({
      where: status ? { status: status as any } : undefined,
      select: {
        id: true,
        externalId: true,
        eoaAddress: true,
        safeAddress: true,
        status: true,
        safeDeployed: true,
        createdAt: true,
        _count: {
          select: { orders: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    const total = await prisma.user.count();

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          total,
          limit: parseInt(limit as string),
          offset: parseInt(offset as string),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:userId/transfer-shares
 * Transfer ERC-1155 shares to another address
 */
router.post('/:userId/transfer-shares', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { tokenId, toAddress, amount } = req.body;

    if (!tokenId) {
      res.status(400).json({ error: 'tokenId is required' });
      return;
    }
    if (!toAddress) {
      res.status(400).json({ error: 'toAddress is required' });
      return;
    }
    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }

    const result = await walletService.transferShares(userId, tokenId, toAddress, amount);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export { router as userRoutes };

