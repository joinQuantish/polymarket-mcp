import { ethers } from 'ethers';
import { ClobClient, Side } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getKeyService } from './key.service';
import { getWalletService } from './wallet.service';
import { getProvider } from './provider.service';
import { prisma } from '../db';
import { config } from '../config';
import { OrderSide, OrderStatus, OrderType } from '@prisma/client';

// Signature types from Polymarket docs:
// 0 = EOA (direct wallet signing)
// 1 = POLY_PROXY (Email/Magic login - Polymarket's OWN proxy contract)
// 2 = POLY_GNOSIS_SAFE (Gnosis Safe wallet - deployed via relayer)
//
// We deploy Gnosis Safe via Polymarket relayer, so we need type 2
// Even though users login via Privy (email), the wallet is a Gnosis Safe
const SIGNATURE_TYPE_POLY_PROXY = 2 as any;

/**
 * FIX: We use an axios interceptor (in src/index.ts) to replace the POLY_ADDRESS header
 * with the Safe address. The EOA -> Safe mapping is registered via registerEoaToSafeMapping().
 * 
 * The CLOB library uses signer.getAddress() for BOTH:
 * 1. POLY_ADDRESS header (needs Safe address for balance checks) - FIXED by interceptor
 * 2. Order.signer field (needs EOA address for signature verification) - correctly uses EOA
 */

// Helper to register EOA -> Safe mapping for axios interceptor
async function registerEoaToSafeMapping(eoaAddress: string, safeAddress: string): Promise<void> {
  try {
    const { eoaToSafeMap } = await import('../index');
    eoaToSafeMap.set(eoaAddress.toLowerCase(), safeAddress.toLowerCase());
    console.log(`[Order] Registered EOA->Safe mapping: ${eoaAddress.slice(0, 10)}... → ${safeAddress.slice(0, 10)}...`);
  } catch (e) {
    // Silently fail if import fails (shouldn't happen in production)
    console.warn('[Order] Could not register EOA->Safe mapping:', e);
  }
}

// Cache for market neg risk status (keyed by conditionId)
const marketNegRiskCache = new Map<string, boolean>();

/**
 * Detect if a market is a negative risk market
 * Neg risk markets use different exchange contracts
 * 
 * @param conditionId - The market condition ID
 * @param tokenId - The token ID (used for Gamma API lookup)
 */
async function isNegRiskMarket(conditionId: string, tokenId?: string): Promise<boolean> {
  // Check cache first
  if (marketNegRiskCache.has(conditionId)) {
    return marketNegRiskCache.get(conditionId)!;
  }

  try {
    // CLOB API is most reliable - query by conditionId
    const clobResponse = await fetch(
      `https://clob.polymarket.com/markets/${conditionId}`
    );
    
    if (clobResponse.ok) {
      const clobMarket = await clobResponse.json() as any;
      const isNegRisk = clobMarket?.neg_risk === true;
      console.log(`Market ${conditionId.slice(0, 10)}... neg_risk (from CLOB): ${isNegRisk}`);
      marketNegRiskCache.set(conditionId, isNegRisk);
      return isNegRisk;
    }

    // Fallback: try Gamma API with tokenId if provided
    if (tokenId) {
      const response = await fetch(
        `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`
      );
      
      if (response.ok) {
        const markets = await response.json() as any[];
        if (Array.isArray(markets) && markets.length > 0) {
          const market = markets[0] as any;
          const isNegRisk = market.negRisk === true || market.neg_risk === true;
          
          console.log(`Market ${conditionId.slice(0, 10)}... neg_risk (from Gamma): ${isNegRisk}`);
          marketNegRiskCache.set(conditionId, isNegRisk);
          return isNegRisk;
        }
      }
    }
  } catch (error) {
    console.error('Error detecting neg risk market:', error);
  }
  
  // Default to false if we can't determine
  console.log(`Market ${conditionId.slice(0, 10)}... neg_risk: false (default)`);
  marketNegRiskCache.set(conditionId, false);
  return false;
}

