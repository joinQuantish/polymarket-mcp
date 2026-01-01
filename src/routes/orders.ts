import { Router, Request, Response, NextFunction } from 'express';
import { getOrderService, getKeyService, getWalletService, getApiKeyService } from '../services';
import { AppError } from '../middleware';
import { prisma } from '../db';
import { config } from '../config';
import { ClobClient, Side } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const router = Router();
const orderService = getOrderService();
const apiKeyService = getApiKeyService();

// Signature type for Safe wallets
const SIGNATURE_TYPE_POLY_PROXY = 2 as any;

/**
 * POST /api/orders
 * Create and submit a new order
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, conditionId, tokenId, side, price, size, orderType, expiration } = req.body;

    // Validate required fields
    if (!userId) throw new AppError('userId is required', 400);
    if (!conditionId) throw new AppError('conditionId is required', 400);
    if (!tokenId) throw new AppError('tokenId is required', 400);
    if (!side || !['BUY', 'SELL'].includes(side)) {
      throw new AppError('side must be BUY or SELL', 400);
    }
    if (price === undefined || typeof price !== 'number') {
      throw new AppError('price is required and must be a number', 400);
    }
    if (size === undefined || typeof size !== 'number' || size <= 0) {
      throw new AppError('size is required and must be a positive number', 400);
    }
    
    // Validate order type
    const validOrderTypes = ['LIMIT', 'MARKET', 'GTC', 'GTD', 'FOK', 'FAK'];
    if (orderType && !validOrderTypes.includes(orderType)) {
      throw new AppError(`orderType must be one of: ${validOrderTypes.join(', ')}`, 400);
    }
    
    // Validate GTD has expiration
    if (orderType === 'GTD' && !expiration) {
      throw new AppError('GTD orders require an expiration timestamp', 400);
    }

    const result = await orderService.createOrder({
      userId,
      conditionId,
      tokenId,
      side,
      price,
      size,
      orderType,
      expiration,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/orders/:orderId
 * Get order by ID
 */
