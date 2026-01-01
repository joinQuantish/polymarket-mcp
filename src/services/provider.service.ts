import { ethers } from 'ethers';
import { config } from '../config';

/**
 * ProviderService
 * 
 * Centralized RPC provider with retry logic and fallback support.
 * Helps avoid rate limiting issues with public RPCs.
 */

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Fallback RPC URLs (in order of preference)
const FALLBACK_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://rpc.ankr.com/polygon',
];

class RetryProvider extends ethers.providers.JsonRpcProvider {
  private fallbackProviders: ethers.providers.JsonRpcProvider[] = [];

  constructor(url: string) {
    super(url);
    // Initialize fallback providers
    for (const rpc of FALLBACK_RPCS) {
      if (rpc !== url) {
        this.fallbackProviders.push(new ethers.providers.JsonRpcProvider(rpc));
      }
    }
  }

  async perform(method: string, params: any): Promise<any> {
    let lastError: Error | null = null;

    // Try primary provider with retries
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await super.perform(method, params);
      } catch (error: any) {
        lastError = error;
        const isRateLimit = error?.code === 429 || 
                           error?.message?.includes('rate limit') ||
                           error?.message?.includes('Too Many Requests');
        
        if (isRateLimit || error?.code === 'SERVER_ERROR') {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(`RPC rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Non-retryable error, try fallbacks immediately
          break;
        }
      }
    }

    // Try fallback providers
    for (const fallback of this.fallbackProviders) {
      try {
        console.log('Trying fallback RPC...');
        return await fallback.perform(method, params);
      } catch (error) {
        lastError = error as Error;
        continue;
      }
    }

    throw lastError || new Error('All RPC providers failed');
  }
}

// Multicall contract address on Polygon
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Multicall ABI
const MULTICALL_ABI = [
  'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
];

// ERC20 balance ABI
const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];
const erc20Interface = new ethers.utils.Interface(ERC20_BALANCE_ABI);

/**
 * Batch multiple balance calls into a single RPC request using Multicall
 */
export async function batchGetBalances(
  provider: ethers.providers.Provider,
  address: string,
  tokens: { address: string; decimals: number; name: string }[]
): Promise<Record<string, string>> {
  const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
  
  const calls: { target: string; callData: string }[] = [];
  
  // Add native balance call (use multicall's getEthBalance)
  // For native, we'll call separately since multicall doesn't have a good way
  
  // Add ERC20 balance calls
  for (const token of tokens) {
    if (token.address !== ethers.constants.AddressZero) {
      calls.push({
        target: token.address,
        callData: erc20Interface.encodeFunctionData('balanceOf', [address]),
      });
    }
  }

  try {
    const [, returnData] = await multicall.aggregate(calls);
    
    const results: Record<string, string> = {};
    let dataIndex = 0;
    
    for (const token of tokens) {
      if (token.address === ethers.constants.AddressZero) {
        // Skip native, we'll get it separately
        continue;
      }
      
      const balance = ethers.BigNumber.from(returnData[dataIndex]);
      results[token.name] = ethers.utils.formatUnits(balance, token.decimals);
      dataIndex++;
    }
    
    return results;
  } catch (error) {
    console.error('Multicall failed, falling back to individual calls:', error);
    throw error;
  }
}

// Singleton provider instance
let providerInstance: RetryProvider | null = null;

export function getProvider(): ethers.providers.JsonRpcProvider {
  if (!providerInstance) {
    providerInstance = new RetryProvider(config.polygon.rpcUrl);
  }
  return providerInstance;
}

// For backwards compatibility - services can import this directly
export const provider = {
  get instance() {
    return getProvider();
  }
};

