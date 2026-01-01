import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';

const router = Router();

// Discovery MCP endpoint
const DISCOVERY_URL = config.quantish?.discoveryUrl || 'https://quantish.live/mcp';
const DISCOVERY_EXECUTE_URL = `${DISCOVERY_URL}/execute`;

// Use environment variable or config
const DISCOVERY_API_KEY = config.quantish?.discoveryKey || process.env.QUANTISH_DISCOVERY_KEY || '';

interface DiscoveryMarket {
  platform: string;
  id: string;
  title: string;
  markets: Array<{
    marketId: string;
    question: string;
    outcomes: Array<{ name: string; price: number; probability: string }>;
    endDate: string;
    clobTokenIds: string;
    conditionId: string;
    slug: string;
    outcomePrices: string;
    active: boolean;
    closed: boolean;
  }>;
  liquidity: string;
  volume: string;
}

/**
 * Helper to call the Discovery MCP
 */
async function callDiscovery(toolName: string, args: Record<string, any>): Promise<any> {
  const response = await fetch(DISCOVERY_EXECUTE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': DISCOVERY_API_KEY
    },
    body: JSON.stringify({
      name: toolName,
      arguments: args
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discovery API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as any;
  
  // Handle MCP response format
  if (data.content && Array.isArray(data.content)) {
    const textContent = data.content.find((c: any) => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text);
    }
  }
  
  return data;
}

/**
 * GET /api/search
 * Search markets with semantic/embedding search
 * 
 * Query params:
 * - q: Search query (required)
 * - platform: "polymarket", "kalshi", or "all" (default: "all")
 * - category: Category filter (optional)
 * - limit: Max results 1-20 (default: 10)
 * - sort: "relevance", "soonest", "latest" (default: "relevance")
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, platform, category, limit, sort } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter "q" is required'
      });
    }

    const result = await callDiscovery('search_markets', {
      query: q as string,
      platform: (platform as string) || 'all',
      category: category as string,
      limit: limit ? parseInt(limit as string) : 10,
      sortBy: (sort as string) || 'relevance'
    });

    res.json({
      success: true,
      query: q,
      platform: platform || 'all',
      data: result
    });
  } catch (error) {
    console.error('Search error:', error);
    next(error);
  }
});

/**
 * GET /api/search/trending
 * Get trending markets by volume
 * 
 * Query params:
 * - platform: "polymarket", "kalshi", or "all" (default: "all")
 * - category: Category filter (default: "POLITICS")
 * - limit: Max results 1-10 (default: 5)
 */
router.get('/trending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform, category, limit } = req.query;

    const result = await callDiscovery('get_trending_markets', {
      platform: (platform as string) || 'all',
      category: (category as string) || undefined,
      limit: limit ? parseInt(limit as string) : 5
    });

    res.json({
      success: true,
      platform: platform || 'all',
      data: result
    });
  } catch (error) {
    console.error('Trending error:', error);
    next(error);
  }
});

/**
 * GET /api/search/market/:platform/:marketId
 * Get detailed info about a specific market
 */
router.get('/market/:platform/:marketId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform, marketId } = req.params;

    const result = await callDiscovery('get_market_details', {
      platform,
      marketId
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Market details error:', error);
    next(error);
  }
});

/**
 * GET /api/search/categories
 * Get available market categories
 */
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await callDiscovery('get_categories', {});

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Categories error:', error);
    next(error);
  }
});

/**
 * GET /api/search/stats
 * Get aggregate statistics about prediction markets database
 */
router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await callDiscovery('get_market_stats', {});

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Stats error:', error);
    next(error);
  }
});

/**
 * GET /api/search/status
 * Check the status of the semantic search system
 */
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await callDiscovery('get_search_status', {});

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Status error:', error);
    next(error);
  }
});

/**
 * POST /api/search
 * Alternative POST endpoint for complex searches
 * 
 * Body: { query, platform?, category?, limit?, sortBy? }
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query, platform, category, limit, sortBy } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    const result = await callDiscovery('search_markets', {
      query,
      platform: platform || 'all',
      category,
      limit: limit || 10,
      sortBy: sortBy || 'relevance'
    });

    res.json({
      success: true,
      query,
      platform: platform || 'all',
      data: result
    });
  } catch (error) {
    console.error('Search error:', error);
    next(error);
  }
});

export { router as searchRoutes };


