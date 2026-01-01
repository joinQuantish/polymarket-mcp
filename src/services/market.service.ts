import { config } from '../config';

export interface Market {
  conditionId: string;
  questionId?: string;
  question: string;
  slug?: string;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  // Gamma API returns token IDs as a JSON string
  clobTokenIds?: string;
  outcomePrices?: string;
  outcomes?: string;
  endDate: string;
  active: boolean;
  volume?: string;
  liquidity?: string;
  [key: string]: any;
}

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  spread: number;
  [key: string]: any;
}

/**
 * MarketService
 * 
 * Fetches market data from Polymarket APIs.
 * Uses the Gamma API for market info and CLOB API for order book data.
 */
export class MarketService {
  private gammaApiUrl = 'https://gamma-api.polymarket.com';
  private clobApiUrl = config.polymarket.clobApiUrl;

  /**
   * Get active markets
   */
  async getMarkets(options: {
    limit?: number;
    offset?: number;
    active?: boolean;
  } = {}): Promise<Market[]> {
    const { limit = 20, offset = 0, active = true } = options;

    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
      active: active.toString(),
      closed: 'false',
    });

    const response = await fetch(`${this.gammaApiUrl}/markets?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.statusText}`);
    }

    const data = await response.json() as Market[];
    return data;
  }

  /**
   * Get a specific market by condition ID
   */
  async getMarket(conditionId: string): Promise<Market | null> {
    // Try CLOB API first - it's more reliable for conditionId lookups
    try {
      const clobResponse = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
      if (clobResponse.ok) {
        const clobMarket = await clobResponse.json() as any;
        if (clobMarket && clobMarket.condition_id === conditionId) {
          // Convert CLOB format to our Market format
          const tokenIds = clobMarket.tokens?.map((t: any) => t.token_id) || [];
          const outcomes = clobMarket.tokens?.map((t: any) => t.outcome) || ['Yes', 'No'];
          return {
            conditionId: clobMarket.condition_id,
            question: clobMarket.question || '',
            slug: clobMarket.market_slug,
            clobTokenIds: JSON.stringify(tokenIds),
            outcomes: JSON.stringify(outcomes),
            endDate: clobMarket.end_date_iso || '',
            active: clobMarket.active || false,
            tokens: clobMarket.tokens,
          };
        }
      }
    } catch (e) {
      // CLOB API failed, fall back to Gamma
    }

    // Fallback to Gamma API - filter results to find exact match
    const params = new URLSearchParams({
      condition_id: conditionId,
    });
    
    const response = await fetch(`${this.gammaApiUrl}/markets?${params}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch market: ${response.statusText}`);
    }

    const markets = await response.json() as Market[];
    
    // Filter to find exact conditionId match (Gamma API doesn't filter properly)
    const exactMatch = markets.find(m => m.conditionId === conditionId);
    if (exactMatch) {
      return exactMatch;
    }
    
    // If no exact match, return null
    return null;
  }

  /**
   * Search markets by query - fetches markets and filters client-side
   * since Gamma API doesn't have native search
   */
  async searchMarkets(query: string, limit = 10): Promise<Market[]> {
    // Fetch a larger set of active markets
    const params = new URLSearchParams({
      limit: '100',  // Fetch more to filter
      active: 'true',
      closed: 'false',
    });

    const response = await fetch(`${this.gammaApiUrl}/markets?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to search markets: ${response.statusText}`);
    }

    const allMarkets = await response.json() as Market[];
    
    // Client-side search - filter by question containing query (case-insensitive)
    const queryLower = query.toLowerCase();
    const filtered = allMarkets.filter(m => 
      m.question && m.question.toLowerCase().includes(queryLower)
    );
    
    // Sort by volume if available, then limit
    const sorted = filtered.sort((a, b) => {
      const volA = parseFloat(a.volume || '0');
      const volB = parseFloat(b.volume || '0');
      return volB - volA;  // Descending by volume
    });
    
    return sorted.slice(0, limit);
  }

  /**
   * Get order book for a token
   */
  async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
    const response = await fetch(`${this.clobApiUrl}/book?token_id=${tokenId}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch order book: ${response.statusText}`);
    }

    const data = await response.json() as any;
    
    // Calculate spread
    const topBid = data.bids?.[0]?.price ? parseFloat(data.bids[0].price) : 0;
    const topAsk = data.asks?.[0]?.price ? parseFloat(data.asks[0].price) : 1;
    const spread = topAsk - topBid;

    return {
      market: data.market || '',
      asset_id: data.asset_id || '',
      bids: data.bids || [],
      asks: data.asks || [],
      spread,
    };
  }

  /**
   * Get midpoint price for a token
   */
  async getMidpointPrice(tokenId: string): Promise<number> {
    const response = await fetch(`${this.clobApiUrl}/midpoint?token_id=${tokenId}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch midpoint: ${response.statusText}`);
    }

    const data = await response.json() as any;
    return parseFloat(data.mid);
  }

  /**
   * Get price history for a token
   */
  async getPriceHistory(
    tokenId: string,
    options: {
      interval?: string;
      fidelity?: number;
    } = {}
  ): Promise<Array<{ t: number; p: number }>> {
    const { interval = '1d', fidelity = 60 } = options;

    const params = new URLSearchParams({
      market: tokenId,
      interval,
      fidelity: fidelity.toString(),
    });

    const response = await fetch(`${this.clobApiUrl}/prices-history?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch price history: ${response.statusText}`);
    }

    const data = await response.json() as any;
    return data.history || [];
  }

  /**
   * Get last trade price
   */
  async getLastTradePrice(tokenId: string): Promise<number | null> {
    const response = await fetch(`${this.clobApiUrl}/last-trade-price?token_id=${tokenId}`);
    
    if (!response.ok) {
      return null;
    }

    const data = await response.json() as any;
    return data.price ? parseFloat(data.price) : null;
  }

  /**
   * Get spread for a token
   */
  async getSpread(tokenId: string): Promise<{
    bid: number;
    ask: number;
    spread: number;
  }> {
    const response = await fetch(`${this.clobApiUrl}/spread?token_id=${tokenId}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch spread: ${response.statusText}`);
    }

    const data = await response.json() as any;
    return {
      bid: parseFloat(data.bid || '0'),
      ask: parseFloat(data.ask || '1'),
      spread: parseFloat(data.spread || '1'),
    };
  }

  /**
   * Get recent trades for a market
   */
  async getRecentTrades(
    conditionId: string,
    limit = 50
  ): Promise<Array<{
    price: string;
    size: string;
    side: string;
    timestamp: string;
  }>> {
    const params = new URLSearchParams({
      market: conditionId,
      limit: limit.toString(),
    });

    const response = await fetch(`${this.clobApiUrl}/trades?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch trades: ${response.statusText}`);
    }

    return await response.json() as Array<{
      price: string;
      size: string;
      side: string;
      timestamp: string;
    }>;
  }

  /**
   * Get CLOB server time (useful for timestamp sync)
   */
  async getServerTime(): Promise<number> {
    const response = await fetch(`${this.clobApiUrl}/time`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch server time: ${response.statusText}`);
    }

    const data = await response.json() as any;
    return data.time;
  }

  /**
   * Get token IDs for a market by condition ID
   * Used to convert conditionId to actual CLOB tokenIds
   */
  async getTokenIdsForMarket(conditionId: string): Promise<Array<{ tokenId: string; outcome: string }>> {
    const market = await this.getMarket(conditionId);
    if (!market) {
      return [];
    }
    
    try {
      const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
      const outcomes = JSON.parse(market.outcomes || '["Yes", "No"]') as string[];
      
      return tokenIds.map((tokenId, i) => ({
        tokenId,
        outcome: outcomes[i] || `Outcome ${i + 1}`,
      }));
    } catch {
      // Try tokens array format
      if (market.tokens) {
        return market.tokens.map(t => ({
          tokenId: t.token_id,
          outcome: t.outcome,
        }));
      }
      return [];
    }
  }

  /**
   * Check if a string looks like a conditionId (starts with 0x)
   */
  isConditionId(id: string): boolean {
    return id.startsWith('0x');
  }

  /**
   * Get prices for all outcomes in a market by conditionId
   * This is a convenience method that handles the conditionId -> tokenId mapping
   */
  async getPricesForMarket(conditionId: string): Promise<{
    conditionId: string;
    question?: string;
    prices: Array<{ outcome: string; tokenId: string; price: number }>;
  }> {
    const market = await this.getMarket(conditionId);
    if (!market) {
      throw new Error(`Market not found: ${conditionId}`);
    }

    const tokens = await this.getTokenIdsForMarket(conditionId);
    if (tokens.length === 0) {
      throw new Error(`No tokens found for market: ${conditionId}`);
    }

    const prices = await Promise.all(
      tokens.map(async (t) => {
        try {
          const price = await this.getMidpointPrice(t.tokenId);
          return { outcome: t.outcome, tokenId: t.tokenId, price };
        } catch {
          return { outcome: t.outcome, tokenId: t.tokenId, price: 0 };
        }
      })
    );

    return {
      conditionId,
      question: market.question,
      prices,
    };
  }

  /**
   * Get orderbooks for all outcomes in a market by conditionId
   */
  async getOrderBooksForMarket(conditionId: string): Promise<{
    conditionId: string;
    question?: string;
    orderbooks: Array<{ outcome: string; tokenId: string; orderbook: OrderBookSummary }>;
  }> {
    const market = await this.getMarket(conditionId);
    if (!market) {
      throw new Error(`Market not found: ${conditionId}`);
    }

    const tokens = await this.getTokenIdsForMarket(conditionId);
    if (tokens.length === 0) {
      throw new Error(`No tokens found for market: ${conditionId}`);
    }

    const orderbooks = await Promise.all(
      tokens.map(async (t) => {
        try {
          const orderbook = await this.getOrderBook(t.tokenId);
          return { outcome: t.outcome, tokenId: t.tokenId, orderbook };
        } catch {
          return { 
            outcome: t.outcome, 
            tokenId: t.tokenId, 
            orderbook: { market: '', asset_id: '', bids: [], asks: [], spread: 1 } 
          };
        }
      })
    );

    return {
      conditionId,
      question: market.question,
      orderbooks,
    };
  }
}

// Singleton instance
let marketServiceInstance: MarketService | null = null;

export function getMarketService(): MarketService {
  if (!marketServiceInstance) {
    marketServiceInstance = new MarketService();
  }
  return marketServiceInstance;
}
