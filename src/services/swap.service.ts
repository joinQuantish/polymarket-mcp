import { ethers } from 'ethers';
import { RelayClient, OperationType, SafeTransaction } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getKeyService } from './key.service';
import { getProvider } from './provider.service';
import { prisma } from '../db';
import { config } from '../config';

/**
 * SwapService
 * 
 * Enables token swaps on Polygon using LI.FI as a DEX aggregator.
 * Gets best quotes from LI.FI, then executes via our Safe wallet and Polymarket relayer.
 * 
 * Supported tokens:
 * - MATIC (native)
 * - USDC.e (bridged Polymarket USDC)
 * - Native USDC (Circle)
 */

// Token addresses on Polygon
// NOTE: We use WMATIC for swaps because native MATIC requires sending value,
// which doesn't work well with Safe wallet relayer signatures.
const TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  'MATIC': {
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // Use WMATIC for swaps
    decimals: 18,
    symbol: 'WMATIC'
  },
  'WMATIC': {
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    decimals: 18,
    symbol: 'WMATIC'
  },
  'POL': {
    address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // POL is same as MATIC/WMATIC
    decimals: 18,
    symbol: 'WMATIC'
  },
  'USDC': {
    address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e (bridged)
    decimals: 6,
    symbol: 'USDC.e'
  },
  'USDC.e': {
    address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    decimals: 6,
    symbol: 'USDC.e'
  },
  'NATIVE_USDC': {
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
    symbol: 'USDC'
  }
};

// ERC20 interface for approvals
const erc20Interface = new ethers.utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// WMATIC interface for wrapping/unwrapping
const wmaticInterface = new ethers.utils.Interface([
  'function deposit() payable',
  'function withdraw(uint256 amount)',
]);

// Native MATIC address (for balance checks)
const NATIVE_MATIC_ADDRESS = '0x0000000000000000000000000000000000000000';
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

// LI.FI API base URL
const LIFI_API_URL = 'https://li.quest/v1';

interface LiFiQuote {
  id: string;
  type: string;
  tool: string;
  action: {
    fromToken: { address: string; symbol: string; decimals: number; priceUSD: string };
    toToken: { address: string; symbol: string; decimals: number; priceUSD: string };
    fromAmount: string;
    slippage: number;
    fromChainId: number;
    toChainId: number;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
    gasCosts: Array<{ amount: string; amountUSD: string }>;
    feeCosts: Array<{ amount: string; amountUSD: string }>;
  };
  transactionRequest: {
    to: string;
    from: string;
    data: string;
    value: string;
    gasLimit: string;
    gasPrice?: string;
  };
}

export class SwapService {
  private keyService = getKeyService();
  private provider: ethers.providers.JsonRpcProvider;

  constructor() {
    this.provider = getProvider(); // Use shared provider with retry logic
  }

  /**
   * Get token info by symbol or address
   */
  getTokenInfo(tokenInput: string): { address: string; decimals: number; symbol: string } | null {
    // Check if it's a known symbol
    const upperInput = tokenInput.toUpperCase();
    if (TOKENS[upperInput]) {
      return TOKENS[upperInput];
    }
    
    // Check if it's an address matching a known token
    const lowerInput = tokenInput.toLowerCase();
    for (const [, info] of Object.entries(TOKENS)) {
      if (info.address.toLowerCase() === lowerInput) {
        return info;
      }
    }
    
    return null;
  }

