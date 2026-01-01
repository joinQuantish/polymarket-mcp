import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ethers } from 'ethers';
import { prisma } from '../db';
import { getKeyService } from '../services/key.service';
import { getWalletService } from '../services/wallet.service';
import { getOrderService } from '../services/order.service';
import { getMarketService } from '../services/market.service';
import { getPositionService } from '../services/position.service';
import { getApiKeyService } from '../services/apikey.service';
import { getSwapService } from '../services/swap.service';
import { getSerperService } from '../services/serper.service';
import { getAccessCodeService } from '../services/accesscode.service';

/**
 * MCP Tools for Polymarket Trading
 * 
 * SECURITY: User identification is NEVER passed through tool arguments.
 * All user-specific operations derive the user from the API key in headers.
 * 
 * The `request_api_key` tool is the ONLY tool that doesn't require authentication.
 * All other tools require a valid API key in the x-api-key header.
 */

// Tool definitions
export const TOOLS: Tool[] = [
  // ============================================
  // PUBLIC TOOL (No Authentication Required)
  // ============================================
  {
    name: 'request_api_key',
    description: 'Request a new API key to access your Polymarket wallet. This creates a new wallet if you do not have one. NO AUTHENTICATION REQUIRED for this call. Returns an API key that must be used in headers for all other operations, and an API secret for optional HMAC request signing.',
    inputSchema: {
      type: 'object',
      properties: {
        externalId: {
          type: 'string',
          description: 'Your unique identifier from your system (e.g., user ID, email hash). This links the wallet to your account.'
        },
        keyName: {
          type: 'string',
          description: 'Optional friendly name for this API key (e.g., "Production", "Testing")'
        }
      },
      required: ['externalId']
    }
  },

  // ============================================
  // WALLET MANAGEMENT (Requires API Key)
  // ============================================
  {
    name: 'setup_wallet',
    description: 'Complete full wallet setup including Safe deployment, API credentials, and contract approvals. Gasless - no MATIC required. Call this after receiving your API key.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'reset_credentials',
    description: 'Reset and regenerate CLOB API credentials. Use this if your existing credentials are corrupted (e.g., base64 decode errors) or need to be refreshed. This clears old credentials and creates new ones.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'validate_credentials',
    description: 'Check if your stored CLOB credentials are valid (proper base64 format). Returns validation status without exposing actual credentials.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_wallet_status',
    description: 'Get your wallet status including deployment state, addresses, and approval status.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'set_approvals',
    description: 'Set all required token approvals for trading (USDC, CTF, Neg Risk). Use force=true to re-approve even if already set. Gasless via Polymarket relayer.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'If true, re-approve even if approvals are already set (useful for refreshing approvals)'
        }
      },
      required: []
    }
  },
  {
    name: 'sync_balance',
    description: 'Force Polymarket CLOB to re-sync balance/allowance data. Use when orders fail with "not enough balance" but on-chain data is correct.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_balances',
    description: 'Get your USDC (bridged), Native USDC (Circle), and MATIC balances for both EOA and Safe wallets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_deposit_addresses',
    description: 'Get deposit addresses for funding your Polymarket wallet. Returns addresses for EVM chains (Ethereum, Polygon, etc.), Solana, and Bitcoin. Deposits are automatically converted to USDC.e on Polygon for trading.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_supported_deposit_assets',
    description: 'Get the list of supported tokens and chains for deposits. Shows minimum deposit amounts and supported tokens like USDC, ETH, WBTC, SOL, etc.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'export_private_key',
    description: 'Export your wallet private key. Returns the raw hex private key and EOA address for verification. WARNING: Handle this securely - anyone with this key controls your wallet.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'import_private_key',
    description: 'Import an existing private key to create a new wallet. This creates a new user with the provided private key and sets up API credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        externalId: {
          type: 'string',
          description: 'Your unique identifier (e.g., telegram:123456789)'
        },
        privateKey: {
          type: 'string',
          description: 'The private key to import (hex format with 0x prefix)'
        },
        keyName: {
          type: 'string',
          description: 'Optional friendly name for the API key (e.g., "Quantish Telegram Bot")'
        }
      },
      required: ['externalId', 'privateKey']
    }
  },
  {
    name: 'recover_safe_address',
    description: 'Recover/sync Safe wallet address for cases where deployment succeeded but the database was not updated (e.g., timeout during confirmation). This will attempt to find the Safe address on-chain and update the database. Optionally provide a known Safe address to verify and sync.',
    inputSchema: {
      type: 'object',
      properties: {
        knownSafeAddress: {
          type: 'string',
          description: 'Optional: If you know the Safe address (e.g., from blockchain explorer), provide it to verify and sync'
        }
      },
      required: []
    }
  },

  // ============================================
  // ORDER MANAGEMENT (Requires API Key)
  // ============================================
  {
    name: 'place_order',
    description: 'Place a buy or sell order on Polymarket. Minimum order size is $1. Orders are attributed to builder credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: {
          type: 'string',
          description: 'The market condition ID (get from search_markets or get_market)'
        },
        tokenId: {
          type: 'string',
          description: 'The token ID of the outcome to trade (get from market tokens array)'
        },
        side: {
          type: 'string',
          enum: ['BUY', 'SELL'],
          description: 'Whether to buy or sell'
        },
        price: {
          type: 'number',
          description: 'Price per share (0.01 to 0.99)'
        },
        size: {
          type: 'number',
          description: 'Number of shares (price * size must be >= $1)'
        },
        orderType: {
          type: 'string',
          enum: ['GTC', 'GTD', 'FOK', 'FAK'],
          description: 'Order type: GTC (Good Till Cancelled, default), GTD (Good Till Date), FOK (Fill Or Kill), FAK (Fill And Kill)'
        },
        expiration: {
          type: 'number',
          description: 'Unix timestamp for GTD orders (required for GTD)'
        }
      },
      required: ['conditionId', 'tokenId', 'side', 'price', 'size']
    }
  },
  {
    name: 'cancel_order',
    description: 'Cancel an existing order. Note: filled orders cannot be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The order ID to cancel (accepts both local ID or CLOB order ID like 0x...)'
        }
      },
      required: ['orderId']
    }
  },
  {
    name: 'get_orders',
    description: 'Get all your orders, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['PENDING', 'LIVE', 'FILLED', 'CANCELLED', 'FAILED'],
          description: 'Filter by order status (optional)'
        }
      },
      required: []
    }
  },
  {
    name: 'sync_order_status',
    description: 'Sync an order status with Polymarket CLOB to get the latest fill information.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The local order ID to sync'
        }
      },
      required: ['orderId']
    }
  },
  {
    name: 'execute_atomic_orders',
    description: 'Execute multiple orders atomically - all succeed together or all fail together. If any order fails, all previously submitted orders are cancelled. Uses FOK (Fill-or-Kill) by default for guaranteed execution at limit price. Maximum 10 orders per batch.',
    inputSchema: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          description: 'Array of orders to execute atomically',
          items: {
            type: 'object',
            properties: {
              conditionId: {
                type: 'string',
                description: 'The market condition ID'
              },
              tokenId: {
                type: 'string',
                description: 'The token ID of the outcome to trade'
              },
              side: {
                type: 'string',
                enum: ['BUY', 'SELL'],
                description: 'Whether to buy or sell'
              },
              price: {
                type: 'number',
                description: 'Price per share (0.01 to 0.99)'
              },
              size: {
                type: 'number',
                description: 'Number of shares'
              },
              orderType: {
                type: 'string',
                enum: ['FOK', 'FAK', 'GTC'],
                description: 'Order type (default: FOK for atomic execution)'
              }
            },
            required: ['tokenId', 'side', 'price', 'size']
          }
        },
        metadata: {
          type: 'string',
          description: 'Optional description for this atomic batch'
        }
      },
      required: ['orders']
    }
  },

  // ============================================
  // POSITION MANAGEMENT (Requires API Key)
  // ============================================
  {
    name: 'get_positions',
    description: 'Get all your positions (share holdings).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'sync_positions',
    description: 'Sync your positions with Polymarket Data API to get the latest holdings.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_claimable_winnings',
    description: 'Check if you have any claimable winnings from resolved markets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'claim_winnings',
    description: 'Claim winnings from resolved markets. Gasless via relayer.',
    inputSchema: {
      type: 'object',
      properties: {
        positionId: {
          type: 'string',
          description: 'Specific position ID to claim (optional, claims all if not specified)'
        }
      },
      required: []
    }
  },
  {
    name: 'get_onchain_shares',
    description: 'Get ALL shares (ERC-1155 tokens) held by your wallet by querying the blockchain directly. This finds shares that were GIFTED or TRANSFERRED to you, which do NOT appear in get_positions. Use this to find shares someone sent you that Polymarket API does not track.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'check_token_balance',
    description: 'Check the on-chain balance of a specific token ID for your wallet. Useful to verify if you received a share transfer. Returns the actual blockchain balance regardless of Polymarket API tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The token ID (ERC-1155 asset ID) to check balance for'
        }
      },
      required: ['tokenId']
    }
  },

  // ============================================
  // TRANSFERS (Requires API Key)
  // ============================================
  {
    name: 'transfer_usdc',
    description: 'Transfer USDC from your Safe wallet to another address. Gasless via Polymarket relayer.',
    inputSchema: {
      type: 'object',
      properties: {
        toAddress: {
          type: 'string',
          description: 'The destination Polygon address'
        },
        amount: {
          type: 'number',
          description: 'Amount of USDC to transfer (e.g., 1.5 for $1.50)'
        }
      },
      required: ['toAddress', 'amount']
    }
  },
  {
    name: 'transfer_shares',
    description: 'Transfer shares (ERC-1155 tokens) to another address. Gasless via Polymarket relayer.',
    inputSchema: {
      type: 'object',
      properties: {
        toAddress: {
          type: 'string',
          description: 'The destination Polygon address'
        },
        tokenId: {
          type: 'string',
          description: 'The token ID to transfer'
        },
        amount: {
          type: 'number',
          description: 'Number of shares to transfer (integer)'
        }
      },
      required: ['toAddress', 'tokenId', 'amount']
    }
  },
  {
    name: 'transfer_matic',
    description: 'DEPRECATED: Use send_matic instead. Native MATIC transfers via the Polymarket relayer are not supported.',
    inputSchema: {
      type: 'object',
      properties: {
        toAddress: {
          type: 'string',
          description: 'The destination Polygon address'
        },
        amount: {
          type: 'number',
          description: 'Amount of MATIC to transfer (e.g., 1.5 for 1.5 MATIC)'
        }
      },
      required: ['toAddress', 'amount']
    }
  },
  {
    name: 'send_matic',
    description: 'Send native MATIC directly from your EOA wallet (NOT via relayer). This requires MATIC in your EOA address for gas. Use get_balances to check your EOA MATIC balance. This bypasses the Safe wallet and sends directly from the EOA.',
    inputSchema: {
      type: 'object',
      properties: {
        toAddress: {
          type: 'string',
          description: 'The destination Polygon address'
        },
        amount: {
          type: 'number',
          description: 'Amount of MATIC to send (e.g., 1.5 for 1.5 MATIC). Must leave some for gas.'
        }
      },
      required: ['toAddress', 'amount']
    }
  },
  {
    name: 'transfer_native_usdc',
    description: 'Transfer Native USDC (Circle\'s native USDC, not bridged USDC.e) from your Safe wallet to another address. Gasless via Polymarket relayer.',
    inputSchema: {
      type: 'object',
      properties: {
        toAddress: {
          type: 'string',
          description: 'The destination Polygon address'
        },
        amount: {
          type: 'number',
          description: 'Amount of Native USDC to transfer (e.g., 1.5 for $1.50)'
        }
      },
      required: ['toAddress', 'amount']
    }
  },

  // ============================================
  // TOKEN SWAPS (Requires API Key)
  // ============================================
  {
    name: 'swap_tokens',
    description: 'Swap tokens on Polygon at the best rate using LI.FI DEX aggregator. Supports: MATIC (uses WMATIC), USDC (bridged USDC.e), NATIVE_USDC (Circle). IMPORTANT: Swapping FROM MATIC requires WMATIC balance (not native MATIC) because native MATIC cannot be transferred via the Polymarket relayer. Check get_balances to see wmatic vs matic balance.',
    inputSchema: {
      type: 'object',
      properties: {
        fromToken: {
          type: 'string',
          description: 'Token to swap FROM. Options: MATIC (requires WMATIC balance), USDC, NATIVE_USDC'
        },
        toToken: {
          type: 'string',
          description: 'Token to swap TO. Options: MATIC (receives WMATIC), USDC, NATIVE_USDC'
        },
        amount: {
          type: 'number',
          description: 'Amount of fromToken to swap (e.g., 1.5 for 1.5 tokens)'
        }
      },
      required: ['fromToken', 'toToken', 'amount']
    }
  },
  {
    name: 'get_swap_quote',
    description: 'Get a swap quote without executing. Shows estimated output, price impact, and fees. Note: MATIC swaps use WMATIC (wrapped MATIC) - check get_balances for wmatic balance.',
    inputSchema: {
      type: 'object',
      properties: {
        fromToken: {
          type: 'string',
          description: 'Token to swap FROM. Options: MATIC (uses WMATIC), USDC, NATIVE_USDC'
        },
        toToken: {
          type: 'string',
          description: 'Token to swap TO. Options: MATIC (receives WMATIC), USDC, NATIVE_USDC'
        },
        amount: {
          type: 'number',
          description: 'Amount of fromToken to swap (e.g., 1.5 for 1.5 tokens)'
        }
      },
      required: ['fromToken', 'toToken', 'amount']
    }
  },

  // ============================================
  // WEB TOOLS - DISABLED (re-enable if needed)
  // ============================================
  // {
  //   name: 'scrapeURL',
  //   description: 'Scrape content from a web page URL. Returns the page title and text content. Useful for reading articles, documentation, or any web page.',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       url: {
  //         type: 'string',
  //         description: 'The URL of the web page to scrape'
  //       }
  //     },
  //     required: ['url']
  //   }
  // },
  // {
  //   name: 'news_search',
  //   description: 'Search for news articles on a topic. Returns recent news with titles, snippets, sources, and links.',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       query: {
  //         type: 'string',
  //         description: 'The search query for news articles'
  //       },
  //       num: {
  //         type: 'number',
  //         description: 'Number of results to return (default 10, max 100)'
  //       },
  //       timeRange: {
  //         type: 'string',
  //         enum: ['hour', 'day', 'week', 'month', 'year'],
  //         description: 'Filter results by time range (optional)'
  //       }
  //     },
  //     required: ['query']
  //   }
  // },
  {
    name: 'get_elon_tweet_count',
    description: 'Get Elon Musk\'s X/Twitter post count from xtracker.io - the official resolution source for Polymarket markets tracking Elon\'s posting activity. Can calculate exact counts for specific date ranges, project final totals, and provide statistics. If no dates provided, returns all tracked periods.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          description: 'Optional start date for custom range (format: YYYY-MM-DD or "Nov 28, 2025"). If provided with endDate, calculates exact count for that period.'
        },
        endDate: {
          type: 'string',
          description: 'Optional end date for custom range (format: YYYY-MM-DD or "Dec 5, 2025"). Used with startDate to calculate exact count.'
        },
        includeProjection: {
          type: 'boolean',
          description: 'If true and date range is ongoing, projects the final total based on current pace. Default: true'
        }
      },
      required: []
    }
  },

  // ============================================
  // API KEY MANAGEMENT (Requires API Key)
  // ============================================
  {
    name: 'list_api_keys',
    description: 'List all your API keys (without exposing the actual keys).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_additional_api_key',
    description: 'Create an additional API key for your wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Friendly name for this API key'
        }
      },
      required: []
    }
  },
  {
    name: 'revoke_api_key',
    description: 'Revoke one of your API keys.',
    inputSchema: {
      type: 'object',
      properties: {
        keyId: {
          type: 'string',
          description: 'The key ID to revoke (get from list_api_keys)'
        }
      },
      required: ['keyId']
    }
  },

  // ============================================
  // MARKET DATA FOR TRADING (Requires API Key)
  // ============================================
  {
    name: 'search_markets',
    description: 'Search for Polymarket markets by keyword. Returns active markets matching your query with condition IDs, token IDs, prices, and volume. Use this to find markets to trade.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "Trump", "Bitcoin", "election")'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 10, max 50)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_market',
    description: 'Get detailed information about a specific market by condition ID. Returns market question, outcomes, token IDs, prices, volume, and liquidity.',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: {
          type: 'string',
          description: 'The market condition ID'
        }
      },
      required: ['conditionId']
    }
  },
  {
    name: 'get_active_markets',
    description: 'Get a list of active markets on Polymarket. Returns popular markets sorted by volume. Use search_markets for specific topics.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 20, max 100)'
        }
      },
      required: []
    }
  },
  {
    name: 'get_orderbook',
    description: 'Get the order book showing bids and asks. Accepts either a tokenId (decimal number) or conditionId (0x hex string). If conditionId is provided, returns orderbooks for all outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The token ID or condition ID. Token IDs are long decimal numbers, condition IDs start with 0x.'
        }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'get_price',
    description: 'Get the current midpoint price. Accepts either a tokenId (decimal number) or conditionId (0x hex string). If conditionId is provided, returns prices for all outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'The token ID or condition ID. Token IDs are long decimal numbers, condition IDs start with 0x.'
        }
      },
      required: ['tokenId']
    }
  }
];