// Get builder config instance
function getBuilderConfig(): BuilderConfig | undefined {
  if (config.builder.apiKey && config.builder.secret && config.builder.passphrase) {
    return new BuilderConfig({
      localBuilderCreds: {
        key: config.builder.apiKey,
        secret: config.builder.secret,
        passphrase: config.builder.passphrase,
      },
    });
  }
  console.warn('Builder credentials not configured - orders will not be attributed');
  return undefined;
}

// Check if builder is configured
function hasBuilderConfig(): boolean {
  return !!(config.builder.apiKey && config.builder.secret && config.builder.passphrase);
}

export interface CreateOrderParams {
  userId: string;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType?: 'LIMIT' | 'MARKET' | 'GTC' | 'GTD' | 'FOK' | 'FAK';
  expiration?: number; // Unix timestamp for GTD orders
}

export interface OrderResult {
  orderId: string;
  clobOrderId?: string;
  status: OrderStatus;
  message?: string;
}

/**
 * OrderService
 * 
 * Handles order creation, submission, and management through the Polymarket CLOB.
 */
export class OrderService {
  private keyService = getKeyService();
  private walletService = getWalletService();
  private provider: ethers.providers.JsonRpcProvider;

  constructor() {
    this.provider = getProvider(); // Use shared provider with retry logic
  }

  /**
   * Map our order types to CLOB order types
   */
  private mapOrderType(orderType: string): string {
    switch (orderType) {
      case 'GTC':
      case 'LIMIT':
        return 'GTC';
      case 'GTD':
        return 'GTD';
      case 'FOK':
        return 'FOK';
      case 'FAK':
        return 'FAK';
      case 'MARKET':
        return 'FOK'; // Market orders are essentially FOK
      default:
        return 'GTC';
    }
  }

  /**
   * Create and submit an order to the CLOB
   */
  async createOrder(params: CreateOrderParams): Promise<OrderResult> {
    const { userId, conditionId, tokenId, side, price, size, orderType = 'GTC', expiration } = params;

    // Validate price
    if (price < 0.01 || price > 0.99) {
      throw new Error('Price must be between 0.01 and 0.99');
    }

    // Validate size
    if (size <= 0) {
      throw new Error('Size must be positive');
    }

    // Validate GTD orders have expiration
    if (orderType === 'GTD' && !expiration) {
      throw new Error('GTD orders require an expiration timestamp');
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (user.status !== 'READY') {
      throw new Error(`User not ready for trading. Current status: ${user.status}`);
    }

    if (!user.safeAddress) {
      throw new Error('Safe wallet not deployed');
    }

    // Map order type to CLOB type
    const clobOrderType = this.mapOrderType(orderType);

    // Create order record
    const order = await prisma.order.create({
      data: {
        userId,
        conditionId,
        tokenId,
        side: side as OrderSide,
        price,
        size,
        orderType: orderType as OrderType,
        expiration: expiration ? new Date(expiration * 1000) : null,
        status: OrderStatus.PENDING,
      },
    });

    try {
      // Update status to submitting
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.SUBMITTING },
      });

      // Get user's wallet and credentials
      const wallet = await this.keyService.getUserWallet(userId);
      const credentials = await this.keyService.getApiCredentials(userId);

      // DEBUG: Log credential details (not the actual values for security)
      console.log('Credentials check:');
      console.log('  key length:', credentials.key?.length);
      console.log('  secret length:', credentials.secret?.length);
      console.log('  passphrase length:', credentials.passphrase?.length);
      console.log('  secret first 10 chars:', credentials.secret?.substring(0, 10));
      console.log('  secret last 5 chars:', credentials.secret?.slice(-5));
      
      // Note: Secret may be URL-safe base64 (with '-' and '_') which is valid
      // The CLOB client library handles this internally

      // Get builder config for order attribution
      const builderConfig = getBuilderConfig();

      // Detect if this is a neg risk market
      // This is CRITICAL - using wrong exchange contract causes "not enough balance" errors
      let isNegRisk = await isNegRiskMarket(conditionId, tokenId);
      console.log(`Market ${conditionId.slice(0, 10)}... detected as neg_risk: ${isNegRisk}`);