router.get('/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId } = req.params;

    const order = await orderService.getOrder(orderId);

    if (!order) {
      throw new AppError('Order not found', 404);
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/orders/user/:userId
 * Get all orders for a user
 */
router.get('/user/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { status, limit, offset } = req.query;

    const orders = await orderService.getUserOrders(userId, {
      status: status as any,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/orders/:orderId
 * Cancel an order
 */
router.delete('/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      throw new AppError('userId is required in body', 400);
    }

    const result = await orderService.cancelOrder(userId, orderId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/:orderId/cancel
 * Alternative cancel endpoint
 */
router.post('/:orderId/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      throw new AppError('userId is required in body', 400);
    }

    const result = await orderService.cancelOrder(userId, orderId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/cancel-all
 * Cancel all orders for a user
 */
router.post('/cancel-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      throw new AppError('userId is required', 400);
    }

    const result = await orderService.cancelAllOrders(userId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/:orderId/sync
 * Sync order status from CLOB
 */
router.post('/:orderId/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId } = req.params;

    const result = await orderService.syncOrderStatus(orderId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/user/:userId/sync
 * Sync all orders for a user from Polymarket CLOB
 */
router.post('/user/:userId/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;

    const result = await orderService.syncAllUserOrders(userId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/execute-atomic
 * Execute multiple orders atomically - all succeed or all fail together
 * 
 * This endpoint accepts pre-signed orders and submits them as a batch.
 * Uses FOK (Fill-or-Kill) by default for guaranteed execution at limit price.
 * 
 * Authentication: Uses x-api-key header to identify the user (same as other endpoints)
 * The userId in body is OPTIONAL - if not provided, user is looked up by API key
 */
router.post('/execute-atomic', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orders, userId: bodyUserId, metadata } = req.body;
    const apiKey = req.headers['x-api-key'] as string;

    // Validate request
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      throw new AppError('orders array is required and must not be empty', 400);
    }

    if (orders.length > 10) {
      throw new AppError('Maximum 10 orders per atomic batch', 400);
    }

    // Get user - prefer API key lookup, fallback to userId in body
    let user;
    let userId: string;

    if (apiKey) {
      // Look up user by API key (preferred method)
      const validation = await apiKeyService.validateApiKey(apiKey);
      if (validation) {
        user = validation.user;
        userId = validation.userId;
      }
    }

    // Fallback to userId in body if API key lookup failed
    if (!user && bodyUserId) {
      user = await prisma.user.findUnique({
        where: { id: bodyUserId },
      });
      if (user) {
        userId = user.id;
      }
    }

    // Also try looking up by externalId if userId looks like one
    if (!user && bodyUserId) {
      user = await prisma.user.findUnique({
        where: { externalId: bodyUserId },
      });
      if (user) {
        userId = user.id;
      }
    }

    if (!user) {
      throw new AppError('User not found. Ensure your API key is valid or provide a valid userId.', 404);
    }

    if (!user.safeAddress) {
      throw new AppError('User wallet not set up. Call setup_wallet first.', 400);
    }

    // Validate each order
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      
      if (!order.tokenId) {
        throw new AppError(`Order ${i}: tokenId is required`, 400);
      }
      if (typeof order.price !== 'number' || isNaN(order.price) || order.price < 0.01 || order.price > 0.99) {
        throw new AppError(`Order ${i}: price must be between 0.01 and 0.99`, 400);
      }
      if (typeof order.size !== 'number' || isNaN(order.size) || order.size <= 0) {
        throw new AppError(`Order ${i}: size must be a positive number`, 400);
      }
      if (!['BUY', 'SELL'].includes(order.side)) {
        throw new AppError(`Order ${i}: side must be BUY or SELL`, 400);
      }
    }

    // Get user credentials
    const keyService = getKeyService();
    const wallet = await keyService.getUserWallet(userId!);
    const credentials = await keyService.getApiCredentials(userId!);

    // Get builder config
    let builderConfig: BuilderConfig | undefined;
    if (config.builder.apiKey && config.builder.secret && config.builder.passphrase) {
      builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: config.builder.apiKey,
          secret: config.builder.secret,
          passphrase: config.builder.passphrase,
        },
      });
    }

    // Results array
    const orderResults: Array<{
      index: number;
      orderId?: string;
      clobOrderId?: string;
      success: boolean;
      error?: string;
    }> = [];

    // Track if any order fails
    let hasFailure = false;
    const submittedOrders: string[] = [];

    // Create CLOB client
    const clobClient = new ClobClient(
      config.polymarket.clobApiUrl,
      config.polygon.chainId,
      wallet,
      credentials,
      SIGNATURE_TYPE_POLY_PROXY,
      user.safeAddress,
      undefined,
      false, // Will detect neg risk per order
      builderConfig
    );

    // Process each order
    for (let i = 0; i < orders.length; i++) {
      const orderInput = orders[i];
      
      try {
        // Create order record in database
        const dbOrder = await prisma.order.create({
          data: {
            userId: userId!,
            conditionId: orderInput.conditionId || orderInput.marketId || 'atomic-batch',
            tokenId: orderInput.tokenId,
            side: orderInput.side,
            price: orderInput.price,
            size: orderInput.size,
            orderType: orderInput.orderType || 'FOK',
            status: 'PENDING',
          },
        });

        // Build order options
        const orderOptions = {
          tokenID: orderInput.tokenId,
          price: orderInput.price,
          size: orderInput.size,
          side: orderInput.side === 'BUY' ? Side.BUY : Side.SELL,
        };

        // Create and submit order
        const createdOrder = await clobClient.createOrder(orderOptions);
        const orderType = orderInput.orderType || 'FOK';
        const response = await clobClient.postOrder(createdOrder, orderType as any) as any;

        // Check for errors in response
        if (response?.error || response?.status === 400 || response?.status === 422) {
          throw new Error(response.error || response.message || 'Order rejected');
        }

        const clobOrderId = response.orderID || response.orderId || response.id;

        if (!clobOrderId) {
          throw new Error('No order ID returned from Polymarket');
        }

        // Update database
        await prisma.order.update({
          where: { id: dbOrder.id },
          data: {
            clobOrderId,
            status: 'LIVE',
            submittedAt: new Date(),
          },
        });

        submittedOrders.push(clobOrderId);

        orderResults.push({
          index: i,
          orderId: dbOrder.id,
          clobOrderId,
          success: true,
        });

      } catch (orderError: any) {
        hasFailure = true;
        
        orderResults.push({
          index: i,
          success: false,
          error: orderError.message || 'Order failed',
        });

        // Log the failure
        console.error(`[Atomic] Order ${i} failed:`, orderError.message);
      }
    }

    // If any order failed and we're in atomic mode, cancel all submitted orders
    if (hasFailure && submittedOrders.length > 0) {
      console.log(`[Atomic] Failure detected, cancelling ${submittedOrders.length} submitted orders`);
      
      for (const clobOrderId of submittedOrders) {
        try {
          await clobClient.cancelOrder({ orderID: clobOrderId });
          console.log(`[Atomic] Cancelled order: ${clobOrderId}`);
        } catch (cancelError: any) {
          console.error(`[Atomic] Failed to cancel order ${clobOrderId}:`, cancelError.message);
        }
      }

      // Update database records to cancelled
      await prisma.order.updateMany({
        where: {
          clobOrderId: { in: submittedOrders },
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          statusMessage: 'Cancelled due to atomic batch failure',
        },
      });

      // Return failure response
      return res.status(400).json({
        success: false,
        error: 'Atomic batch failed - all orders cancelled',
        orderResults,
        metadata,
      });
    }

    // All orders succeeded
    res.json({
      success: true,
      message: `Successfully executed ${orderResults.length} orders atomically`,
      orderResults,
      metadata,
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/batch
 * Execute multiple orders in sequence (non-atomic)
 * Orders are executed independently - some may succeed while others fail
 */
router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orders, userId } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      throw new AppError('orders array is required', 400);
    }

    if (!userId) {
      throw new AppError('userId is required', 400);
    }

    if (orders.length > 20) {
      throw new AppError('Maximum 20 orders per batch', 400);
    }

    const results = [];

    for (const order of orders) {
      try {
        const result = await orderService.createOrder({
          userId,
          conditionId: order.conditionId,
          tokenId: order.tokenId,
          side: order.side,
          price: order.price,
          size: order.size,
          orderType: order.orderType || 'GTC',
          expiration: order.expiration,
        });

        results.push({
          success: true,
          ...result,
        });
      } catch (orderError: any) {
        results.push({
          success: false,
          error: orderError.message,
          tokenId: order.tokenId,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    res.json({
      success: failCount === 0,
      message: `Executed ${successCount}/${orders.length} orders successfully`,
      results,
    });

  } catch (error) {
    next(error);
  }
});

export { router as orderRoutes };

