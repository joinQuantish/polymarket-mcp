import { ethers } from 'ethers';
import { RelayClient, OperationType, SafeTransaction } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { prisma } from '../db';
import { config } from '../config';
import { getKeyService } from './key.service';
import { getProvider } from './provider.service';

const DATA_API_URL = 'https://data-api.polymarket.com';

// CTF contract ABI for redeeming
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

// CTF Exchange contract address (ERC-1155 token contract for Polymarket shares)
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Neg Risk Adapter ABI - takes amounts [yesTokenAmount, noTokenAmount], NOT indexSets!
const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

export interface PositionData {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  negativeRisk: boolean;
  endDate: string;
}

export class PositionService {
  private keyService = getKeyService();
  private provider: ethers.providers.JsonRpcProvider;

  constructor() {
    this.provider = getProvider(); // Use shared provider with retry logic
  }

  /**
   * Sync positions for a user from Polymarket Data API
   */
  async syncPositions(userId: string): Promise<{ synced: number; positions: any[] }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    // Fetch positions from Data API
    const response = await fetch(
      `${DATA_API_URL}/positions?user=${user.safeAddress}&sizeThreshold=0`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch positions: ${response.statusText}`);
    }

    const positions = (await response.json()) as PositionData[];

    // Upsert each position
    let synced = 0;
    for (const pos of positions) {
      await prisma.position.upsert({
        where: {
          userId_tokenId: {
            userId,
            tokenId: pos.asset,
          },
        },
        create: {
          userId,
          conditionId: pos.conditionId,
          tokenId: pos.asset,
          outcome: pos.outcome,
          size: pos.size,
          avgPrice: pos.avgPrice,
          currentPrice: pos.curPrice,
          initialValue: pos.initialValue,
          currentValue: pos.currentValue,
          realizedPnl: pos.realizedPnl,
          marketTitle: pos.title,
          marketSlug: pos.slug,
          negativeRisk: pos.negativeRisk,
          redeemable: pos.redeemable,
          mergeable: pos.mergeable,
          lastSyncedAt: new Date(),
        },
        update: {
          size: pos.size,
          currentPrice: pos.curPrice,
          currentValue: pos.currentValue,
          realizedPnl: pos.realizedPnl,
          redeemable: pos.redeemable,
          mergeable: pos.mergeable,
          lastSyncedAt: new Date(),
        },
      });
      synced++;
    }

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'POSITIONS_SYNCED',
        resource: 'position',
        details: { count: synced },
      },
    });

    // Return synced positions
    const updatedPositions = await prisma.position.findMany({
      where: { userId },
      orderBy: { currentValue: 'desc' },
    });

    return { synced, positions: updatedPositions };
  }

  /**
   * Get all positions for a user
   */
  async getPositions(userId: string): Promise<any[]> {
    return prisma.position.findMany({
      where: { userId },
      orderBy: { currentValue: 'desc' },
    });
  }

  /**
   * Get claimable (redeemable) positions
   */
  async getClaimablePositions(userId: string): Promise<any[]> {
    // First sync to get latest data
    await this.syncPositions(userId);

    return prisma.position.findMany({
      where: {
        userId,
        redeemable: true,
        size: { gt: 0 },
      },
      orderBy: { currentValue: 'desc' },
    });
  }

  /**
   * Get builder config for relayer transactions
   */
  private getBuilderConfig(): { localBuilderCreds: { key: string; secret: string; passphrase: string } } | undefined {
    if (config.builder.apiKey && config.builder.secret && config.builder.passphrase) {
      return {
        localBuilderCreds: {
          key: config.builder.apiKey,
          secret: config.builder.secret,
          passphrase: config.builder.passphrase,
        },
      };
    }
    return undefined;
  }

  /**
   * Claim/redeem winning positions via Polymarket Relayer (GASLESS)
   * Returns the USDC value that will be received
   */
  async claimPosition(userId: string, positionId: string): Promise<{
    success: boolean;
    txHash?: string;
    value?: number;
    message: string;
  }> {
    const position = await prisma.position.findUnique({
      where: { id: positionId },
      include: { user: true },
    });

    if (!position) {
      throw new Error('Position not found');
    }

    if (position.userId !== userId) {
      throw new Error('Position does not belong to user');
    }

    if (!position.redeemable) {
      throw new Error('Position is not redeemable');
    }

    if (!position.user.safeAddress) {
      throw new Error('Safe wallet not deployed');
    }

    try {
      const wallet = await this.keyService.getUserWallet(userId);
      
      // Determine which contract and method to use based on position type
      const isNegativeRisk = position.negativeRisk || false;
      
      // Build the redemption transaction
      let redeemTx: SafeTransaction;
      let contractAddress: string;
      
      // Get the position size in raw units (the contract expects raw token amounts)
      const positionSizeRaw = ethers.utils.parseUnits(position.size.toString(), 6);
      
      // Determine if this is a YES or NO position based on outcome
      const isYesPosition = position.outcome?.toLowerCase() === 'yes';
      
      console.log(`Claiming position ${positionId} for user ${userId}`);
      console.log(`Position: ${position.outcome}, Size: ${position.size}, Market: ${position.marketTitle}`);
      console.log(`Negative Risk: ${isNegativeRisk}, ConditionId: ${position.conditionId}`);
      console.log(`isYesPosition: ${isYesPosition}, Raw size: ${positionSizeRaw.toString()}`);

      if (isNegativeRisk) {
        // Use Neg Risk Adapter for negative risk markets
        // NegRiskAdapter.redeemPositions takes: (conditionId, amounts[])
        // where amounts = [yesTokenAmount, noTokenAmount]
        contractAddress = config.contracts.negRiskAdapter;
        const negRiskInterface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
        
        // Build amounts array: [yesAmount, noAmount]
        const amounts = isYesPosition 
          ? [positionSizeRaw, ethers.BigNumber.from(0)]  // YES position
          : [ethers.BigNumber.from(0), positionSizeRaw]; // NO position
        
        console.log(`NegRisk amounts: [${amounts[0].toString()}, ${amounts[1].toString()}]`);
        
        const redeemData = negRiskInterface.encodeFunctionData('redeemPositions', [
          position.conditionId,
          amounts,
        ]);

        redeemTx = {
          operation: OperationType.Call,
          to: contractAddress,
          data: redeemData,
          value: '0',
        };
      } else {
        // Use CTF (Conditional Tokens Framework) for regular (non-negRisk) markets
        // CTF.redeemPositions takes: (collateralToken, parentCollectionId, conditionId, indexSets[])
        // indexSets: 1 = YES (binary 01), 2 = NO (binary 10)
        // NOTE: Use CTF contract (0x4D97...), NOT the CTF Exchange (trading contract)!
        contractAddress = config.contracts.ctf;
        const ctfInterface = new ethers.utils.Interface(CTF_ABI);
        
        // For binary markets: indexSet 1 = YES, indexSet 2 = NO
        // Pass both and the contract will redeem whatever we have
        const indexSets = [1, 2];
        
        console.log(`CTF indexSets: [${indexSets.join(', ')}]`);
        
        const redeemData = ctfInterface.encodeFunctionData('redeemPositions', [
          config.contracts.usdc,           // collateralToken
          ethers.constants.HashZero,       // parentCollectionId (0 for root)
          position.conditionId,            // conditionId
          indexSets,                       // Both outcomes
        ]);

        redeemTx = {
          operation: OperationType.Call,
          to: contractAddress,
          data: redeemData,
          value: '0',
        };
      }

      console.log(`Contract: ${contractAddress}`);
      console.log(`Executing redemption via Polymarket Relayer...`);

      // Execute via Polymarket Relayer (GASLESS!)
      const builderConfig = this.getBuilderConfig();
      if (!builderConfig) {
        throw new Error('Builder credentials not configured - required for gasless redemption');
      }

      const relayClient = new RelayClient(
        config.polymarket.relayerUrl,
        config.polygon.chainId,
        wallet,
        new BuilderConfig(builderConfig)
      );

      const response = await relayClient.execute(
        [redeemTx],
        `Redeem position: ${position.outcome} on ${position.marketTitle || 'market'}`
      );

      console.log('Redemption transaction submitted, waiting for confirmation...');
      console.log('Transaction ID:', response.transactionID);

      // Poll until confirmed
      const result = await relayClient.pollUntilState(
        response.transactionID,
        ['STATE_CONFIRMED', 'STATE_MINED'],
        'STATE_FAILED',
        60,  // timeout seconds
        2000 // poll interval ms
      );

      if (!result || !result.transactionHash) {
        throw new Error('Redemption transaction failed or timed out');
      }

      console.log('Redemption confirmed! TX:', result.transactionHash);

      // Update position as claimed
      await prisma.position.update({
        where: { id: positionId },
        data: {
          size: 0,
          redeemable: false,
          currentValue: 0,
        },
      });

      // Log transaction
      await prisma.transaction.create({
        data: {
          userId,
          type: 'REDEEM_POSITION',
          status: 'EXECUTED',
          txHash: result.transactionHash,
          metadata: {
            positionId,
            conditionId: position.conditionId,
            tokenId: position.tokenId,
            size: position.size,
            value: position.currentValue,
            txHash: result.transactionHash,
          },
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'POSITION_CLAIMED',
          resource: 'position',
          resourceId: positionId,
          details: {
            conditionId: position.conditionId,
            size: position.size,
            value: position.currentValue,
            txHash: result.transactionHash,
          },
        },
      });

      return {
        success: true,
        txHash: result.transactionHash,
        value: position.currentValue || position.size,
        message: `Successfully claimed ${position.size} shares worth $${position.currentValue?.toFixed(2) || position.size}. TX: ${result.transactionHash}`,
      };
    } catch (error) {
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'POSITION_CLAIM_FAILED',
          resource: 'position',
          resourceId: positionId,
          success: false,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      throw error;
    }
  }

  /**
   * Claim all redeemable positions for a user
   */
  async claimAllPositions(userId: string): Promise<{
    claimed: number;
    totalValue: number;
    results: any[];
  }> {
    const claimable = await this.getClaimablePositions(userId);

    const results = [];
    let totalValue = 0;

    for (const position of claimable) {
      try {
        const result = await this.claimPosition(userId, position.id);
        results.push({ positionId: position.id, ...result });
        totalValue += result.value || 0;
      } catch (error) {
        results.push({
          positionId: position.id,
          success: false,
          message: error instanceof Error ? error.message : 'Failed to claim',
        });
      }
    }

    return {
      claimed: results.filter(r => r.success).length,
      totalValue,
      results,
    };
  }

  /**
   * Check for claimable winnings (without syncing - quick check)
   */
  async checkClaimable(userId: string): Promise<{
    hasClaimable: boolean;
    count: number;
    totalValue: number;
    positions: any[];
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    // Quick check from Data API with redeemable filter
    const response = await fetch(
      `${DATA_API_URL}/positions?user=${user.safeAddress}&redeemable=true&sizeThreshold=0`
    );

    if (!response.ok) {
      throw new Error(`Failed to check claimable: ${response.statusText}`);
    }

    const positions = (await response.json()) as PositionData[];
    const totalValue = positions.reduce((sum, p) => sum + (p.currentValue || p.size), 0);

    return {
      hasClaimable: positions.length > 0,
      count: positions.length,
      totalValue,
      positions: positions.map(p => ({
        conditionId: p.conditionId,
        tokenId: p.asset,
        outcome: p.outcome,
        size: p.size,
        value: p.currentValue || p.size,
        title: p.title,
      })),
    };
  }

  /**
   * Get positions summary for a user
   */
  async getPositionsSummary(userId: string): Promise<{
    totalPositions: number;
    totalValue: number;
    totalPnl: number;
    claimableCount: number;
    claimableValue: number;
  }> {
    const positions = await prisma.position.findMany({
      where: { userId, size: { gt: 0 } },
    });

    const claimable = positions.filter(p => p.redeemable);

    return {
      totalPositions: positions.length,
      totalValue: positions.reduce((sum, p) => sum + (p.currentValue || 0), 0),
      totalPnl: positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0),
      claimableCount: claimable.length,
      claimableValue: claimable.reduce((sum, p) => sum + (p.currentValue || p.size), 0),
    };
  }

  /**
   * Get on-chain shares for a user (includes gifted/transferred shares not tracked by Polymarket API)
   * This queries the blockchain directly for ERC-1155 transfer events to find all token IDs
   */
  async getOnChainShares(userId: string): Promise<{
    safeAddress: string;
    shares: Array<{
      tokenId: string;
      balance: string;
      balanceFormatted: number;
      source: 'transfer' | 'trade';
    }>;
    totalShares: number;
    note: string;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const safeAddress = user.safeAddress;

    // Query for TransferSingle and TransferBatch events TO this address
    // This finds all ERC-1155 tokens ever received (including gifts)
    const ctfContract = new ethers.Contract(CTF_CONTRACT, [
      'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
      'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
      'function balanceOf(address owner, uint256 id) view returns (uint256)',
    ], this.provider);

    // Get recent blocks (last ~7 days on Polygon is roughly 300k blocks)
    const currentBlock = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 300000); // Last ~7 days

    console.log(`Querying on-chain shares for ${safeAddress} from block ${fromBlock} to ${currentBlock}`);

    // Collect unique token IDs from transfer events
    const tokenIds = new Set<string>();

    try {
      // Query TransferSingle events where 'to' is the Safe address
      const singleFilter = ctfContract.filters.TransferSingle(null, null, safeAddress);
      const singleEvents = await ctfContract.queryFilter(singleFilter, fromBlock, currentBlock);
      
      for (const event of singleEvents) {
        if (event.args) {
          tokenIds.add(event.args.id.toString());
        }
      }

      // Query TransferBatch events where 'to' is the Safe address  
      const batchFilter = ctfContract.filters.TransferBatch(null, null, safeAddress);
      const batchEvents = await ctfContract.queryFilter(batchFilter, fromBlock, currentBlock);
      
      for (const event of batchEvents) {
        if (event.args && event.args.ids) {
          for (const id of event.args.ids) {
            tokenIds.add(id.toString());
          }
        }
      }
    } catch (error) {
      console.warn('Error querying transfer events:', error);
      // Continue - we might still have some token IDs
    }

    console.log(`Found ${tokenIds.size} unique token IDs from transfer events`);

    // Now check the current balance of each token ID
    const shares: Array<{
      tokenId: string;
      balance: string;
      balanceFormatted: number;
      source: 'transfer' | 'trade';
    }> = [];

    // Also check positions from Polymarket API to compare
    let apiPositionTokenIds = new Set<string>();
    try {
      const response = await fetch(
        `${DATA_API_URL}/positions?user=${safeAddress}&sizeThreshold=0`
      );
      if (response.ok) {
        const positions = await response.json() as PositionData[];
        for (const pos of positions) {
          apiPositionTokenIds.add(pos.asset);
        }
      }
    } catch (e) {
      // Ignore API errors
    }

    for (const tokenId of tokenIds) {
      try {
        const balance = await ctfContract.balanceOf(safeAddress, tokenId);
        const balanceNum = parseFloat(ethers.utils.formatUnits(balance, 6)); // Shares use 6 decimals
        
        if (balanceNum > 0) {
          shares.push({
            tokenId,
            balance: balance.toString(),
            balanceFormatted: balanceNum,
            // Mark as 'transfer' if not in API positions, otherwise 'trade'
            source: apiPositionTokenIds.has(tokenId) ? 'trade' : 'transfer',
          });
        }
      } catch (e) {
        console.warn(`Error checking balance for token ${tokenId}:`, e);
      }
    }

    // Sort by balance descending
    shares.sort((a, b) => b.balanceFormatted - a.balanceFormatted);

    return {
      safeAddress,
      shares,
      totalShares: shares.length,
      note: shares.some(s => s.source === 'transfer') 
        ? 'Found shares received via direct transfer (gifts) that may not appear in Polymarket positions!'
        : 'All shares were acquired via Polymarket trades.',
    };
  }

  /**
   * Check balance of a specific token ID for a user (direct on-chain query)
   */
  async checkTokenBalance(userId: string, tokenId: string): Promise<{
    safeAddress: string;
    tokenId: string;
    balance: string;
    balanceFormatted: number;
    inPolymarketApi: boolean;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const ctfContract = new ethers.Contract(CTF_CONTRACT, CTF_ABI, this.provider);
    const balance = await ctfContract.balanceOf(user.safeAddress, tokenId);
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, 6));

    // Check if this is in Polymarket API
    let inPolymarketApi = false;
    try {
      const response = await fetch(
        `${DATA_API_URL}/positions?user=${user.safeAddress}&sizeThreshold=0`
      );
      if (response.ok) {
        const positions = await response.json() as PositionData[];
        inPolymarketApi = positions.some(p => p.asset === tokenId);
      }
    } catch (e) {
      // Ignore
    }

    return {
      safeAddress: user.safeAddress,
      tokenId,
      balance: balance.toString(),
      balanceFormatted,
      inPolymarketApi,
    };
  }
}

// Singleton
let positionServiceInstance: PositionService | null = null;

export function getPositionService(): PositionService {
  if (!positionServiceInstance) {
    positionServiceInstance = new PositionService();
  }
  return positionServiceInstance;
}