      // Build order options
      const orderOptions: any = {
        tokenID: tokenId,
        price,
        size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
      };

      // Add expiration for GTD orders
      if (clobOrderType === 'GTD' && expiration) {
        orderOptions.expiration = expiration;
      }

      // Helper function to attempt order with specific negRisk flag
      const attemptOrder = async (negRiskFlag: boolean): Promise<{ clobOrder: any; response: any }> => {
        console.log(`Attempting order with negRisk=${negRiskFlag}`);
        
        // CRITICAL: Register EOA -> Safe mapping for axios interceptor
        await registerEoaToSafeMapping(wallet.address, user.safeAddress!);
        
        const client = new ClobClient(
          config.polymarket.clobApiUrl,
          config.polygon.chainId,
          wallet,
          credentials,
          SIGNATURE_TYPE_POLY_PROXY,
          user.safeAddress!,  // We already checked safeAddress exists above
          undefined,      // feeRateBps
          negRiskFlag,    // negRisk - use detected value
          builderConfig   // Builder attribution
        );

        const createdOrder = await client.createOrder(orderOptions);
        console.log('CLOB order created successfully with negRisk:', negRiskFlag);
        
        const orderResponse = await client.postOrder(createdOrder, clobOrderType as any) as any;
        
        // CRITICAL: Check if response contains an error and throw it
        // The CLOB client returns errors in the response body, not as exceptions
        // We need to throw here so the retry logic in the catch block works
        if (orderResponse?.error || orderResponse?.status === 400 || orderResponse?.status === 422) {
          const errorMsg = orderResponse.error || orderResponse.message || 'Order rejected';
          console.error('CLOB postOrder returned error:', errorMsg);
          const error = new Error(errorMsg) as any;
          error.response = { data: orderResponse };
          throw error;
        }
        
        return { clobOrder: createdOrder, response: orderResponse };
      };

      console.log('Creating order for user:', userId, 'type:', clobOrderType);

      let response;
      let clobOrder;
      
      try {
        // First attempt with detected neg risk value
        const result = await attemptOrder(isNegRisk);
        clobOrder = result.clobOrder;
        response = result.response;
        console.log('CLOB postOrder response:', JSON.stringify(response, null, 2));
      } catch (firstError: any) {
        const errorDetail = firstError?.response?.data || firstError?.message || firstError?.toString() || '';
        const errorMsg = typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail;
        
        console.error('First order attempt failed:', errorMsg);
        
        // Check for specific errors that shouldn't be retried
        if (errorMsg.includes('Invalid character') || errorMsg.includes('base64')) {
          throw new Error(`Order signing failed (credentials may be corrupted): ${errorMsg}. Try calling reset_credentials.`);
        }
        if (errorMsg.includes('INVALID_SIGNATURE')) {
          throw new Error(`Invalid signature - credentials may be corrupted. Try reset_credentials.`);
        }
        if (errorMsg.includes('MIN_TICK_SIZE') || errorMsg.includes('tick')) {
          throw new Error(`Price does not meet minimum tick size requirements: ${errorMsg}`);
        }
        
        // If we get balance/allowance error, try with opposite negRisk flag
        // This handles cases where market detection was wrong
        if (errorMsg.includes('balance') || errorMsg.includes('allowance') || 
            errorMsg.includes('INSUFFICIENT') || errorMsg.includes('not enough')) {
          console.log(`Balance/allowance error detected. Retrying with negRisk=${!isNegRisk}...`);
          
          try {
            const retryResult = await attemptOrder(!isNegRisk);
            clobOrder = retryResult.clobOrder;
            response = retryResult.response;
            console.log('Retry succeeded with opposite negRisk flag!');
            
            // Update cache with correct value
            marketNegRiskCache.set(conditionId, !isNegRisk);
          } catch (retryError: any) {
            const retryDetail = retryError?.response?.data || retryError?.message || retryError?.toString() || '';
            const retryMsg = typeof retryDetail === 'object' ? JSON.stringify(retryDetail) : retryDetail;
            
            console.error('Retry also failed:', retryMsg);
            
            // Both attempts failed - throw more helpful error
            throw new Error(
              `Order failed with both exchange contracts. ` +
              `Original error: ${errorMsg}. ` +
              `This usually means insufficient USDC balance in your Safe wallet. ` +
              `Please ensure you have enough USDC deposited.`
            );
          }
        } else {
          // Non-balance error, just throw it
          throw new Error(`Polymarket rejected order: ${errorMsg}`);
        }
      }
      
