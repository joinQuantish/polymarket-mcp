import { Router, Request, Response, NextFunction } from 'express';
import { getMarketService } from '../services';
import { AppError } from '../middleware';

const router = Router();
const marketService = getMarketService();

/**
 * GET /api/markets
 * Get list of markets
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit, offset, active } = req.query;

    const markets = await marketService.getMarkets({
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
      active: active === 'false' ? false : true,
    });

    res.json({
      success: true,
      data: markets,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/search
 * Search markets by query
 */
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit } = req.query;

    if (!q) {
      throw new AppError('Query parameter q is required', 400);
    }

    const markets = await marketService.searchMarkets(
      q as string,
      limit ? parseInt(limit as string) : undefined
    );

    res.json({
      success: true,
      data: markets,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/:conditionId
 * Get a specific market
 */
router.get('/:conditionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { conditionId } = req.params;

    const market = await marketService.getMarket(conditionId);

    if (!market) {
      throw new AppError('Market not found', 404);
    }

    res.json({
      success: true,
      data: market,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/token/:tokenId/orderbook
 * Get order book for a token
 */
router.get('/token/:tokenId/orderbook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tokenId } = req.params;

    const orderbook = await marketService.getOrderBook(tokenId);

    res.json({
      success: true,
      data: orderbook,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/token/:tokenId/price
 * Get midpoint price for a token
 */
router.get('/token/:tokenId/price', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tokenId } = req.params;

    const price = await marketService.getMidpointPrice(tokenId);

    res.json({
      success: true,
      data: { price },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/token/:tokenId/spread
 * Get spread for a token
 */
router.get('/token/:tokenId/spread', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tokenId } = req.params;

    const spread = await marketService.getSpread(tokenId);

    res.json({
      success: true,
      data: spread,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/token/:tokenId/history
 * Get price history for a token
 */
router.get('/token/:tokenId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tokenId } = req.params;
    const { interval, fidelity } = req.query;

    const history = await marketService.getPriceHistory(tokenId, {
      interval: interval as string,
      fidelity: fidelity ? parseInt(fidelity as string) : undefined,
    });

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/:conditionId/trades
 * Get recent trades for a market
 */
router.get('/:conditionId/trades', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { conditionId } = req.params;
    const { limit } = req.query;

    const trades = await marketService.getRecentTrades(
      conditionId,
      limit ? parseInt(limit as string) : undefined
    );

    res.json({
      success: true,
      data: trades,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/markets/time
 * Get CLOB server time
 */
router.get('/server/time', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const time = await marketService.getServerTime();

    res.json({
      success: true,
      data: { time },
    });
  } catch (error) {
    next(error);
  }
});

export { router as marketRoutes };