  /**
   * Get a swap quote from LI.FI API
   */
  async getSwapQuote(
    fromToken: string,
    toToken: string,
    amount: number,
    fromAddress: string
  ): Promise<LiFiQuote> {
    const fromTokenInfo = this.getTokenInfo(fromToken);
    const toTokenInfo = this.getTokenInfo(toToken);

    if (!fromTokenInfo) {
      throw new Error(`Unknown from token: ${fromToken}. Supported: MATIC, USDC, USDC.e, NATIVE_USDC`);
    }
    if (!toTokenInfo) {
      throw new Error(`Unknown to token: ${toToken}. Supported: MATIC, USDC, USDC.e, NATIVE_USDC`);
    }

    // Convert amount to smallest unit
    const fromAmount = ethers.utils.parseUnits(amount.toString(), fromTokenInfo.decimals).toString();

    // Build LI.FI quote request
    const params = new URLSearchParams({
      fromChain: '137', // Polygon
      toChain: '137',   // Polygon (same-chain swap)
      fromToken: fromTokenInfo.address,
      toToken: toTokenInfo.address,
      fromAmount: fromAmount,
      fromAddress: fromAddress,
      slippage: '0.01', // 1% slippage
      integrator: 'polymarket-mcp-server',
    });

    console.log(`Fetching LI.FI quote: ${fromTokenInfo.symbol} -> ${toTokenInfo.symbol}, amount: ${amount}`);

    let lastError: Error | null = null;
    
    // Retry logic for API calls
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${LIFI_API_URL}/quote?${params}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({})) as { message?: string };
          throw new Error(`LI.FI API error: ${response.status} - ${errorData?.message || response.statusText}`);
        }

        const quote = await response.json() as LiFiQuote;
        
        console.log(`LI.FI quote received: ${quote.estimate.toAmount} ${toTokenInfo.symbol} via ${quote.tool}`);
        
        return quote;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.log(`LI.FI quote attempt ${attempt} failed: ${lastError.message}`);
        
        if (attempt < 3) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    throw lastError || new Error('Failed to get swap quote after 3 attempts');
  }

  /**
   * Check and set token approval if needed
   */
  async ensureApproval(
    userId: string,
    tokenAddress: string,
    spenderAddress: string,
    amount: string,
    wallet: ethers.Wallet,
    safeAddress: string
  ): Promise<string | null> {
    // Native MATIC doesn't need approval
    if (tokenAddress === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    // Check current allowance
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      this.provider
    );

    const currentAllowance = await tokenContract.allowance(safeAddress, spenderAddress);
    const requiredAmount = ethers.BigNumber.from(amount);

    if (currentAllowance.gte(requiredAmount)) {
      console.log('Sufficient allowance already exists');
      return null;
    }

    console.log(`Setting approval for ${tokenAddress} to ${spenderAddress}`);

    // Create approval transaction
    const approvalData = erc20Interface.encodeFunctionData('approve', [
      spenderAddress,
      ethers.constants.MaxUint256, // Max approval
    ]);

    const approvalTx: SafeTransaction = {
      to: tokenAddress,
      operation: OperationType.Call,
      data: approvalData,
      value: '0',
    };

    // Execute approval via relayer
    const builderConfig = this.getBuilderConfig();
    if (!builderConfig) {
      throw new Error('Builder credentials not configured');
    }

    const relayClient = new RelayClient(
      config.polymarket.relayerUrl,
      config.polygon.chainId,
      wallet,
      new BuilderConfig(builderConfig)
    );

    const response = await relayClient.execute([approvalTx], 'Token approval for swap');
    
    const result = await relayClient.pollUntilState(
      response.transactionID,
      ['STATE_CONFIRMED', 'STATE_MINED'],
      'STATE_FAILED',
      60,
      2000
    );

    if (!result) {
      throw new Error('Approval transaction failed');
    }

    console.log('Approval confirmed:', result.transactionHash);
    return result.transactionHash;
  }

  /**
   * Wrap native MATIC to WMATIC via Safe relayer
   */
  async wrapMatic(
    userId: string,
    amount: number,
    wallet: ethers.Wallet,
    safeAddress: string
  ): Promise<string> {
    console.log(`Wrapping ${amount} MATIC to WMATIC...`);
    
    const amountInWei = ethers.utils.parseEther(amount.toString());
    
    // Just send MATIC to WMATIC contract - its receive() function handles wrapping
    // This avoids the signature issue with value + data combo
    const wrapTx: SafeTransaction = {
      to: WMATIC_ADDRESS,
      operation: OperationType.Call,
      data: '0x', // Empty data - WMATIC's receive() will wrap automatically
      value: amountInWei.toString(),
    };

    const builderConfig = this.getBuilderConfig();
    if (!builderConfig) {
      throw new Error('Builder credentials not configured');
    }

    const relayClient = new RelayClient(
      config.polymarket.relayerUrl,
      config.polygon.chainId,
      wallet,
      new BuilderConfig(builderConfig)
    );

    const response = await relayClient.execute([wrapTx], `Wrap ${amount} MATIC to WMATIC`);
    
    const result = await relayClient.pollUntilState(
      response.transactionID,
      ['STATE_CONFIRMED', 'STATE_MINED'],
      'STATE_FAILED',
      60,
      2000
    );

    if (!result) {
      throw new Error('MATIC wrap transaction failed');
    }

    console.log('MATIC wrapped to WMATIC:', result.transactionHash);
    return result.transactionHash;
  }

  /**
   * Check if user needs to wrap MATIC before swapping
   */
  async checkAndWrapMatic(
    userId: string,
    fromToken: string,
    amount: number,
    wallet: ethers.Wallet,
    safeAddress: string
  ): Promise<string | null> {
    const upperToken = fromToken.toUpperCase();
    
    // Only wrap if swapping FROM MATIC/POL
    if (upperToken !== 'MATIC' && upperToken !== 'POL') {
      return null;
    }

    // Check WMATIC balance
    const wmaticContract = new ethers.Contract(
      WMATIC_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      this.provider
    );
    
    const wmaticBalance = await wmaticContract.balanceOf(safeAddress);
    const requiredAmount = ethers.utils.parseEther(amount.toString());
    
    // If we have enough WMATIC, no need to wrap
    if (wmaticBalance.gte(requiredAmount)) {
      console.log('Sufficient WMATIC balance, no wrapping needed');
      return null;
    }

    // Calculate how much more we need to wrap
    const amountToWrap = requiredAmount.sub(wmaticBalance);
    const amountToWrapFormatted = parseFloat(ethers.utils.formatEther(amountToWrap));
    
    // Check native MATIC balance
    const nativeBalance = await this.provider.getBalance(safeAddress);
    if (nativeBalance.lt(amountToWrap)) {
      throw new Error(`Insufficient MATIC balance. Have: ${ethers.utils.formatEther(nativeBalance)}, Need: ${ethers.utils.formatEther(amountToWrap)}`);
    }

    // Wrap the needed amount
    return await this.wrapMatic(userId, amountToWrapFormatted, wallet, safeAddress);
  }

  /**
   * Execute a token swap
   */
  async swap(
    userId: string,
    fromToken: string,
    toToken: string,
    amount: number
  ): Promise<{
    success: boolean;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    swapTool: string;
    approvalTxHash?: string;
    swapTxHash?: string;
    error?: string;
  }> {
    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    const safeAddress = user.safeAddress;

    try {
      // Step 0: If swapping from MATIC, verify user has WMATIC (native MATIC can't be used via relayer)
      const upperFromToken = fromToken.toUpperCase();
      if (upperFromToken === 'MATIC' || upperFromToken === 'POL' || upperFromToken === 'WMATIC') {
        const wmaticContract = new ethers.Contract(
          WMATIC_ADDRESS,
          ['function balanceOf(address) view returns (uint256)'],
          this.provider
        );
        const wmaticBalance = await wmaticContract.balanceOf(safeAddress);
        const requiredAmount = ethers.utils.parseEther(amount.toString());
        
        if (wmaticBalance.lt(requiredAmount)) {
          const wmaticFormatted = ethers.utils.formatEther(wmaticBalance);
          const nativeBalance = await this.provider.getBalance(safeAddress);
          const nativeFormatted = ethers.utils.formatEther(nativeBalance);
          
          throw new Error(
            `Insufficient WMATIC balance for swap. ` +
            `Have: ${wmaticFormatted} WMATIC, Need: ${amount} WMATIC. ` +
            `You have ${nativeFormatted} native MATIC, but native MATIC cannot be swapped via the Polymarket relayer. ` +
            `To swap MATIC, you need WMATIC (wrapped MATIC). ` +
            `You can wrap MATIC to WMATIC using an external wallet/DEX, or withdraw your native MATIC to an external wallet first.`
          );
        }
      }

      // Step 1: Get quote from LI.FI
      console.log(`Getting swap quote for user ${userId}: ${amount} ${fromToken} -> ${toToken}`);
      const quote = await this.getSwapQuote(fromToken, toToken, amount, safeAddress);

      // Step 2: Ensure token approval if needed
      let approvalTxHash: string | null = null;
      if (quote.estimate.approvalAddress) {
        approvalTxHash = await this.ensureApproval(
          userId,
          quote.action.fromToken.address,
          quote.estimate.approvalAddress,
          quote.action.fromAmount,
          wallet,
          safeAddress
        );
      }

      // Step 3: Execute the swap via Safe relayer
      console.log('Executing swap transaction via Safe relayer...');
      
      const swapTx: SafeTransaction = {
        to: quote.transactionRequest.to,
        operation: OperationType.Call,
        data: quote.transactionRequest.data,
        value: quote.transactionRequest.value || '0',
      };

      const builderConfig = this.getBuilderConfig();
      if (!builderConfig) {
        throw new Error('Builder credentials not configured');
      }

      const relayClient = new RelayClient(
        config.polymarket.relayerUrl,
        config.polygon.chainId,
        wallet,
        new BuilderConfig(builderConfig)
      );

      // Execute with retries
      let swapResult: any = null;
      let lastSwapError: Error | null = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await relayClient.execute(
            [swapTx],
            `Swap ${amount} ${fromToken} -> ${toToken}`
          );

          swapResult = await relayClient.pollUntilState(
            response.transactionID,
            ['STATE_CONFIRMED', 'STATE_MINED'],
            'STATE_FAILED',
            90, // Higher timeout for swaps
            3000
          );

          if (swapResult) {
            break;
          }
        } catch (error) {
          lastSwapError = error instanceof Error ? error : new Error(String(error));
          console.log(`Swap attempt ${attempt} failed: ${lastSwapError.message}`);
          
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (!swapResult) {
        throw lastSwapError || new Error('Swap transaction failed after retries');
      }

      console.log('Swap confirmed:', swapResult.transactionHash);

      // Format output amounts
      const fromTokenInfo = this.getTokenInfo(fromToken)!;
      const toTokenInfo = this.getTokenInfo(toToken)!;
      const toAmountFormatted = ethers.utils.formatUnits(quote.estimate.toAmount, toTokenInfo.decimals);
      const toAmountMinFormatted = ethers.utils.formatUnits(quote.estimate.toAmountMin, toTokenInfo.decimals);

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'TOKEN_SWAP',
          resource: 'swap',
          resourceId: swapResult.transactionHash,
          details: {
            fromToken: quote.action.fromToken.symbol,
            toToken: quote.action.toToken.symbol,
            fromAmount: amount.toString(),
            toAmount: toAmountFormatted,
            swapTool: quote.tool,
            approvalTxHash,
            swapTxHash: swapResult.transactionHash,
          },
        },
      });

      return {
        success: true,
        fromToken: quote.action.fromToken.symbol,
        toToken: quote.action.toToken.symbol,
        fromAmount: amount.toString(),
        toAmount: toAmountFormatted,
        toAmountMin: toAmountMinFormatted,
        swapTool: quote.tool,
        approvalTxHash: approvalTxHash || undefined,
        swapTxHash: swapResult.transactionHash,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Swap failed:', errorMessage);

      // Log failure
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'TOKEN_SWAP_FAILED',
          resource: 'swap',
          success: false,
          errorMessage,
          details: {
            fromToken,
            toToken,
            amount: amount.toString(),
          },
        },
      });

      return {
        success: false,
        fromToken,
        toToken,
        fromAmount: amount.toString(),
        toAmount: '0',
        toAmountMin: '0',
        swapTool: 'unknown',
        error: errorMessage,
      };
    }
  }

  /**
   * Get estimated swap output (quote only, no execution)
   */
  async getSwapEstimate(
    fromToken: string,
    toToken: string,
    amount: number,
    fromAddress: string
  ): Promise<{
    fromToken: string;
    toToken: string;
    fromAmount: string;
    estimatedOutput: string;
    minimumOutput: string;
    priceImpact: string;
    swapTool: string;
    estimatedGasUSD: string;
    executionTime: number;
  }> {
    const quote = await this.getSwapQuote(fromToken, toToken, amount, fromAddress);
    
    const toTokenInfo = this.getTokenInfo(toToken)!;
    const toAmountFormatted = ethers.utils.formatUnits(quote.estimate.toAmount, toTokenInfo.decimals);
    const toAmountMinFormatted = ethers.utils.formatUnits(quote.estimate.toAmountMin, toTokenInfo.decimals);

    // Calculate price impact
    const fromPriceUSD = parseFloat(quote.action.fromToken.priceUSD) * amount;
    const toPriceUSD = parseFloat(quote.action.toToken.priceUSD) * parseFloat(toAmountFormatted);
    const priceImpact = ((fromPriceUSD - toPriceUSD) / fromPriceUSD * 100).toFixed(2);

    // Sum up gas costs
    const totalGasUSD = quote.estimate.gasCosts
      .reduce((sum, cost) => sum + parseFloat(cost.amountUSD || '0'), 0)
      .toFixed(4);

    return {
      fromToken: quote.action.fromToken.symbol,
      toToken: quote.action.toToken.symbol,
      fromAmount: amount.toString(),
      estimatedOutput: toAmountFormatted,
      minimumOutput: toAmountMinFormatted,
      priceImpact: `${priceImpact}%`,
      swapTool: quote.tool,
      estimatedGasUSD: `$${totalGasUSD}`,
      executionTime: quote.estimate.executionDuration,
    };
  }

  /**
   * Get supported tokens list
   */
  getSupportedTokens(): Array<{ symbol: string; address: string; decimals: number }> {
    return Object.entries(TOKENS).map(([key, info]) => ({
      symbol: key,
      address: info.address,
      decimals: info.decimals,
    }));
  }

  /**
   * Get builder config for Polymarket relayer
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
}

// Singleton instance
let swapServiceInstance: SwapService | null = null;

export function getSwapService(): SwapService {
  if (!swapServiceInstance) {
    swapServiceInstance = new SwapService();
  }
  return swapServiceInstance;
}