      // Log response for debugging
      console.log('CLOB postOrder completed successfully');

      // Cast to any to handle varying response types
      const clobResponse = response as any;

      // Extract CLOB order ID - Polymarket uses 'orderID' in response
      const clobOrderId = clobResponse.orderID || clobResponse.orderId || clobResponse.id || null;
      
      console.log('Extracted clobOrderId:', clobOrderId);
      
      // SAFEGUARD: Only mark as LIVE if we have a valid CLOB order ID
      // This prevents false positives
      if (!clobOrderId) {
        console.error('CRITICAL: No CLOB order ID returned - marking as FAILED');
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.FAILED,
            statusMessage: 'No order ID returned from Polymarket - order may not have been placed',
          },
        });
        throw new Error('Order submission failed - no order ID received from Polymarket');
      }

      // Update order with CLOB response - ONLY if we have valid clobOrderId
      await prisma.order.update({
        where: { id: order.id },
        data: {
          clobOrderId: clobOrderId,
          status: OrderStatus.LIVE,
          submittedAt: new Date(),
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'ORDER_CREATED',
          resource: 'order',
          resourceId: order.id,
          details: {
            side,
            price,
            size,
            tokenId,
            clobOrderId: clobOrderId,
            fullResponse: clobResponse,
          },
        },
      });

      return {
        orderId: order.id,
        clobOrderId: clobOrderId,
        status: OrderStatus.LIVE,
      };
    } catch (error) {
      // Update order status to failed
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.FAILED,
          statusMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      // Log failure
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'ORDER_FAILED',
          resource: 'order',
          resourceId: order.id,
          success: false,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      throw error;
    }
  }

  /**
   * Verify an order's status directly from Polymarket CLOB
   * This is a failsafe to confirm orders are real
   */
  async verifyOrder(orderId: string): Promise<{
    localStatus: OrderStatus;
    clobStatus: string | null;
    verified: boolean;
    hasClobId: boolean;
    isReal: boolean;
    details: any;
  }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true },
    });

    if (!order) {
      throw new Error('Order not found');
    }

    const result: {
      localStatus: OrderStatus;
      clobStatus: string | null;
      verified: boolean;
      hasClobId: boolean;
      isReal: boolean;
      details: any;
    } = {
      localStatus: order.status,
      clobStatus: null,
      verified: false,
      hasClobId: !!order.clobOrderId,
      isReal: false,
      details: {
        orderId: order.id,
        clobOrderId: order.clobOrderId,
        side: order.side,
        price: order.price,
        size: order.size,
        createdAt: order.createdAt,
      },
    };

    // If no CLOB ID, order was never truly placed
    if (!order.clobOrderId) {
      result.verified = true;
      result.isReal = false;
      result.clobStatus = 'NEVER_PLACED';
      return result;
    }

    try {
      const wallet = await this.keyService.getUserWallet(order.userId);
      const credentials = await this.keyService.getApiCredentials(order.userId);
      const builderConfig = getBuilderConfig();
      const clobClient = new ClobClient(
        config.polymarket.clobApiUrl,
        config.polygon.chainId,
        wallet,
        credentials,
        SIGNATURE_TYPE_POLY_PROXY,
        order.user.safeAddress!,
        undefined,
        false,
        builderConfig
      );

      // Try to get order from CLOB
      const clobOrder = await clobClient.getOrder(order.clobOrderId);
      
      if (clobOrder) {
        result.clobStatus = (clobOrder as any).status || (clobOrder as any).state || 'FOUND';
        result.verified = true;
        result.isReal = true;
        result.details = {
          ...result.details,
          clobData: clobOrder,
        };
      } else {
        result.clobStatus = 'NOT_FOUND';
        result.verified = true;
        result.isReal = false;
      }
    } catch (error) {
      // If we get an error, the order might have been cancelled/filled and removed
      result.clobStatus = 'QUERY_FAILED';
      result.verified = false;
      result.details = {
        ...result.details,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    return result;
  }

  /**
   * Cancel an order
   * Supports both local order ID and CLOB order ID
   */
  async cancelOrder(userId: string, orderId: string): Promise<OrderResult> {
    // Try to find by local ID first, then by CLOB order ID
    let order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true },
    });

    // If not found by local ID, try CLOB order ID
    if (!order) {
      order = await prisma.order.findUnique({
        where: { clobOrderId: orderId },
        include: { user: true },
      });
    }

    if (!order) {
      throw new Error(`Order not found. Tried both local ID and CLOB order ID: ${orderId}`);
    }

    if (order.userId !== userId) {
      throw new Error('Order does not belong to user');
    }

    if (!order.clobOrderId) {
      throw new Error('Order has no CLOB ID');
    }

    if (order.status !== OrderStatus.LIVE) {
      throw new Error(`Cannot cancel order with status: ${order.status}`);
    }

    try {
      const wallet = await this.keyService.getUserWallet(userId);
      const credentials = await this.keyService.getApiCredentials(userId);
      const builderConfig = getBuilderConfig();
      const clobClient = new ClobClient(
        config.polymarket.clobApiUrl,
        config.polygon.chainId,
        wallet,
        credentials,
        SIGNATURE_TYPE_POLY_PROXY,
        order.user.safeAddress!,
        undefined,
        false,
        builderConfig
      );

      // First, check the actual order status from Polymarket
      let actualStatus: string = 'UNKNOWN';
      let sizeMatched: number = 0;
      
      try {
        const clobOrder = await clobClient.getOrder(order.clobOrderId);
        if (clobOrder) {
          actualStatus = (clobOrder as any).status || (clobOrder as any).state || 'UNKNOWN';
          sizeMatched = parseFloat((clobOrder as any).size_matched || (clobOrder as any).sizeMatched || '0');
          console.log(`Order ${order.clobOrderId} actual status: ${actualStatus}, filled: ${sizeMatched}`);
        }
      } catch (e) {
        console.log('Could not fetch order status from CLOB:', e);
      }

      // If order already filled, don't try to cancel - just update our status
      if (actualStatus === 'MATCHED' || actualStatus === 'FILLED' || sizeMatched >= order.size) {
          await prisma.order.update({
            where: { id: order.id },  // Use order.id, not orderId (which might be CLOB ID)
            data: {
              status: OrderStatus.FILLED,
              filledAt: new Date(),
              filledSize: sizeMatched,
            },
          });
        
        return {
          orderId: order.id,
          clobOrderId: order.clobOrderId,
          status: OrderStatus.FILLED,
          message: 'Order already filled',
        };
      }

      // Try to cancel the order
      try {
        await clobClient.cancelOrder({ orderID: order.clobOrderId });
      } catch (cancelError: any) {
        // If cancel fails, order might have filled in the meantime
        console.log('Cancel error:', cancelError?.message);
      }

      // Check status again after cancel attempt
      let finalStatus: OrderStatus = OrderStatus.CANCELLED;
      try {
        const clobOrderAfter = await clobClient.getOrder(order.clobOrderId);
        if (clobOrderAfter) {
          const statusAfter = (clobOrderAfter as any).status || '';
          const matchedAfter = parseFloat((clobOrderAfter as any).size_matched || '0');
          
          if (statusAfter === 'MATCHED' || statusAfter === 'FILLED' || matchedAfter >= order.size) {
            finalStatus = OrderStatus.FILLED;
          } else if (matchedAfter > 0) {
            // Partially filled then cancelled
            finalStatus = OrderStatus.CANCELLED;
            // Store how much was filled
            await prisma.order.update({
              where: { id: order.id },  // Use order.id, not orderId
              data: { filledSize: matchedAfter },
            });
          }
        }
      } catch (e) {
        // Order might be gone from CLOB (cancelled successfully)
      }

      // Update order status
      await prisma.order.update({
        where: { id: order.id },  // Use order.id, not orderId
        data: {
          status: finalStatus,
          cancelledAt: finalStatus === OrderStatus.CANCELLED ? new Date() : undefined,
          filledAt: finalStatus === OrderStatus.FILLED ? new Date() : undefined,
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'ORDER_CANCELLED',
          resource: 'order',
          resourceId: order.id,  // Use order.id
        },
      });

      return {
        orderId: order.id,  // Return the local DB ID
        clobOrderId: order.clobOrderId,
        status: OrderStatus.CANCELLED,
      };
    } catch (error) {
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'ORDER_CANCEL_FAILED',
          resource: 'order',
          resourceId: order?.id || orderId,  // Use order.id if available
          success: false,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      throw error;
    }
  }

  /**
   * Cancel all orders for a user
   */
  async cancelAllOrders(userId: string): Promise<{ cancelled: number }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or not setup');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    const credentials = await this.keyService.getApiCredentials(userId);
    const builderConfig = getBuilderConfig();
    const clobClient = new ClobClient(
      config.polymarket.clobApiUrl,
      config.polygon.chainId,
      wallet,
      credentials,
      SIGNATURE_TYPE_POLY_PROXY,
      user.safeAddress,
      undefined,
      false,
      builderConfig
    );

    // Cancel all via CLOB
    await clobClient.cancelAll();

    // Update all live orders in database
    const result = await prisma.order.updateMany({
      where: {
        userId,
        status: OrderStatus.LIVE,
      },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'ALL_ORDERS_CANCELLED',
        resource: 'order',
        details: { cancelledCount: result.count },
      },
    });

    return { cancelled: result.count };
  }

  /**
   * Get order by ID
   */
  async getOrder(orderId: string): Promise<any> {
    return prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: {
          select: {
            externalId: true,
            eoaAddress: true,
            safeAddress: true,
          },
        },
      },
    });
  }

  /**
   * Get all orders for a user
   */
  async getUserOrders(
    userId: string,
    options: {
      status?: OrderStatus;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<any[]> {
    const { status, limit = 50, offset = 0 } = options;

    return prisma.order.findMany({
      where: {
        userId,
        ...(status && { status }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Sync order status from CLOB
   */
  async syncOrderStatus(orderId: string): Promise<OrderResult> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true },
    });

    if (!order || !order.clobOrderId) {
      throw new Error('Order not found or has no CLOB ID');
    }

    const wallet = await this.keyService.getUserWallet(order.userId);
    const credentials = await this.keyService.getApiCredentials(order.userId);
    const builderConfig = getBuilderConfig();
    const clobClient = new ClobClient(
      config.polymarket.clobApiUrl,
      config.polygon.chainId,
      wallet,
      credentials,
      SIGNATURE_TYPE_POLY_PROXY,
      order.user.safeAddress!,
      undefined,
      false,
      builderConfig
    );

    // Get order from CLOB - cast to any since library types may vary
    const clobOrder: any = await clobClient.getOrder(order.clobOrderId);

    // Map CLOB status to our status
    let newStatus = order.status;
    if (clobOrder) {
      // Update based on CLOB response
      // The exact field names depend on CLOB client response
      const sizeMatched = clobOrder.size_matched || clobOrder.sizeMatched || 0;
      const originalSize = clobOrder.original_size || clobOrder.originalSize || 0;
      const avgFillPrice = clobOrder.avg_fill_price || clobOrder.avgFillPrice || null;
      
      if (clobOrder.status === 'FILLED' || sizeMatched === originalSize) {
        newStatus = OrderStatus.FILLED;
      } else if (clobOrder.status === 'CANCELLED') {
        newStatus = OrderStatus.CANCELLED;
      } else if (sizeMatched > 0) {
        newStatus = OrderStatus.MATCHED;
      }

      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          filledSize: Number(sizeMatched) || order.filledSize,
          avgFillPrice: avgFillPrice ? Number(avgFillPrice) : order.avgFillPrice,
          ...(newStatus === OrderStatus.FILLED && { filledAt: new Date() }),
        },
      });
    }

    return {
      orderId: order.id,
      clobOrderId: order.clobOrderId,
      status: newStatus,
    };
  }

  /**
   * Sync all orders for a user from Polymarket CLOB
   * This updates our database with the actual status from Polymarket
   */
  async syncAllUserOrders(userId: string): Promise<{
    synced: number;
    updated: number;
    results: Array<{ orderId: string; oldStatus: string; newStatus: string; filled: number }>;
  }> {
    // Get all orders with CLOB IDs that might need syncing
    const orders = await prisma.order.findMany({
      where: {
        userId,
        clobOrderId: { not: null },
        status: { in: [OrderStatus.LIVE, OrderStatus.PENDING, OrderStatus.SUBMITTING, OrderStatus.MATCHED] },
      },
      include: { user: true },
    });

    if (orders.length === 0) {
      return { synced: 0, updated: 0, results: [] };
    }

    const user = orders[0].user;
    const wallet = await this.keyService.getUserWallet(userId);
    const credentials = await this.keyService.getApiCredentials(userId);
    const builderConfig = getBuilderConfig();
    const clobClient = new ClobClient(
      config.polymarket.clobApiUrl,
      config.polygon.chainId,
      wallet,
      credentials,
      SIGNATURE_TYPE_POLY_PROXY,
      user.safeAddress!,
      undefined,
      false,
      builderConfig
    );

    const results: Array<{ orderId: string; oldStatus: string; newStatus: string; filled: number }> = [];
    let updated = 0;

    for (const order of orders) {
      if (!order.clobOrderId) continue;
      
      const oldStatus = order.status;
      
      try {
        const clobOrder: any = await clobClient.getOrder(order.clobOrderId);
        
        if (clobOrder) {
          const sizeMatched = parseFloat(clobOrder.size_matched || clobOrder.sizeMatched || '0');
          const clobStatus = clobOrder.status || clobOrder.state || '';
          
          let newStatus = order.status;
          
          if (clobStatus === 'MATCHED' || clobStatus === 'FILLED' || sizeMatched >= order.size) {
            newStatus = OrderStatus.FILLED;
          } else if (clobStatus === 'CANCELED' || clobStatus === 'CANCELLED') {
            newStatus = sizeMatched > 0 ? OrderStatus.MATCHED : OrderStatus.CANCELLED;
          } else if (sizeMatched > 0) {
            newStatus = OrderStatus.MATCHED;
          } else if (clobStatus === 'LIVE' || clobStatus === 'OPEN') {
            newStatus = OrderStatus.LIVE;
          }

          if (newStatus !== oldStatus || sizeMatched !== order.filledSize) {
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: newStatus,
                filledSize: sizeMatched,
                ...(newStatus === OrderStatus.FILLED && { filledAt: new Date() }),
              },
            });
            updated++;
          }

          results.push({
            orderId: order.id,
            oldStatus: oldStatus,
            newStatus: newStatus,
            filled: sizeMatched,
          });
        } else {
          // Order not found in CLOB - might be cancelled or filled and removed
          results.push({
            orderId: order.id,
            oldStatus: oldStatus,
            newStatus: 'NOT_FOUND_IN_CLOB',
            filled: order.filledSize,
          });
        }
      } catch (e) {
        console.log(`Error syncing order ${order.id}:`, e);
        results.push({
          orderId: order.id,
          oldStatus: oldStatus,
          newStatus: 'SYNC_ERROR',
          filled: order.filledSize,
        });
      }
    }

    return {
      synced: orders.length,
      updated,
      results,
    };
  }
}

// Singleton instance
let orderServiceInstance: OrderService | null = null;

export function getOrderService(): OrderService {
  if (!orderServiceInstance) {
    orderServiceInstance = new OrderService();
  }
  return orderServiceInstance;
}

