import { Router, Request, Response, NextFunction } from 'express';
import { getPositionService } from '../services';
import { AppError } from '../middleware';

const router = Router();
const positionService = getPositionService();

/**
 * GET /api/positions/:userId
 * Get all positions for a user
 */
router.get('/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { sync } = req.query;

    // Optionally sync first
    if (sync === 'true') {
      await positionService.syncPositions(userId);
    }

    const positions = await positionService.getPositions(userId);

    res.json({
      success: true,
      data: positions,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/positions/:userId/sync
 * Sync positions from Polymarket Data API
 */
router.post('/:userId/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const result = await positionService.syncPositions(userId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/positions/:userId/summary
 * Get positions summary for a user
 */
router.get('/:userId/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const summary = await positionService.getPositionsSummary(userId);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/positions/:userId/claimable
 * Get claimable (redeemable) positions
 */
router.get('/:userId/claimable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const claimable = await positionService.checkClaimable(userId);

    res.json({
      success: true,
      data: claimable,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/positions/:userId/claim/:positionId
 * Claim a single winning position
 */
router.post('/:userId/claim/:positionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, positionId } = req.params;

    const result = await positionService.claimPosition(userId, positionId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/positions/:userId/claim-all
 * Claim all winning positions
 */
router.post('/:userId/claim-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const result = await positionService.claimAllPositions(userId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export { router as positionRoutes };