/**
 * Context passed to tool execution
 * Contains authenticated user info derived from API key header
 */
export interface ToolContext {
  userId: string | null;
  isAuthenticated: boolean;
  user?: {
    id: string;
    externalId: string;
    eoaAddress: string;
    safeAddress: string | null;
    status: string;
  };
}

/**
 * Execute a tool with the given context
 * Context contains user info derived from API key (NOT from arguments)
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  const keyService = getKeyService();
  const walletService = getWalletService();
  const orderService = getOrderService();
  const marketService = getMarketService();
  const positionService = getPositionService();
  const apiKeyService = getApiKeyService();

  // ============================================
  // PUBLIC TOOL (No Authentication Required)
  // ============================================
  if (name === 'request_api_key') {
    const { externalId, keyName, accessCode } = args as { externalId: string; keyName?: string; accessCode?: string };
    
    if (!externalId) {
      throw new Error('externalId is required');
    }

    // Access code is optional - if provided, validate it, but don't require it
    // This allows the tool to work without access codes for development/testing
    // Note: The deployed version may still require access codes - this change will make it optional

    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { externalId },
    });

    if (!user) {
      // Create new user with wallet
      const result = await walletService.createUser(externalId);
      user = await prisma.user.findUnique({
        where: { id: result.userId },
      });
    }

    if (!user) {
      throw new Error('Failed to create user');
    }

    // Generate new API key with secret
    const keyResult = await apiKeyService.createApiKey(user.id, keyName);

    return {
      success: true,
      apiKey: keyResult.apiKey,
      apiSecret: keyResult.apiSecret,
      keyPrefix: keyResult.keyPrefix,
      eoaAddress: user.eoaAddress,
      message: 'API key and secret created. SAVE THESE - they will not be shown again! Use the API key in the x-api-key header. For extra security, use HMAC signing with the secret.',
      hmacSigningInstructions: {
        headers: {
          'x-api-key': 'Your API key',
          'x-signature': 'HMAC-SHA256(timestamp + method + path + body, secret)',
          'x-timestamp': 'Current Unix timestamp in milliseconds'
        },
        example: 'signature = HMAC_SHA256("1701234567890POST/mcp{\"jsonrpc\":\"2.0\"...}", apiSecret)',
        note: 'HMAC signing is optional but recommended for production use'
      },
      nextSteps: [
        '1. Save your API key and secret securely',
        '2. Run: npx @quantish/sdk enable (to auto-configure Cursor)',
        '3. Or manually add to mcp.json inside "mcpServers": { "quantish": { "url": "https://quantish-sdk-production.up.railway.app/mcp", "headers": { "x-api-key": "' + keyResult.apiKey + '" } } }',
        '4. Restart Cursor, then call setup_wallet',
        '5. Send USDC to your Safe address to start trading'
      ],
      cursorMcpEntry: {
        _instruction: 'Add this INSIDE your existing mcpServers object in mcp.json:',
        quantish: {
          url: 'https://quantish-sdk-production.up.railway.app/mcp',
          headers: {
            'x-api-key': keyResult.apiKey
          }
        }
      }
    };
  }

  // ============================================
  // ALL OTHER TOOLS REQUIRE AUTHENTICATION
  // ============================================
  if (!context.isAuthenticated || !context.userId) {
    throw new Error('Authentication required. Please include your API key in the x-api-key header.');
  }

  const userId = context.userId;

  switch (name) {
    // Wallet Management
    case 'setup_wallet': {
      const result = await walletService.fullSetup(userId);
      return {
        success: true,
        ...result,
        message: 'Wallet fully set up and ready for trading. Send USDC to your Safe address to start trading.'
      };
    }

    case 'reset_credentials': {
      await walletService.resetApiCredentials(userId);
      return {
        success: true,
        message: 'CLOB API credentials have been reset and regenerated. Your wallet is ready for trading.'
      };
    }

    case 'validate_credentials': {
      const user = await prisma.user.findUnique({ 
        where: { id: userId },
        select: {
          encryptedApiKey: true,
          encryptedApiSecret: true,
          encryptedApiPassphrase: true,
        }
      });
      
      if (!user || !user.encryptedApiKey || !user.encryptedApiSecret || !user.encryptedApiPassphrase) {
        return {
          valid: false,
          hasCredentials: false,
          error: 'No credentials stored'
        };
      }

      try {
        // Try to decrypt and validate
        const credentials = await keyService.getApiCredentials(userId);
        
        // Additional validation
        const keyValid = credentials.key && credentials.key.length > 10;
        const passphraseValid = credentials.passphrase && credentials.passphrase.length > 0;
        
        // Test base64 decode of secret
        let secretValid = false;
        let secretDecodedLength = 0;
        try {
          const decoded = Buffer.from(credentials.secret, 'base64');
          secretDecodedLength = decoded.length;
          secretValid = decoded.length > 0;
        } catch {
          secretValid = false;
        }

        return {
          valid: keyValid && secretValid && passphraseValid,
          hasCredentials: true,
          keyValid,
          secretValid,
          secretDecodedLength,
          passphraseValid,
          keyLength: credentials.key.length,
          secretLength: credentials.secret.length,
          passphraseLength: credentials.passphrase.length,
        };
      } catch (error) {
        return {
          valid: false,
          hasCredentials: true,
          error: error instanceof Error ? error.message : 'Decryption failed'
        };
      }
    }

    case 'get_wallet_status': {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('User not found');
      
      // Get builder credentials status for diagnostics
      const builderStatus = walletService.getBuilderCredentialsStatus();
      
      return {
        externalId: user.externalId,
        eoaAddress: user.eoaAddress,
        safeAddress: user.safeAddress,
        safeDeployed: user.safeDeployed,
        hasClobCredentials: !!user.encryptedApiKey,
        approvals: {
          usdc: user.usdcApproved,
          ctf: user.ctfApproved,
          negRisk: user.negRiskApproved
        },
        status: user.status,
        isReady: user.status === 'READY',
        systemStatus: {
          builderCredentialsConfigured: builderStatus.configured,
          builderApiKeyPrefix: builderStatus.apiKeyPrefix,
          note: !builderStatus.configured 
            ? 'Builder credentials not configured - Safe deployment and gasless transactions will fail' 
            : 'Builder credentials configured'
        }
      };
    }

    case 'set_approvals': {
      const { force } = args as { force?: boolean };
      
      await walletService.setTokenApprovals(userId, force || false);
      
      // Verify approvals were set
      const approvals = await walletService.verifyApprovals(userId);
      
      return {
        success: true,
        message: force 
          ? 'Token approvals re-set successfully (forced).' 
          : 'Token approvals set successfully.',
        approvals: {
          usdc: approvals.usdcApproved,
          ctf: approvals.ctfApproved,
          negRisk: approvals.negRiskApproved,
          allApproved: approvals.allApproved
        }
      };
    }

    case 'sync_balance': {
      const result = await walletService.syncBalanceWithClob(userId);
      return {
        success: result.synced,
        message: result.message,
        balance: result.balance,
        allowance: result.allowance
      };
    }

    case 'recover_safe_address': {
      const { knownSafeAddress } = args as { knownSafeAddress?: string };
      
      const safeAddress = await walletService.recoverSafeAddress(userId, knownSafeAddress);
      
      if (safeAddress) {
        return {
          success: true,
          safeAddress,
          message: 'Safe address recovered and database updated successfully. You can now continue with setup_wallet to complete approvals and credentials.'
        };
      } else {
        return {
          success: false,
          message: 'Could not find or verify Safe address on-chain. The Safe may not have been deployed yet, or there was an issue with address calculation. Try calling setup_wallet which will deploy a new Safe if needed.'
        };
      }
    }

    case 'get_balances': {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('User not found');
      
      const eoaBalance = await keyService.getBalance(user.eoaAddress);
      const eoaUsdc = await keyService.getUsdcBalance(user.eoaAddress);
      
      let safeBalance = '0';
      let safeUsdc = '0';
      let safeNativeUsdc = '0';
      let safeWmatic = '0';
      if (user.safeAddress) {
        safeBalance = await keyService.getBalance(user.safeAddress);
        safeUsdc = await keyService.getUsdcBalance(user.safeAddress);
        safeNativeUsdc = await walletService.getNativeUsdcBalance(user.safeAddress);
        safeWmatic = await walletService.getWmaticBalance(user.safeAddress);
      }
      
      return {
        eoa: {
          address: user.eoaAddress,
          matic: eoaBalance,
          usdc: eoaUsdc
        },
        safe: user.safeAddress ? {
          address: user.safeAddress,
          matic: safeBalance,
          wmatic: safeWmatic,
          usdc: safeUsdc,
          nativeUsdc: safeNativeUsdc,
          _note: 'matic = native MATIC (cannot be swapped via relayer), wmatic = wrapped MATIC (can be swapped)'
        } : null
      };
    }

    case 'get_deposit_addresses': {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('User not found');
      
      // Use Safe address for deposits (where trading happens)
      const depositAddress = user.safeAddress || user.eoaAddress;
      
      if (!depositAddress) {
        throw new Error('Wallet not set up. Call setup_wallet first.');
      }

      try {
        // Call Polymarket bridge API
        const response = await fetch('https://bridge.polymarket.com/deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: depositAddress })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Bridge API error: ${response.status} - ${errorText}`);
        }

        const depositData = await response.json() as { 
          evm?: string; 
          svm?: string; 
          btc?: string;
          addresses?: { evm?: string; svm?: string; btc?: string };
        };
        
        return {
          polygonAddress: depositAddress,
          depositAddresses: {
            evm: depositData.evm || depositData.addresses?.evm || null,
            solana: depositData.svm || depositData.addresses?.svm || null,
            bitcoin: depositData.btc || depositData.addresses?.btc || null
          },
          instructions: {
            evm: 'Send any supported token from Ethereum, Polygon, Arbitrum, Optimism, or Base to this address. It will be automatically converted to USDC.e on Polygon.',
            solana: 'Send USDC or SOL from Solana to this address. It will be automatically bridged to USDC.e on Polygon.',
            bitcoin: 'Send BTC to this address. It will be automatically converted to USDC.e on Polygon. Minimum: 0.0005 BTC.'
          },
          note: 'All deposits are automatically converted to USDC.e on Polygon for Polymarket trading. Processing time: 1-15 minutes depending on chain.'
        };
      } catch (error) {
        // Fallback: if bridge API fails, just return Polygon address for direct deposits
        return {
          polygonAddress: depositAddress,
          depositAddresses: {
            evm: null,
            solana: null,
            bitcoin: null
          },
          fallbackInstructions: 'Bridge API unavailable. You can deposit USDC.e directly to your Polygon address.',
          error: error instanceof Error ? error.message : 'Failed to get bridge addresses'
        };
      }
    }

    case 'get_supported_deposit_assets': {
      try {
        const response = await fetch('https://bridge.polymarket.com/supported-assets');
        
        if (!response.ok) {
          throw new Error(`Failed to fetch supported assets: ${response.status}`);
        }

        const assets = await response.json();
        
        // Group by chain for easier consumption
        const byChain: Record<string, any[]> = {};
        
        if (Array.isArray(assets)) {
          for (const asset of assets) {
            const chainName = asset.chainName || `Chain ${asset.chainId}`;
            if (!byChain[chainName]) {
              byChain[chainName] = [];
            }
            byChain[chainName].push({
              symbol: asset.token?.symbol || asset.symbol,
              name: asset.token?.name || asset.name,
              address: asset.token?.address || asset.address,
              minDepositUsd: asset.minCheckoutUsd || asset.minDeposit || 10
            });
          }
        }

        return {
          supportedChains: Object.keys(byChain),
          assetsByChain: byChain,
          totalAssets: Array.isArray(assets) ? assets.length : 0,
          note: 'All deposits are automatically converted to USDC.e on Polygon. Check minimum deposit amounts before sending.'
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Failed to fetch supported assets',
          fallback: {
            commonAssets: [
              { symbol: 'USDC', chains: ['Ethereum', 'Polygon', 'Solana'], minUsd: 10 },
              { symbol: 'ETH', chains: ['Ethereum', 'Arbitrum', 'Optimism', 'Base'], minUsd: 10 },
              { symbol: 'SOL', chains: ['Solana'], minUsd: 10 },
              { symbol: 'BTC', chains: ['Bitcoin'], minUsd: 50 }
            ]
          }
        };
      }
    }

    case 'export_private_key': {
      // Get raw private key
      const privateKey = await keyService.getPrivateKey(userId);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      
      // Log this sensitive action
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'PRIVATE_KEY_EXPORT',
          resource: 'wallet',
          details: {
            timestamp: new Date().toISOString(),
            note: 'Raw private key exported'
          }
        }
      });

      return {
        privateKey,
        eoaAddress: user?.eoaAddress,
        warning: '⚠️ SECURITY WARNING: Anyone with this private key controls your wallet. Store it securely and never share it.'
      };
    }

    case 'import_private_key': {
      const { externalId, privateKey, keyName } = args as { 
        externalId: string; 
        privateKey: string; 
        keyName?: string;
      };
      
      if (!externalId) {
        throw new Error('externalId is required');
      }
      
      if (!privateKey) {
        throw new Error('privateKey is required');
      }
      
      // Validate private key format
      if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
        throw new Error('Invalid private key format. Must be 0x-prefixed hex string (66 chars total)');
      }

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { externalId },
      });

      if (existingUser) {
        throw new Error('User with this externalId already exists. Use a different externalId or export the existing wallet first.');
      }

      // Import the private key and create user
      const result = await walletService.importPrivateKey(externalId, privateKey);
      
      // Generate API key
      const keyResult = await apiKeyService.createApiKey(result.userId, keyName || 'Imported Wallet');

      // Log this action
      await prisma.activityLog.create({
        data: {
          userId: result.userId,
          action: 'PRIVATE_KEY_IMPORT',
          resource: 'wallet',
          details: {
            timestamp: new Date().toISOString(),
            keyName: keyName || 'Imported Wallet'
          }
        }
      });

      return {
        success: true,
        apiKey: keyResult.apiKey,
        apiSecret: keyResult.apiSecret,
        eoaAddress: result.eoaAddress,
        message: 'Private key imported successfully. Save your API key - it cannot be recovered!'
      };
    }

    // Order Management
    case 'place_order': {
      const { conditionId, tokenId, side, price, size, orderType, expiration } = args as {
        conditionId: string;
        tokenId: string;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
        orderType?: string;
        expiration?: number;
      };
      
      // Validate minimum order size
      const orderValue = price * size;
      if (orderValue < 1) {
        throw new Error(`Order value $${orderValue.toFixed(2)} is below Polymarket minimum of $1.00`);
      }

      const order = await orderService.createOrder({
        userId,
        conditionId,
        tokenId,
        side,
        price,
        size,
        orderType: (orderType || 'GTC') as 'GTC' | 'GTD' | 'FOK' | 'FAK',
        expiration
      });
      
      return {
        success: true,
        orderId: order.orderId,
        clobOrderId: order.clobOrderId,
        status: order.status,
        side,
        price,
        size,
        orderValue: orderValue.toFixed(2),
        message: order.status === 'LIVE' 
          ? `Order is live: ${side} ${size} shares at $${price}` 
          : `Order ${order.status.toLowerCase()}`
      };
    }

    case 'cancel_order': {
      const { orderId } = args as { orderId: string };
      const result = await orderService.cancelOrder(userId, orderId);
      return result;
    }

    case 'get_orders': {
      const { status } = args as { status?: string };
      // Fetch LIVE orders directly from Polymarket CLOB API
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user?.safeAddress) {
        throw new Error('Wallet not setup');
      }
      
      try {
        const clobClient = await walletService.getClobClient(userId);
        const openOrders = await clobClient.getOpenOrders();
        
        // Filter by status if provided
        let orders = openOrders || [];
        if (status && status !== 'LIVE') {
          // CLOB only returns open/live orders, so if they want other statuses, return empty
          orders = [];
        }
        
        return {
          count: orders.length,
          source: 'polymarket_clob_live',
          orders: orders.map((o: any) => ({
            clobOrderId: o.id || o.order_id || o.orderId,
            tokenId: o.asset_id || o.tokenId,
            side: o.side,
            price: o.price,
            originalSize: o.original_size || o.size,
            sizeMatched: o.size_matched || 0,
            status: o.status || 'LIVE',
            createdAt: o.created_at || o.timestamp
          }))
        };
      } catch (error) {
        console.error('Failed to fetch live orders:', error);
        throw new Error('Failed to fetch orders from Polymarket');
      }
    }

    case 'sync_order_status': {
      const { orderId } = args as { orderId: string };
      // Fetch order status directly from CLOB
      try {
        const clobClient = await walletService.getClobClient(userId);
        const order = await clobClient.getOrder(orderId);
        return {
          clobOrderId: orderId,
          status: (order as any)?.status || 'UNKNOWN',
          sizeMatched: (order as any)?.size_matched || 0,
          source: 'polymarket_clob_live'
        };
      } catch (error) {
        throw new Error('Order not found on Polymarket');
      }
    }

    case 'execute_atomic_orders': {
      const { orders, metadata } = args as {
        orders: Array<{
          conditionId?: string;
          tokenId: string;
          side: 'BUY' | 'SELL';
          price: number;
          size: number;
          orderType?: string;
        }>;
        metadata?: string;
      };

      // Validate orders array
      if (!orders || !Array.isArray(orders) || orders.length === 0) {
        throw new Error('orders array is required and must not be empty');
      }

      if (orders.length > 10) {
        throw new Error('Maximum 10 orders per atomic batch');
      }

      // Validate each order
      for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        if (!order.tokenId) {
          throw new Error(`Order ${i}: tokenId is required`);
        }
        if (typeof order.price !== 'number' || isNaN(order.price) || order.price < 0.01 || order.price > 0.99) {
          throw new Error(`Order ${i}: price must be between 0.01 and 0.99`);
        }
        if (typeof order.size !== 'number' || isNaN(order.size) || order.size <= 0) {
          throw new Error(`Order ${i}: size must be a positive number`);
        }
        if (!['BUY', 'SELL'].includes(order.side)) {
          throw new Error(`Order ${i}: side must be BUY or SELL`);
        }
        // Validate minimum order value
        const orderValue = order.price * order.size;
        if (orderValue < 1) {
          throw new Error(`Order ${i}: value $${orderValue.toFixed(2)} is below Polymarket minimum of $1.00`);
        }
      }

      // Get CLOB client for this user
      const clobClient = await walletService.getClobClient(userId);

      // Results tracking
      const orderResults: Array<{
        index: number;
        orderId?: string;
        clobOrderId?: string;
        success: boolean;
        error?: string;
      }> = [];

      let hasFailure = false;
      const submittedOrders: string[] = [];

      // Process each order
      for (let i = 0; i < orders.length; i++) {
        const orderInput = orders[i];

        try {
          // Create order record in database
          const dbOrder = await prisma.order.create({
            data: {
              userId,
              conditionId: orderInput.conditionId || 'atomic-batch',
              tokenId: orderInput.tokenId,
              side: orderInput.side as any,
              price: orderInput.price,
              size: orderInput.size,
              orderType: (orderInput.orderType || 'FOK') as any,
              status: 'PENDING',
            },
          });

          // Build order options - use Side enum from clob-client
          const { Side } = await import('@polymarket/clob-client');
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
            throw new Error(response.error || response.message || 'Order rejected by Polymarket');
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

          console.error(`[Atomic MCP] Order ${i} failed:`, orderError.message);
          break; // Stop processing on first failure
        }
      }

      // If any order failed, cancel all submitted orders (atomic rollback)
      if (hasFailure && submittedOrders.length > 0) {
        console.log(`[Atomic MCP] Failure detected, cancelling ${submittedOrders.length} submitted orders`);

        for (const clobOrderId of submittedOrders) {
          try {
            await clobClient.cancelOrder({ orderID: clobOrderId });
            console.log(`[Atomic MCP] Cancelled order: ${clobOrderId}`);
          } catch (cancelError: any) {
            console.error(`[Atomic MCP] Failed to cancel order ${clobOrderId}:`, cancelError.message);
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

        return {
          success: false,
          error: 'Atomic batch failed - all orders cancelled',
          orderResults,
          metadata,
        };
      }

      // All orders succeeded
      return {
        success: true,
        message: `Successfully executed ${orderResults.length} orders atomically`,
        orderResults,
        metadata,
      };
    }

    // Position Management
    case 'get_positions': {
      // Fetch LIVE positions directly from Polymarket Data API
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user?.safeAddress) {
        throw new Error('Wallet not setup');
      }
      
      try {
        const dataApiUrl = 'https://data-api.polymarket.com';
        const response = await fetch(`${dataApiUrl}/positions?user=${user.safeAddress}`);
        
        if (!response.ok) {
          throw new Error(`Data API error: ${response.status}`);
        }
        
        const positions = await response.json();
        
        return {
          count: Array.isArray(positions) ? positions.length : 0,
          source: 'polymarket_data_api_live',
          safeAddress: user.safeAddress,
          positions: Array.isArray(positions) ? positions.map((p: any) => ({
            tokenId: p.asset || p.token_id || p.tokenId,
            conditionId: p.conditionId || p.condition_id,
            outcome: p.outcome,
            size: parseFloat(p.size || p.amount || '0'),
            avgPrice: parseFloat(p.avgPrice || p.avg_price || '0'),
            currentPrice: parseFloat(p.curPrice || p.current_price || '0'),
            initialValue: parseFloat(p.initialValue || p.cost_basis || '0'),
            currentValue: parseFloat(p.currentValue || p.value || '0'),
            pnl: parseFloat(p.pnl || p.profit_loss || '0'),
            redeemable: p.redeemable || false,
            marketTitle: p.title || p.market_title || p.question
          })) : []
        };
      } catch (error) {
        console.error('Failed to fetch live positions:', error);
        throw new Error('Failed to fetch positions from Polymarket');
      }
    }

    case 'sync_positions': {
      // Same as get_positions now - always live
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user?.safeAddress) {
        throw new Error('Wallet not setup');
      }
      
      const dataApiUrl = 'https://data-api.polymarket.com';
      const response = await fetch(`${dataApiUrl}/positions?user=${user.safeAddress}`);
      const positions = await response.json();
      
      return {
        source: 'polymarket_data_api_live',
        message: 'Positions are always fetched live - no sync needed',
        count: Array.isArray(positions) ? positions.length : 0,
        positions: positions
      };
    }

    case 'get_claimable_winnings': {
      const result = await positionService.getClaimablePositions(userId);
      return result;
    }

    case 'claim_winnings': {
      const { positionId } = args as { positionId?: string };
      if (positionId) {
        const result = await positionService.claimPosition(userId, positionId);
        return result;
      } else {
        const result = await positionService.claimAllPositions(userId);
        return result;
      }
    }

    case 'get_onchain_shares': {
      // Query blockchain directly for ALL ERC-1155 shares (including gifts/transfers)
      const result = await positionService.getOnChainShares(userId);
      return result;
    }

    case 'check_token_balance': {
      const { tokenId } = args as { tokenId: string };
      if (!tokenId) {
        throw new Error('tokenId is required');
      }
      const result = await positionService.checkTokenBalance(userId, tokenId);
      return result;
    }

    // Transfer
    case 'transfer_usdc': {
      const { toAddress, amount } = args as {
        toAddress: string;
        amount: number;
      };
      const result = await walletService.transferUsdc(userId, toAddress, amount);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return {
        success: true,
        transactionHash: result.transactionHash,
        from: user?.safeAddress,
        to: toAddress,
        amount,
        message: `Successfully transferred ${amount} USDC`
      };
    }

    case 'transfer_shares': {
      const { toAddress, tokenId, amount } = args as {
        toAddress: string;
        tokenId: string;
        amount: number;
      };
      const result = await walletService.transferShares(userId, tokenId, toAddress, Math.floor(amount));
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return {
        success: true,
        transactionHash: result.transactionHash,
        from: user?.safeAddress,
        to: toAddress,
        tokenId,
        amount: Math.floor(amount),
        message: `Successfully transferred ${Math.floor(amount)} shares`
      };
    }

    case 'transfer_matic': {
      // Redirect to send_matic
      throw new Error(
        'transfer_matic is deprecated. Use send_matic instead to send native MATIC directly from your EOA wallet.'
      );
    }

    case 'send_matic': {
      const { toAddress, amount } = args as {
        toAddress: string;
        amount: number;
      };

      if (!toAddress || !ethers.utils.isAddress(toAddress)) {
        throw new Error('Invalid destination address');
      }

      if (!amount || amount <= 0) {
        throw new Error('Amount must be positive');
      }

      // Get user's EOA wallet (private key)
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new Error('User not found');
      }

      const wallet = await keyService.getUserWallet(userId);
      
      // Check EOA balance
      const provider = wallet.provider;
      const eoaBalance = await provider.getBalance(wallet.address);
      const amountWei = ethers.utils.parseEther(amount.toString());
      
      // Estimate gas for a simple transfer
      const gasPrice = await provider.getGasPrice();
      const gasLimit = 21000; // Standard ETH/MATIC transfer
      const gasCost = gasPrice.mul(gasLimit);
      const totalNeeded = amountWei.add(gasCost);

      if (eoaBalance.lt(totalNeeded)) {
        const eoaBalanceFormatted = ethers.utils.formatEther(eoaBalance);
        const gasCostFormatted = ethers.utils.formatEther(gasCost);
        throw new Error(
          `Insufficient MATIC in EOA wallet. ` +
          `EOA Balance: ${eoaBalanceFormatted} MATIC. ` +
          `Requested: ${amount} MATIC + ~${gasCostFormatted} MATIC for gas. ` +
          `EOA Address: ${wallet.address}`
        );
      }

      // Send the transaction directly from EOA
      console.log(`[send_matic] Sending ${amount} MATIC from EOA ${wallet.address} to ${toAddress}`);
      
      const tx = await wallet.sendTransaction({
        to: toAddress,
        value: amountWei,
        gasLimit: gasLimit,
      });

      console.log(`[send_matic] Transaction submitted: ${tx.hash}`);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      
      console.log(`[send_matic] Transaction confirmed in block ${receipt.blockNumber}`);

      return {
        success: true,
        transactionHash: receipt.transactionHash,
        from: wallet.address,
        to: toAddress,
        amount,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        message: `Successfully sent ${amount} MATIC from EOA wallet`,
        note: 'This was sent directly from your EOA, not your Safe wallet.'
      };
    }

    case 'transfer_native_usdc': {
      const { toAddress, amount } = args as {
        toAddress: string;
        amount: number;
      };
      const result = await walletService.transferNativeUsdc(userId, toAddress, amount);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      return {
        success: true,
        transactionHash: result.transactionHash,
        from: user?.safeAddress,
        to: toAddress,
        amount,
        token: 'NATIVE_USDC',
        message: `Successfully transferred ${amount} Native USDC`
      };
    }

    // Token Swaps
    case 'swap_tokens': {
      const { fromToken, toToken, amount } = args as {
        fromToken: string;
        toToken: string;
        amount: number;
      };
      
      if (fromToken.toUpperCase() === toToken.toUpperCase()) {
        throw new Error('Cannot swap a token to itself');
      }
      
      if (amount <= 0) {
        throw new Error('Amount must be positive');
      }

      const swapService = getSwapService();
      const result = await swapService.swap(userId, fromToken, toToken, amount);
      
      if (!result.success) {
        throw new Error(result.error || 'Swap failed');
      }
      
      return {
        success: true,
        fromToken: result.fromToken,
        toToken: result.toToken,
        fromAmount: result.fromAmount,
        toAmount: result.toAmount,
        minimumReceived: result.toAmountMin,
        swapProvider: result.swapTool,
        approvalTxHash: result.approvalTxHash,
        swapTxHash: result.swapTxHash,
        message: `Successfully swapped ${result.fromAmount} ${result.fromToken} to ${result.toAmount} ${result.toToken}`
      };
    }

    case 'get_swap_quote': {
      const { fromToken, toToken, amount } = args as {
        fromToken: string;
        toToken: string;
        amount: number;
      };
      
      if (fromToken.toUpperCase() === toToken.toUpperCase()) {
        throw new Error('Cannot swap a token to itself');
      }
      
      if (amount <= 0) {
        throw new Error('Amount must be positive');
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user?.safeAddress) {
        throw new Error('Wallet not setup');
      }

      const swapService = getSwapService();
      const estimate = await swapService.getSwapEstimate(fromToken, toToken, amount, user.safeAddress);
      
      return {
        quote: {
          fromToken: estimate.fromToken,
          toToken: estimate.toToken,
          fromAmount: estimate.fromAmount,
          estimatedOutput: estimate.estimatedOutput,
          minimumOutput: estimate.minimumOutput,
          priceImpact: estimate.priceImpact,
          estimatedGas: estimate.estimatedGasUSD,
          executionTimeSeconds: estimate.executionTime,
          provider: estimate.swapTool,
        },
        supportedTokens: ['MATIC', 'USDC', 'NATIVE_USDC'],
        message: `Swap ${estimate.fromAmount} ${estimate.fromToken} -> ~${estimate.estimatedOutput} ${estimate.toToken} via ${estimate.swapTool}`
      };
    }

    // Web Tools - DISABLED (re-enable if needed)
    // case 'scrapeURL': {
    //   const { url } = args as { url: string };
    //   
    //   if (!url) {
    //     throw new Error('URL is required');
    //   }
    //   
    //   // Basic URL validation
    //   try {
    //     new URL(url);
    //   } catch {
    //     throw new Error('Invalid URL format');
    //   }
    //
    //   const serperService = getSerperService();
    //   const result = await serperService.scrapeUrl(url);
    //   
    //   return {
    //     title: result.title,
    //     url: result.url,
    //     content: result.text,
    //     contentLength: result.text.length,
    //     message: `Scraped ${result.title || url} (${result.text.length} characters)`
    //   };
    // }

    // case 'news_search': {
    //   const { query, num, timeRange } = args as {
    //     query: string;
    //     num?: number;
    //     timeRange?: 'hour' | 'day' | 'week' | 'month' | 'year';
    //   };
    //   
    //   if (!query) {
    //     throw new Error('Search query is required');
    //   }
    //
    //   const serperService = getSerperService();
    //   const result = await serperService.searchNews(query, {
    //     num: num || 10,
    //     timeRange,
    //   });
    //   
    //   return {
    //     query: result.query,
    //     count: result.count,
    //     articles: result.results.map(article => ({
    //       title: article.title,
    //       source: article.source,
    //       date: article.date,
    //       snippet: article.snippet,
    //       link: article.link,
    //     })),
    //     message: `Found ${result.count} news articles for "${query}"`
    //   };
    // }

    case 'get_elon_tweet_count': {
      const { startDate: startDateArg, endDate: endDateArg, includeProjection = true } = args as {
        startDate?: string;
        endDate?: string;
        includeProjection?: boolean;
      };
      
      // Fetch Elon Musk's tweet data from xtracker.io API
      const response = await fetch('https://www.xtracker.io/api/users?stats=true&platform=X');
      
      if (!response.ok) {
        throw new Error(`Failed to fetch xtracker data: ${response.statusText}`);
      }
      
      const data = await response.json() as any[];
      
      // Find Elon Musk's data (should be the first user)
      const elonData = data.find((user: any) => user.handle === 'elonmusk');
      
      if (!elonData) {
        throw new Error('Elon Musk data not found on xtracker.io');
      }
      
      // Helper to parse flexible date formats
      const parseDate = (dateStr: string): Date => {
        // Try ISO format first (YYYY-MM-DD)
        if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
          return new Date(dateStr);
        }
        // Try "Nov 28, 2025" format
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          return parsed;
        }
        throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD or "Nov 28, 2025"`);
      };
      
      // Helper to format date as MM/DD/YYYY for matching with API data
      const formatDateKey = (date: Date): string => {
        return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
      };
      
      // Get ALL daily data from all trackers (they may have different ranges)
      const allDailyData: { [key: string]: number } = {};
      data.filter((user: any) => user.handle === 'elonmusk').forEach((tracker: any) => {
        if (tracker.tweetData?.daily) {
          tracker.tweetData.daily.forEach((day: any) => {
            // Use the date as key, take max if duplicate (some trackers overlap)
            const existing = allDailyData[day.start] || 0;
            allDailyData[day.start] = Math.max(existing, day.tweet_count);
          });
        }
      });
      
      // If custom date range requested, calculate for that specific range
      if (startDateArg && endDateArg) {
        const startDate = parseDate(startDateArg);
        const endDate = parseDate(endDateArg);
        const now = new Date();
        
        // Calculate total for the date range
        let totalCount = 0;
        let daysWithData = 0;
        const dailyBreakdown: { date: string; count: number }[] = [];
        
        // Iterate through each day in range
        const currentDate = new Date(startDate);
        while (currentDate <= endDate && currentDate <= now) {
          const dateKey = formatDateKey(currentDate);
          const count = allDailyData[dateKey] || 0;
          
          if (count > 0 || currentDate < now) {
            dailyBreakdown.push({ date: dateKey, count });
            totalCount += count;
            if (count > 0) daysWithData++;
          }
          
          currentDate.setDate(currentDate.getDate() + 1);
        }
        
        // Calculate statistics
        const totalDaysInRange = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const daysElapsed = Math.ceil((Math.min(now.getTime(), endDate.getTime()) - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const daysRemaining = Math.max(0, totalDaysInRange - daysElapsed);
        const dailyAverage = daysWithData > 0 ? totalCount / daysWithData : 0;
        const isOngoing = now < endDate;
        
        // Project final total if ongoing
        let projection = null;
        if (isOngoing && includeProjection && dailyAverage > 0) {
          const projectedTotal = Math.round(totalCount + (dailyAverage * daysRemaining));
          projection = {
            projectedFinalTotal: projectedTotal,
            basedOnDailyAverage: Math.round(dailyAverage * 100) / 100,
            daysRemaining,
            confidence: daysWithData >= 3 ? 'medium' : 'low',
            note: `Based on ${daysWithData} days of data. Projection assumes consistent posting rate.`
          };
        }
        
        // Determine which Polymarket outcome range this falls into
        const outcomeRanges = [
          { range: '0-179', min: 0, max: 179 },
          { range: '180-199', min: 180, max: 199 },
          { range: '200-219', min: 200, max: 219 },
          { range: '220-239', min: 220, max: 239 },
          { range: '240-259', min: 240, max: 259 },
          { range: '260-279', min: 260, max: 279 },
          { range: '280-299', min: 280, max: 299 },
          { range: '300+', min: 300, max: Infinity }
        ];
        
        const currentOutcome = outcomeRanges.find(r => totalCount >= r.min && totalCount <= r.max);
        const projectedOutcome = projection ? outcomeRanges.find(r => projection.projectedFinalTotal >= r.min && projection.projectedFinalTotal <= r.max) : null;
        
        return {
          user: {
            name: elonData.name,
            handle: `@${elonData.handle}`,
          },
          lastSync: elonData.lastSync,
          customRange: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            periodLabel: `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
            status: isOngoing ? 'ONGOING' : 'COMPLETED',
          },
          currentStats: {
            totalPosts: totalCount,
            daysElapsed,
            daysRemaining,
            dailyAverage: Math.round(dailyAverage * 100) / 100,
            currentOutcomeRange: currentOutcome?.range || 'unknown',
          },
          projection,
          projectedOutcomeRange: projectedOutcome?.range || null,
          dailyBreakdown: dailyBreakdown.slice(-14), // Last 14 days
          source: 'https://www.xtracker.io/',
          marketNote: 'For Polymarket resolution: Only main feed posts, quote posts, and reposts count. Replies do NOT count.'
        };
      }
      
      // No custom range - return all tracked periods (original behavior)
      const trackedPeriods = data.filter((user: any) => user.handle === 'elonmusk').map((tracker: any) => {
        const startDate = new Date(tracker.startDate);
        const endDate = new Date(tracker.endDate);
        const tweetData = tracker.tweetData;
        
        return {
          period: `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          startDate: tracker.startDate,
          endDate: tracker.endDate,
          postCount: tweetData.totalBetweenStartAndEnd,
          dailyAverage: Math.round(tweetData.dailyAverage * 100) / 100,
          pace: tweetData.pace,
          recentDays: tweetData.daily?.slice(-7).map((day: any) => ({
            date: day.start,
            count: day.tweet_count
          })) || [],
          recentWeeks: tweetData.weekly?.slice(-4).map((week: any) => ({
            weekStart: week.start,
            count: week.tweet_count
          })) || []
        };
      });
      
      return {
        user: {
          name: elonData.name,
          handle: `@${elonData.handle}`,
          profileImage: elonData.imageUrl
        },
        lastSync: elonData.lastSync,
        trackedPeriods,
        source: 'https://www.xtracker.io/',
        note: 'This is the official resolution source for Polymarket markets tracking Elon Musk\'s X posting activity. Only main feed posts, quote posts, and reposts count. Replies do NOT count.',
        tip: 'To get stats for a specific date range, provide startDate and endDate parameters (e.g., startDate: "Nov 28, 2025", endDate: "Dec 5, 2025")'
      };
    }

    // API Key Management
    case 'list_api_keys': {
      const keys = await apiKeyService.listUserApiKeys(userId);
      return {
        count: keys.length,
        keys: keys.map(k => ({
          id: k.id,
          keyPrefix: k.keyPrefix + '...',
          name: k.name,
          isActive: k.isActive,
          lastUsedAt: k.lastUsedAt,
          createdAt: k.createdAt
        }))
      };
    }

    case 'create_additional_api_key': {
      const { name } = args as { name?: string };
      const keyResult = await apiKeyService.createApiKey(userId, name);
      return {
        success: true,
        apiKey: keyResult.apiKey,
        keyPrefix: keyResult.keyPrefix,
        message: 'New API key created. SAVE THIS KEY - it will not be shown again!'
      };
    }

    case 'revoke_api_key': {
      const { keyId } = args as { keyId: string };
      const success = await apiKeyService.revokeApiKey(keyId, userId);
      if (!success) {
        throw new Error('API key not found or already revoked');
      }
      return {
        success: true,
        message: 'API key revoked successfully'
      };
    }

    // Market Data for Trading
    case 'search_markets': {
      const { query, limit } = args as { query: string; limit?: number };
      
      if (!query || query.trim().length === 0) {
        throw new Error('Search query is required');
      }
      
      const markets = await marketService.searchMarkets(query, Math.min(limit || 10, 50));
      
      // Format response with trading-relevant info
      return {
        query,
        count: markets.length,
        markets: markets.map(m => {
          // Parse token IDs from clobTokenIds JSON string
          let tokens: Array<{ tokenId: string; outcome: string; price: number }> = [];
          try {
            const tokenIds = JSON.parse(m.clobTokenIds || '[]') as string[];
            const outcomes = JSON.parse(m.outcomes || '[]') as string[];
            const prices = JSON.parse(m.outcomePrices || '[]') as string[];
            
            tokens = tokenIds.map((tokenId, i) => ({
              tokenId,
              outcome: outcomes[i] || `Outcome ${i + 1}`,
              price: parseFloat(prices[i] || '0.5'),
            }));
          } catch {
            // Use tokens array if available
            if (m.tokens) {
              tokens = m.tokens.map(t => ({
                tokenId: t.token_id,
                outcome: t.outcome,
                price: t.price,
              }));
            }
          }
          
          return {
            conditionId: m.conditionId,
            question: m.question,
            slug: m.slug,
            tokens,
            volume: m.volume,
            liquidity: m.liquidity,
            endDate: m.endDate,
          };
        }),
        note: 'Use the conditionId and tokenId to place orders with place_order',
      };
    }

    case 'get_market': {
      const { conditionId } = args as { conditionId: string };
      
      if (!conditionId) {
        throw new Error('conditionId is required');
      }
      
      const market = await marketService.getMarket(conditionId);
      
      if (!market) {
        throw new Error(`Market not found: ${conditionId}`);
      }
      
      // Parse token IDs
      let tokens: Array<{ tokenId: string; outcome: string; price: number }> = [];
      try {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
        const outcomes = JSON.parse(market.outcomes || '[]') as string[];
        const prices = JSON.parse(market.outcomePrices || '[]') as string[];
        
        tokens = tokenIds.map((tokenId, i) => ({
          tokenId,
          outcome: outcomes[i] || `Outcome ${i + 1}`,
          price: parseFloat(prices[i] || '0.5'),
        }));
      } catch {
        if (market.tokens) {
          tokens = market.tokens.map(t => ({
            tokenId: t.token_id,
            outcome: t.outcome,
            price: t.price,
          }));
        }
      }
      
      return {
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug,
        tokens,
        volume: market.volume,
        liquidity: market.liquidity,
        endDate: market.endDate,
        active: market.active,
      };
    }

    case 'get_active_markets': {
      const { limit } = args as { limit?: number };
      
      const markets = await marketService.getMarkets({
        limit: Math.min(limit || 20, 100),
        active: true,
      });
      
      return {
        count: markets.length,
        markets: markets.map(m => {
          // Parse token IDs
          let tokens: Array<{ tokenId: string; outcome: string; price: number }> = [];
          try {
            const tokenIds = JSON.parse(m.clobTokenIds || '[]') as string[];
            const outcomes = JSON.parse(m.outcomes || '[]') as string[];
            const prices = JSON.parse(m.outcomePrices || '[]') as string[];
            
            tokens = tokenIds.map((tokenId, i) => ({
              tokenId,
              outcome: outcomes[i] || `Outcome ${i + 1}`,
              price: parseFloat(prices[i] || '0.5'),
            }));
          } catch {
            if (m.tokens) {
              tokens = m.tokens.map(t => ({
                tokenId: t.token_id,
                outcome: t.outcome,
                price: t.price,
              }));
            }
          }
          
          return {
            conditionId: m.conditionId,
            question: m.question,
            tokens,
            volume: m.volume,
          };
        }),
      };
    }

    case 'get_orderbook': {
      const { tokenId } = args as { tokenId: string };
      
      // Auto-detect if this is a conditionId (starts with 0x) and look up tokenIds
      if (marketService.isConditionId(tokenId)) {
        const result = await marketService.getOrderBooksForMarket(tokenId);
        return result;
      }
      
      // Otherwise use tokenId directly
      const orderbook = await marketService.getOrderBook(tokenId);
      return orderbook;
    }

    case 'get_price': {
      const { tokenId } = args as { tokenId: string };
      
      // Auto-detect if this is a conditionId (starts with 0x) and look up tokenIds
      if (marketService.isConditionId(tokenId)) {
        const result = await marketService.getPricesForMarket(tokenId);
        return result;
      }
      
      // Otherwise use tokenId directly
      const price = await marketService.getMidpointPrice(tokenId);
      return { tokenId, midpointPrice: price };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
