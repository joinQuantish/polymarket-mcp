import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { RelayClient, OperationType, SafeTransaction } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getKeyService } from './key.service';
import { getProvider } from './provider.service';
import { prisma } from '../db';
import { config } from '../config';
import { UserStatus } from '@prisma/client';

// Signature types from Polymarket docs:
// 0 = EOA (direct wallet signing)
// 1 = POLY_PROXY (Email/Magic login - Polymarket's OWN proxy contract)
// 2 = POLY_GNOSIS_SAFE (Gnosis Safe wallet - deployed via relayer)
//
// We deploy Gnosis Safe via Polymarket relayer, so we need type 2
// Even though users login via Privy (email), the wallet is a Gnosis Safe
const SIGNATURE_TYPE_POLY_PROXY = 2 as any;

// Native USDC on Polygon (Circle's native, different from bridged USDC.e)
const NATIVE_USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

// WMATIC (Wrapped MATIC) on Polygon - needed for swaps via relayer
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

// ERC20 ABI for approval and allowance checks
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ERC1155 ABI for setApprovalForAll
const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

// Interface for encoding function calls
const erc20Interface = new ethers.utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const erc1155Interface = new ethers.utils.Interface([
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
]);

/**
 * WalletService
 * 
 * Handles Safe wallet deployment, approvals, and CLOB credential management.
 * Integrates with Polymarket's Relayer for gasless transactions.
 */
export class WalletService {
  private keyService = getKeyService();
  private provider: ethers.providers.JsonRpcProvider;

  constructor() {
    this.provider = getProvider(); // Use shared provider with retry logic
  }

  /**
   * Create a new user with a generated wallet
   */
  async createUser(externalId: string): Promise<{
    userId: string;
    eoaAddress: string;
  }> {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { externalId },
    });

    if (existingUser) {
      throw new Error('User already exists with this external ID');
    }

    // Generate new wallet
    const { address, privateKey } = this.keyService.generateWallet();

    // Encrypt and store
    const encryptedKey = (await import('./encryption.service')).getEncryptionService().encrypt(privateKey);

    // Create user record
    const user = await prisma.user.create({
      data: {
        externalId,
        eoaAddress: address,
        encryptedPrivateKey: encryptedKey,
        status: UserStatus.CREATED,
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'USER_CREATED',
        resource: 'user',
        resourceId: user.id,
        details: { eoaAddress: address },
      },
    });

    return {
      userId: user.id,
      eoaAddress: address,
    };
  }

  /**
   * Import an existing private key to create a user
   */
  async importPrivateKey(externalId: string, privateKey: string): Promise<{
    userId: string;
    eoaAddress: string;
  }> {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { externalId },
    });

    if (existingUser) {
      throw new Error('User already exists with this external ID');
    }

    // Derive address from private key
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    // Encrypt and store
    const encryptedKey = (await import('./encryption.service')).getEncryptionService().encrypt(privateKey);

    // Create user record
    const user = await prisma.user.create({
      data: {
        externalId,
        eoaAddress: address,
        encryptedPrivateKey: encryptedKey,
        status: UserStatus.CREATED,
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'USER_IMPORTED',
        resource: 'user',
        resourceId: user.id,
        details: { eoaAddress: address, source: 'private_key_import' },
      },
    });

    return {
      userId: user.id,
      eoaAddress: address,
    };
  }

  /**
   * Deploy a Safe wallet for a user using Polymarket's relayer (GASLESS)
   */
  async deploySafeWallet(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (user.safeDeployed && user.safeAddress) {
      return user.safeAddress;
    }

    // Update status to deploying
    await prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.SAFE_DEPLOYING },
    });

    try {
      // Get user's wallet
      const wallet = await this.keyService.getUserWallet(userId);

      // Create RelayClient for gasless Safe deployment
      const builderConfig = this.getBuilderConfig();
      if (!builderConfig) {
        throw new Error('Builder credentials not configured - required for gasless Safe deployment');
      }

      console.log('Deploying Safe wallet via Polymarket Relayer...');
      console.log('EOA Address:', wallet.address);

      const relayClient = new RelayClient(
        config.polymarket.relayerUrl,
        config.polygon.chainId,
        wallet,
        new BuilderConfig(builderConfig)
      );

      // Deploy Safe via Relayer (gasless!) with retry logic
      let response: any;
      let lastError: Error | null = null;
      const maxRetries = 3;
      
      // Track the proxy wallet address from deploy response (relayer tells us the address before confirmation)
      let knownProxyWallet: string | null = null;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`Safe deployment attempt ${attempt}/${maxRetries}...`);
          response = await relayClient.deploy();
          console.log('Deploy response:', JSON.stringify(response, null, 2));
          
          // Extract proxy wallet address from response (relayer returns this before tx confirms)
          // The relayer may return it as 'proxyAddress' or 'proxyWallet'
          const proxyAddr = response?.proxyAddress || response?.proxyWallet;
          if (proxyAddr) {
            knownProxyWallet = proxyAddr;
            console.log('Proxy wallet address from relayer:', knownProxyWallet);
            
            // Check if it already exists on-chain (previous deployment succeeded)
            const code = await this.provider.getCode(proxyAddr);
            if (code !== '0x' && code.length > 2) {
              console.log('Safe already deployed at:', proxyAddr);
              await this.saveSafeDeployment(userId, wallet.address, proxyAddr, response.transactionHash || 'pre-existing');
              return proxyAddr;
            }
          }
          
          if (response?.transactionID) {
            console.log('Safe deployment submitted, transaction ID:', response.transactionID);
            break; // Success, exit retry loop
          }
          
          throw new Error('No transaction ID in deploy response');
        } catch (deployError: any) {
          lastError = deployError;
          const errorMsg = deployError?.message || String(deployError);
          console.error(`Deploy attempt ${attempt} failed:`, errorMsg);
          
          // Extract proxy address from error message if present
          const addressMatch = errorMsg.match(/0x[a-fA-F0-9]{40}/);
          if (addressMatch && !knownProxyWallet) {
            knownProxyWallet = addressMatch[0];
            console.log('Extracted proxy address from error:', knownProxyWallet);
          }
          
          // Check if Safe might already exist at known or predicted address
          const addressToCheck = knownProxyWallet || await this.getPredictedSafeAddress(wallet.address);
          if (addressToCheck) {
            const code = await this.provider.getCode(addressToCheck);
            if (code !== '0x' && code.length > 2) {
              console.log('Safe already exists at:', addressToCheck);
              await this.saveSafeDeployment(userId, wallet.address, addressToCheck, 'pre-existing');
              return addressToCheck;
            }
          }
          
          // Wait before retry (exponential backoff)
          if (attempt < maxRetries) {
            const waitTime = attempt * 2000;
            console.log(`Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      }
      
      if (!response?.transactionID) {
        throw lastError || new Error('Failed to submit Safe deployment after retries');
      }
      
      console.log('Waiting for confirmation...');
      
      // Poll until confirmed with extended timeout
      // Wrap in try-catch because pollUntilState throws on failure states
      let result: any = null;
      try {
        result = await relayClient.pollUntilState(
          response.transactionID,
          ['STATE_CONFIRMED', 'STATE_MINED'],
          'STATE_FAILED',
          90,  // max polls (increased from 60)
          2000 // poll every 2 seconds
        );
      } catch (pollError: any) {
        console.error('Polling error:', pollError?.message || pollError);
        // Don't throw yet - check if Safe was deployed despite the error
      }

      // If polling fails, check if Safe was deployed anyway
      if (!result || !result.proxyAddress) {
        console.log('Polling failed or returned failure, checking if Safe was deployed anyway...');
        
        // First check the known proxy wallet address from the deploy response
        if (knownProxyWallet) {
          const code = await this.provider.getCode(knownProxyWallet);
          if (code !== '0x' && code.length > 2) {
            console.log('Safe found at known proxy address despite polling failure:', knownProxyWallet);
            await this.saveSafeDeployment(userId, wallet.address, knownProxyWallet, 'recovered-known');
            return knownProxyWallet;
          }
          console.log('Known proxy wallet has no code yet, waiting and retrying...');
          
          // Wait a bit and try again - tx might still be confirming
          await new Promise(resolve => setTimeout(resolve, 5000));
          const codeRetry = await this.provider.getCode(knownProxyWallet);
          if (codeRetry !== '0x' && codeRetry.length > 2) {
            console.log('Safe found after waiting:', knownProxyWallet);
            await this.saveSafeDeployment(userId, wallet.address, knownProxyWallet, 'recovered-delayed');
            return knownProxyWallet;
          }
        }
        
        // Try the predicted Safe address as fallback
        const predictedAddress = await this.getPredictedSafeAddress(wallet.address);
        if (predictedAddress && predictedAddress !== knownProxyWallet) {
          const code = await this.provider.getCode(predictedAddress);
          if (code !== '0x' && code.length > 2) {
            console.log('Safe found at predicted address despite polling failure:', predictedAddress);
            await this.saveSafeDeployment(userId, wallet.address, predictedAddress, 'recovered-predicted');
            return predictedAddress;
          }
        }
        
        // Check builder credentials to give helpful error
        const builderStatus = this.getBuilderCredentialsStatus();
        const builderNote = builderStatus.configured 
          ? 'Builder credentials are configured but the relayer rejected the deployment.'
          : 'CRITICAL: Builder credentials are NOT configured. Set POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, and POLY_BUILDER_PASSPHRASE environment variables.';
        
        throw new Error(
          `Safe deployment failed - no proxy address returned and Safe not found on-chain. ` +
          `Known proxy: ${knownProxyWallet || 'none'}, Predicted: ${predictedAddress || 'none'}. ` +
          `${builderNote} ` +
          `If this persists, check your Builder API credentials at https://polymarket.com/settings?tab=builder`
        );
      }

      const safeAddress = result.proxyAddress;
      console.log('Safe deployed successfully:', safeAddress, 'TX:', result.transactionHash);

      await this.saveSafeDeployment(userId, wallet.address, safeAddress, result.transactionHash);
      return safeAddress;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Safe deployment error:', errorMessage);
      
      // Check if Safe is already deployed - this is SUCCESS, not failure!
      // This happens when deployment succeeds but confirmation times out, then retry detects existing Safe
      if (errorMessage.toLowerCase().includes('safe already deployed') || 
          errorMessage.toLowerCase().includes('already deployed') ||
          errorMessage.toLowerCase().includes('proxy already exists')) {
        console.log('Safe already deployed detected - treating as SUCCESS');
        
        try {
          // Get user's wallet to query for the Safe address
          const wallet = await this.keyService.getUserWallet(userId);
          
          // Try to get the Safe address from the relayer
          const builderConfig = this.getBuilderConfig();
          if (builderConfig) {
            const relayClient = new RelayClient(
              config.polymarket.relayerUrl,
              config.polygon.chainId,
              wallet,
              new BuilderConfig(builderConfig)
            );
            
            // The relayer calculates Safe address deterministically from EOA
            // Try deploying again - it will return the existing Safe address in error or response
            let safeAddress: string | null = null;
            
            // Method 1: Try to extract Safe address from error message
            const addressMatch = errorMessage.match(/0x[a-fA-F0-9]{40}/);
            if (addressMatch) {
              safeAddress = addressMatch[0];
              console.log('Extracted Safe address from error:', safeAddress);
            }
            
            // Method 2: Query the Safe factory for the predicted address
            if (!safeAddress) {
              try {
                // Polymarket uses a deterministic Safe address based on owner EOA
                // The safe-deployments package or relayer can provide this
                // For now, we'll try another deploy call which should return the address
                const retryResponse = await relayClient.deploy();
                if (retryResponse && (retryResponse as any).proxyAddress) {
                  safeAddress = (retryResponse as any).proxyAddress;
                  console.log('Got Safe address from retry deploy response:', safeAddress);
                }
              } catch (retryError) {
                const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
                // Extract address from retry error if present
                const retryAddressMatch = retryMsg.match(/0x[a-fA-F0-9]{40}/);
                if (retryAddressMatch) {
                  safeAddress = retryAddressMatch[0];
                  console.log('Extracted Safe address from retry error:', safeAddress);
                }
              }
            }
            
            // Method 3: Calculate the predicted Safe address
            if (!safeAddress) {
              safeAddress = await this.getPredictedSafeAddress(wallet.address);
              if (safeAddress) {
                console.log('Calculated predicted Safe address:', safeAddress);
              }
            }
            
            if (safeAddress) {
              // Verify the Safe actually exists on-chain
              const code = await this.provider.getCode(safeAddress);
              if (code !== '0x' && code.length > 2) {
                console.log('Verified Safe exists on-chain:', safeAddress);
                
                // Update user with Safe address - SUCCESS!
                await prisma.user.update({
                  where: { id: userId },
                  data: {
                    safeAddress,
                    safeDeployed: true,
                    safeDeployedAt: new Date(),
                    status: UserStatus.SAFE_DEPLOYED,
                  },
                });

                // Log activity
                await prisma.activityLog.create({
                  data: {
                    userId,
                    action: 'SAFE_DEPLOYED',
                    resource: 'wallet',
                    resourceId: safeAddress,
                    details: { 
                      ownerAddress: wallet.address,
                      note: 'Safe was already deployed, recovered address',
                    },
                  },
                });

                return safeAddress;
              } else {
                console.log('Safe address found but no code on-chain yet');
              }
            }
          }
        } catch (recoveryError) {
          console.error('Failed to recover Safe address:', recoveryError);
        }
      }
      
      // Revert status on actual failure
      await prisma.user.update({
        where: { id: userId },
        data: { status: UserStatus.CREATED },
      });

      throw error;
    }
  }

  /**
   * Helper to save Safe deployment to database
   */
  private async saveSafeDeployment(
    userId: string, 
    ownerAddress: string, 
    safeAddress: string, 
    txHash: string
  ): Promise<void> {
    // Create transaction record
    await prisma.transaction.create({
      data: {
        userId,
        type: 'SAFE_DEPLOY',
        status: 'CONFIRMED',
        txHash,
        metadata: {
          ownerAddress,
          safeAddress,
        },
      },
    });

    // Update user with Safe address
    await prisma.user.update({
      where: { id: userId },
      data: {
        safeAddress,
        safeDeployed: true,
        safeDeployedAt: new Date(),
        status: UserStatus.SAFE_DEPLOYED,
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'SAFE_DEPLOYED',
        resource: 'wallet',
        resourceId: safeAddress,
        details: { 
          ownerAddress,
          transactionHash: txHash,
        },
      },
    });
  }

  /**
   * Get the predicted Safe address for an EOA owner
   * Uses Polymarket's exact derivation formula from @polymarket/builder-relayer-client
   * Formula: getCreate2Address({ from: SafeFactory, salt: keccak256(abi.encode(ownerAddress)), bytecodeHash: SAFE_INIT_CODE_HASH })
   */
  private async getPredictedSafeAddress(ownerAddress: string): Promise<string | null> {
    try {
      // Polymarket Contract Proxy Factory (same for Polygon and Amoy)
      const SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';
      // Polymarket's Safe init code hash (from @polymarket/builder-relayer-client/constants)
      const SAFE_INIT_CODE_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf';
      
      // Salt is keccak256 of ABI-encoded owner address (matching Polymarket's deriveSafe function)
      const salt = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['address'],
          [ownerAddress]
        )
      );
      
      // Calculate CREATE2 address using Polymarket's formula
      const create2Address = ethers.utils.getCreate2Address(
        SAFE_FACTORY,
        salt,
        SAFE_INIT_CODE_HASH
      );
      
      console.log('Predicted Safe address for', ownerAddress, ':', create2Address);
      return create2Address;
    } catch (error) {
      console.error('Failed to calculate predicted Safe address:', error);
      return null;
    }
  }

  /**
   * Recover/sync Safe address for a user whose Safe was deployed but database wasn't updated
   * This is useful when deployment succeeded but confirmation timed out
   */
  async recoverSafeAddress(userId: string, knownSafeAddress?: string): Promise<string | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // If already have Safe address, just verify and return
    if (user.safeDeployed && user.safeAddress) {
      console.log('Safe already recorded for user:', user.safeAddress);
      return user.safeAddress;
    }

    const wallet = await this.keyService.getUserWallet(userId);
    let safeAddress: string | null = knownSafeAddress || null;

    // If address provided, verify it
    if (safeAddress) {
      const code = await this.provider.getCode(safeAddress);
      if (code === '0x' || code.length <= 2) {
        console.log('Provided Safe address has no code on-chain');
        safeAddress = null;
      }
    }

    // Try to find the Safe address if not provided or invalid
    if (!safeAddress) {
      // Method 1: Try predicted address calculation
      safeAddress = await this.getPredictedSafeAddress(wallet.address);
      if (safeAddress) {
        const code = await this.provider.getCode(safeAddress);
        if (code === '0x' || code.length <= 2) {
          console.log('Predicted Safe address has no code on-chain');
          safeAddress = null;
        }
      }
    }

    // Method 2: Try deploying via relayer - it will tell us if already deployed
    if (!safeAddress) {
      try {
        const builderConfig = this.getBuilderConfig();
        if (builderConfig) {
          const relayClient = new RelayClient(
            config.polymarket.relayerUrl,
            config.polygon.chainId,
            wallet,
            new BuilderConfig(builderConfig)
          );

          const response = await relayClient.deploy();
          if (response && (response as any).proxyAddress) {
            safeAddress = (response as any).proxyAddress;
          }
        }
      } catch (deployError) {
        const errorMsg = deployError instanceof Error ? deployError.message : String(deployError);
        console.log('Deploy attempt result:', errorMsg);
        
        // Extract address from error if present
        const addressMatch = errorMsg.match(/0x[a-fA-F0-9]{40}/);
        if (addressMatch) {
          safeAddress = addressMatch[0];
          // Verify it exists on-chain
          const code = await this.provider.getCode(safeAddress);
          if (code === '0x' || code.length <= 2) {
            safeAddress = null;
          }
        }
      }
    }

    if (!safeAddress) {
      console.log('Could not recover Safe address for user:', userId);
      return null;
    }

    console.log('Recovered Safe address:', safeAddress, 'for user:', userId);

    // Update database
    await prisma.user.update({
      where: { id: userId },
      data: {
        safeAddress,
        safeDeployed: true,
        safeDeployedAt: new Date(),
        status: UserStatus.SAFE_DEPLOYED,
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'SAFE_RECOVERED',
        resource: 'wallet',
        resourceId: safeAddress,
        details: { 
          ownerAddress: wallet.address,
          note: 'Safe address recovered/synced from chain',
        },
      },
    });

    return safeAddress;
  }

  /**
   * Sync wallet state from on-chain and optionally continue setup
   * This is the main "fix my wallet" method that handles all edge cases:
   * - Safe deployed on-chain but DB doesn't know
   * - Credentials need to be re-derived
   * - Approvals need to be set
   */
  async syncWalletState(userId: string, continueSetup: boolean = true): Promise<{
    safeAddress: string | null;
    safeDeployed: boolean;
    credentialsCreated: boolean;
    approvalsSet: boolean;
    status: string;
    message: string;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    let safeAddress = user.safeAddress;
    let safeDeployed = user.safeDeployed;
    let credentialsCreated = !!user.encryptedApiKey;
    let approvalsSet = user.usdcApproved && user.ctfApproved && user.negRiskApproved;
    const actions: string[] = [];

    console.log('Syncing wallet state for user:', userId);
    console.log('Current state - Safe:', safeAddress, 'Deployed:', safeDeployed, 'Creds:', credentialsCreated, 'Approvals:', approvalsSet);

    // Step 1: Try to find/recover Safe address if not in DB
    if (!safeAddress || !safeDeployed) {
      console.log('Attempting to recover Safe address from on-chain...');
      const recoveredAddress = await this.recoverSafeAddress(userId);
      
      if (recoveredAddress) {
        safeAddress = recoveredAddress;
        safeDeployed = true;
        actions.push('Recovered Safe address from on-chain: ' + recoveredAddress);
        console.log('Recovered Safe address:', recoveredAddress);
      } else {
        // Safe truly doesn't exist - try to deploy it
        console.log('Safe not found on-chain, attempting deployment...');
        try {
          safeAddress = await this.deploySafeWallet(userId);
          safeDeployed = true;
          actions.push('Deployed new Safe wallet: ' + safeAddress);
        } catch (deployError) {
          const errorMsg = deployError instanceof Error ? deployError.message : String(deployError);
          console.log('Deploy failed:', errorMsg);
          
          // Check if "already deployed" error contains the address
          if (errorMsg.toLowerCase().includes('already deployed')) {
            // Try recover one more time
            const retryRecover = await this.recoverSafeAddress(userId);
            if (retryRecover) {
              safeAddress = retryRecover;
              safeDeployed = true;
              actions.push('Recovered Safe address after deploy error: ' + retryRecover);
            }
          }
        }
      }
    }

    // If still no Safe, we can't continue
    if (!safeAddress) {
      return {
        safeAddress: null,
        safeDeployed: false,
        credentialsCreated: false,
        approvalsSet: false,
        status: 'FAILED',
        message: 'Could not find or deploy Safe wallet. The Polymarket relayer may be down.',
      };
    }

    // Step 2: Set approvals if needed and continueSetup is true
    if (continueSetup && !approvalsSet) {
      try {
        console.log('Setting token approvals...');
        await this.setTokenApprovals(userId, false);
        approvalsSet = true;
        actions.push('Set token approvals');
      } catch (approvalError) {
        console.log('Failed to set approvals:', approvalError instanceof Error ? approvalError.message : approvalError);
        actions.push('Failed to set approvals - may need retry');
      }
    }

    // Step 3: Create/reset credentials if needed and continueSetup is true
    if (continueSetup && !credentialsCreated) {
      try {
        console.log('Creating API credentials...');
        await this.createApiCredentials(userId);
        credentialsCreated = true;
        actions.push('Created API credentials');
      } catch (credError) {
        console.log('Failed to create credentials:', credError instanceof Error ? credError.message : credError);
        actions.push('Failed to create credentials - may need retry');
      }
    }

    // Get final status
    const finalUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });

    const isReady = safeDeployed && credentialsCreated && approvalsSet;

    return {
      safeAddress,
      safeDeployed,
      credentialsCreated,
      approvalsSet,
      status: finalUser?.status || 'UNKNOWN',
      message: isReady 
        ? 'Wallet fully synced and ready to trade. Actions: ' + actions.join(', ')
        : 'Wallet partially synced. Actions: ' + (actions.length > 0 ? actions.join(', ') : 'None needed'),
    };
  }

  /**
   * Create CLOB API credentials for a user
   */
  async createApiCredentials(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.safeAddress) {
      throw new Error('Safe wallet not deployed - deploy Safe first before creating credentials');
    }

    // Update status
    await prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.SETTING_UP },
    });

    try {
      const wallet = await this.keyService.getUserWallet(userId);

      // CRITICAL: Create CLOB client WITH the Safe address!
      // This ensures credentials are registered for the Safe (funder), not just the EOA (signer)
      // Without this, the CLOB will check the EOA's balance instead of the Safe's balance
      const clobClient = new ClobClient(
        config.polymarket.clobApiUrl,
        config.polygon.chainId,
        wallet,
        undefined,  // No credentials yet - we're creating them
        SIGNATURE_TYPE_POLY_PROXY,  // Proxy signature type (EOA signs, Safe pays)
        user.safeAddress  // The Safe address - CRITICAL for balance checks!
      );
      
      console.log('Creating CLOB credentials for Safe:', user.safeAddress, 'via EOA:', wallet.address);

      // Create API key - cast to any since library types may vary
      let credentials: { key: string; secret: string; passphrase: string } | null = null;
      
      // Try deriveApiKey FIRST (for wallets that already have CLOB credentials)
      // NOTE: This will fail with 400 "Could not derive api key!" for NEW wallets - that's EXPECTED.
      // New wallets need createApiKey instead, which we fall back to below.
      try {
        console.log('Attempting to derive API key for user:', userId, '(expected to fail for new wallets)');
        const response: any = await clobClient.deriveApiKey();
        
        const key = response?.apiKey || response?.key || '';
        const secret = response?.apiSecret || response?.secret || '';
        const passphrase = response?.apiPassphrase || response?.passphrase || '';
        
        if (key && secret && passphrase) {
          credentials = { key, secret, passphrase };
          console.log('Successfully derived API key for user:', userId);
        } else {
          console.log('deriveApiKey returned empty/no credentials - falling back to createApiKey (normal for new wallets)');
        }
      } catch (deriveError) {
        // This is EXPECTED for new wallets that don't have existing CLOB credentials
        console.log('deriveApiKey not available (normal for new wallets) - falling back to createApiKey');
      }

      // Fallback: try createApiKey if derive failed
      if (!credentials) {
        try {
          console.log('Attempting to create API key for user:', userId);
          const response: any = await clobClient.createApiKey();
          console.log('createApiKey response keys:', Object.keys(response || {}));
          
          const key = response?.apiKey || response?.key || '';
          const secret = response?.apiSecret || response?.secret || '';
          const passphrase = response?.apiPassphrase || response?.passphrase || '';
          
          if (key && secret && passphrase) {
            credentials = { key, secret, passphrase };
            console.log('Successfully created API key for user:', userId);
          }
        } catch (createError) {
          console.log('createApiKey failed:', createError instanceof Error ? createError.message : createError);
        }
      }

      // Validate we got credentials
      if (!credentials || !credentials.key || !credentials.secret || !credentials.passphrase) {
        throw new Error('Failed to obtain CLOB API credentials - both derive and create failed. The wallet may have too many existing API keys on Polymarket.');
      }

      // CRITICAL: Validate that the secret is valid base64
      // The CLOB API requires base64-encoded secret for HMAC signing
      console.log('Validating credentials before storage...');
      console.log('  Key length:', credentials.key.length);
      console.log('  Secret length:', credentials.secret.length);
      console.log('  Passphrase length:', credentials.passphrase.length);
      console.log('  Secret first 10 chars:', credentials.secret.substring(0, 10) + '...');
      
      // Test base64 decode
      try {
        const decoded = Buffer.from(credentials.secret, 'base64');
        console.log('  Secret base64 decode successful, decoded length:', decoded.length);
        
        // Re-encode and verify it matches (some base64 strings can decode but not cleanly)
        const reencoded = decoded.toString('base64');
        if (reencoded !== credentials.secret) {
          console.warn('  WARNING: Secret re-encoded differently!');
          console.warn('  Original:', credentials.secret);
          console.warn('  Re-encoded:', reencoded);
        }
      } catch (b64Error) {
        console.error('  ERROR: Secret is NOT valid base64!', b64Error);
        throw new Error('CLOB API returned invalid base64 secret - cannot proceed');
      }

      // Store encrypted credentials
      await this.keyService.storeApiCredentials(userId, credentials);
      console.log('Stored CLOB credentials for user:', userId);

      // Update status
      await prisma.user.update({
        where: { id: userId },
        data: { status: UserStatus.READY },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'API_CREDENTIALS_CREATED',
          resource: 'credentials',
          resourceId: userId,
        },
      });
    } catch (error) {
      console.error('Failed to create CLOB credentials for user:', userId, error);
      await prisma.user.update({
        where: { id: userId },
        data: { status: UserStatus.SAFE_DEPLOYED },
      });
      throw error;
    }
  }

  /**
   * Reset/regenerate CLOB API credentials for a user
   * Use this when existing credentials are corrupted or need to be refreshed
   */
  async resetApiCredentials(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.safeAddress) {
      throw new Error('Safe wallet not deployed - deploy Safe first before creating credentials');
    }

    console.log('Resetting CLOB credentials for user:', userId);

    // Clear existing credentials from database
    await prisma.user.update({
      where: { id: userId },
      data: {
        encryptedApiKey: null,
        encryptedApiSecret: null,
        encryptedApiPassphrase: null,
        status: UserStatus.SAFE_DEPLOYED,
      },
    });

    // Now create fresh credentials
    await this.createApiCredentials(userId);

    // Log the reset
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'API_CREDENTIALS_RESET',
        resource: 'credentials',
        resourceId: userId,
        details: { reason: 'Manual reset requested' },
      },
    });

    console.log('Successfully reset CLOB credentials for user:', userId);
  }

  /**
   * Get user's full setup status
   */
  async getUserStatus(userId: string): Promise<{
    status: UserStatus;
    eoaAddress: string;
    safeAddress: string | null;
    safeDeployed: boolean;
    hasApiCredentials: boolean;
    approvalsSet: {
      usdc: boolean;
      ctf: boolean;
      negRisk: boolean;
    };
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        eoaAddress: true,
        safeAddress: true,
        safeDeployed: true,
        encryptedApiKey: true,
        usdcApproved: true,
        ctfApproved: true,
        negRiskApproved: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return {
      status: user.status,
      eoaAddress: user.eoaAddress,
      safeAddress: user.safeAddress,
      safeDeployed: user.safeDeployed,
      hasApiCredentials: !!user.encryptedApiKey,
      approvalsSet: {
        usdc: user.usdcApproved,
        ctf: user.ctfApproved,
        negRisk: user.negRiskApproved,
      },
    };
  }

  /**
   * Full user setup - deploys Safe, sets approvals, and creates credentials
   */
  async fullSetup(userId: string): Promise<{
    safeAddress: string;
    status: UserStatus;
  }> {
    // Deploy Safe
    const safeAddress = await this.deploySafeWallet(userId);

    // Set token approvals for trading
    await this.setTokenApprovals(userId);

    // Create API credentials
    await this.createApiCredentials(userId);

    return {
      safeAddress,
      status: UserStatus.READY,
    };
  }

  /**
   * Set all required token approvals for trading via Polymarket Relayer (GASLESS)
   * This approves:
   * 1. USDC → CTF Exchange (for BUY orders)
   * 2. USDC → Neg Risk Exchange (for neg risk BUY orders)
   * 3. CTF tokens → CTF Exchange (for SELL/trading)
   * 4. CTF tokens → Neg Risk CTF Exchange (for negative risk trading)
   */
  async setTokenApprovals(userId: string, force = false): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    // If force, reset approval flags first
    if (force) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          usdcApproved: false,
          ctfApproved: false,
          negRiskApproved: false,
        },
      });
      // Refetch user
      const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
      if (updatedUser) {
        Object.assign(user, updatedUser);
      }
    }

    const wallet = await this.keyService.getUserWallet(userId);
    
    try {
      const maxUint256 = ethers.constants.MaxUint256;

      // Prepare Safe transactions for approvals
      const safeTransactions: SafeTransaction[] = [];
      const approvalDescriptions: string[] = [];

      // 1. Approve USDC for CTF Exchange (for BUY orders - this is the critical one!)
      if (!user.usdcApproved || force) {
        safeTransactions.push({
          to: config.contracts.usdc,
          operation: OperationType.Call,
          data: erc20Interface.encodeFunctionData('approve', [
            config.contracts.ctfExchange,
            maxUint256,
          ]),
          value: '0',
        });
        approvalDescriptions.push('USDC → CTF Exchange');
        
        // Also approve USDC for Neg Risk Exchange
        safeTransactions.push({
          to: config.contracts.usdc,
          operation: OperationType.Call,
          data: erc20Interface.encodeFunctionData('approve', [
            config.contracts.negRiskCtfExchange,
            maxUint256,
          ]),
          value: '0',
        });
        approvalDescriptions.push('USDC → Neg Risk Exchange');
        
        // CRITICAL: Also approve USDC for Neg Risk Adapter (required for neg risk markets)
        safeTransactions.push({
          to: config.contracts.usdc,
          operation: OperationType.Call,
          data: erc20Interface.encodeFunctionData('approve', [
            config.contracts.negRiskAdapter,
            maxUint256,
          ]),
          value: '0',
        });
        approvalDescriptions.push('USDC → Neg Risk Adapter');
      }

      // 2. Approve CTF tokens for CTF Exchange (for regular trading)
      if (!user.ctfApproved || force) {
        safeTransactions.push({
          to: config.contracts.ctf,
          operation: OperationType.Call,
          data: erc1155Interface.encodeFunctionData('setApprovalForAll', [
            config.contracts.ctfExchange,
            true,
          ]),
          value: '0',
        });
        approvalDescriptions.push('CTF → Exchange');
      }

      // 3. Approve CTF tokens for Neg Risk CTF Exchange
      if (!user.negRiskApproved || force) {
        safeTransactions.push({
          to: config.contracts.ctf,
          operation: OperationType.Call,
          data: erc1155Interface.encodeFunctionData('setApprovalForAll', [
            config.contracts.negRiskCtfExchange,
            true,
          ]),
          value: '0',
        });
        approvalDescriptions.push('CTF → Neg Risk Exchange');
        
        // CRITICAL: Also approve CTF for Neg Risk Adapter (required for SELL on neg risk markets)
        safeTransactions.push({
          to: config.contracts.ctf,
          operation: OperationType.Call,
          data: erc1155Interface.encodeFunctionData('setApprovalForAll', [
            config.contracts.negRiskAdapter,
            true,
          ]),
          value: '0',
        });
        approvalDescriptions.push('CTF → Neg Risk Adapter');
      }

      if (safeTransactions.length === 0) {
        console.log('All approvals already set for user:', userId);
        return;
      }

      console.log(`Setting ${safeTransactions.length} approvals via Relayer:`, approvalDescriptions);

      // Create RelayClient for gasless Safe transactions
      const builderConfig = this.getBuilderConfig();
      if (!builderConfig) {
        throw new Error('Builder credentials not configured - required for gasless transactions');
      }

      const relayClient = new RelayClient(
        config.polymarket.relayerUrl,
        config.polygon.chainId,
        wallet,
        new BuilderConfig(builderConfig)
      );

      // Execute all approvals in a single batch transaction via the Relayer
      const response = await relayClient.execute(
        safeTransactions,
        `Token approvals: ${approvalDescriptions.join(', ')}`
      );

      console.log('Approval transaction submitted, waiting for confirmation...');
      
      // Poll until confirmed
      const result = await relayClient.pollUntilState(
        response.transactionID,
        ['STATE_CONFIRMED', 'STATE_MINED'],
        'STATE_FAILED',
        60,
        2000
      );
      
      if (result) {
        console.log('Approvals confirmed! TX:', result.transactionHash);
        
        // Update user's approval status
        await prisma.user.update({
          where: { id: userId },
          data: {
            usdcApproved: true,
            ctfApproved: true,
            negRiskApproved: true,
          },
        });

        // Log activity
        await prisma.activityLog.create({
          data: {
            userId,
            action: 'TOKEN_APPROVALS_SET',
            resource: 'wallet',
            resourceId: user.safeAddress,
            details: {
              approvals: approvalDescriptions,
              transactionHash: result.transactionHash,
            },
          },
        });

        console.log('All token approvals set successfully for user:', userId);
      } else {
        throw new Error('Approval transaction failed or timed out');
      }
    } catch (error) {
      console.error('Failed to set token approvals:', error);
      throw new Error(`Failed to set token approvals: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Verify that all required approvals are in place
   */
  async verifyApprovals(userId: string): Promise<{
    usdcApproved: boolean;
    ctfApproved: boolean;
    negRiskApproved: boolean;
    allApproved: boolean;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    // Create contract instances
    const usdcContract = new ethers.Contract(
      config.contracts.usdc,
      ERC20_ABI,
      this.provider
    );
    const ctfContract = new ethers.Contract(
      config.contracts.ctf,
      ERC1155_ABI,
      this.provider
    );

    // Check address to verify (Safe or EOA depending on setup)
    const addressToCheck = user.safeAddress || user.eoaAddress;

    try {
      // Check USDC allowance for CTF Exchange (this is what CLOB checks for BUY orders)
      console.log('verifyApprovals: checking USDC allowance for', addressToCheck, 'to', config.contracts.ctfExchange);
      const usdcAllowance = await usdcContract.allowance(addressToCheck, config.contracts.ctfExchange);
      console.log('verifyApprovals: USDC allowance raw:', usdcAllowance.toString());
      console.log('verifyApprovals: USDC allowance is MaxUint256:', usdcAllowance.eq(ethers.constants.MaxUint256));
      
      // Check if it's MaxUint256 OR greater than 1M USDC
      const usdcApproved = usdcAllowance.eq(ethers.constants.MaxUint256) || 
                           usdcAllowance.gt(ethers.utils.parseUnits('1000000', 6));
      console.log('verifyApprovals: usdcApproved:', usdcApproved);

      // Check CTF approval for Exchange
      const ctfApproved = await ctfContract.isApprovedForAll(addressToCheck, config.contracts.ctfExchange);

      // Check CTF approval for Neg Risk Exchange
      const negRiskApproved = await ctfContract.isApprovedForAll(addressToCheck, config.contracts.negRiskCtfExchange);

      // Update database with current state
      await prisma.user.update({
        where: { id: userId },
        data: {
          usdcApproved,
          ctfApproved,
          negRiskApproved,
        },
      });

      return {
        usdcApproved,
        ctfApproved,
        negRiskApproved,
        allApproved: usdcApproved && ctfApproved && negRiskApproved,
      };
    } catch (error) {
      console.error('Failed to verify approvals:', error);
      return {
        usdcApproved: false,
        ctfApproved: false,
        negRiskApproved: false,
        allApproved: false,
      };
    }
  }

  /**
   * Force Polymarket CLOB to re-sync balance/allowance data
   * Calls the CLOB's updateBalanceAllowance endpoint
   */
  async syncBalanceWithClob(userId: string): Promise<{
    synced: boolean;
    message: string;
    balance?: string;
    allowance?: string;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    try {
      const clobClient = await this.getClobClient(userId);
      
      console.log('Syncing balance with CLOB for Safe:', user.safeAddress);
      
      // Try to get current balance/allowance status from CLOB
      try {
        const balanceAllowance = await (clobClient as any).getBalanceAllowance({
          asset_type: 'COLLATERAL',
        });
        console.log('Current CLOB balance/allowance:', balanceAllowance);
      } catch (e: any) {
        console.log('getBalanceAllowance not available or failed:', e.message);
      }
      
      // Call updateBalanceAllowance to force CLOB to re-sync from chain
      try {
        const updateResult = await (clobClient as any).updateBalanceAllowance({
          asset_type: 'COLLATERAL',
        });
        console.log('updateBalanceAllowance result:', updateResult);
        
        return {
          synced: true,
          message: 'Successfully synced balance with Polymarket CLOB',
          balance: updateResult?.balance,
          allowance: updateResult?.allowance,
        };
      } catch (e: any) {
        console.log('updateBalanceAllowance failed:', e.message);
        
        // Try alternative - just verify approvals are set on-chain
        const approvals = await this.verifyApprovals(userId);
        
        return {
          synced: false,
          message: `Could not sync with CLOB API: ${e.message}. On-chain approvals: ${approvals.allApproved ? 'OK' : 'Missing'}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Failed to sync balance with CLOB:', errorMessage);
      
      return {
        synced: false,
        message: `Sync failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Get a configured CLOB client for a user
   * 
   * NOTE: The CLOB client uses signer.getAddress() for POLY_ADDRESS header which is
   * used for balance checks. This returns the EOA address, but the balance is in the Safe.
   * The Polymarket CLOB should be checking the funderAddress (Safe) not the signer (EOA).
   * 
   * This appears to be a limitation/bug in either the CLOB client or the CLOB API itself.
   * The funderAddress parameter correctly sets the "maker" field in orders to the Safe,
   * but the POLY_ADDRESS header still uses the signer's address.
   * 
   * FIX: We use an axios interceptor (in src/index.ts) to replace the POLY_ADDRESS header
   * with the Safe address. The EOA -> Safe mapping is registered below.
   */
  async getClobClient(userId: string): Promise<ClobClient> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not fully setup');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    const credentials = await this.keyService.getApiCredentials(userId);

    // Get builder config for order attribution - must be a BuilderConfig INSTANCE
    const builderCreds = this.getBuilderConfig();
    let builderConfig: BuilderConfig | undefined;
    if (builderCreds) {
      builderConfig = new BuilderConfig(builderCreds);
    }

    console.log(`[getClobClient] EOA signer: ${wallet.address}, Safe funder: ${user.safeAddress}`);

    // CRITICAL: Register EOA -> Safe mapping for axios interceptor
    // This allows the interceptor to replace POLY_ADDRESS header with Safe address
    // Import is dynamic to avoid circular dependency
    const { eoaToSafeMap } = await import('../index');
    eoaToSafeMap.set(wallet.address.toLowerCase(), user.safeAddress.toLowerCase());
    console.log(`[getClobClient] Registered EOA->Safe mapping: ${wallet.address.slice(0, 10)}... → ${user.safeAddress.slice(0, 10)}...`);

    return new ClobClient(
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
  }

  /**
   * Get builder config for order attribution
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
   * Check builder credentials status (for diagnostics)
   */
  getBuilderCredentialsStatus(): {
    configured: boolean;
    apiKeyLength: number;
    secretLength: number;
    passphraseLength: number;
    apiKeyPrefix?: string;
  } {
    return {
      configured: !!(config.builder.apiKey && config.builder.secret && config.builder.passphrase),
      apiKeyLength: config.builder.apiKey?.length || 0,
      secretLength: config.builder.secret?.length || 0,
      passphraseLength: config.builder.passphrase?.length || 0,
      apiKeyPrefix: config.builder.apiKey ? config.builder.apiKey.substring(0, 8) + '...' : undefined,
    };
  }

  /**
   * Transfer ERC-1155 tokens (shares) from user's Safe to another address
   */
  async transferShares(
    userId: string,
    tokenId: string,
    toAddress: string,
    amount: number
  ): Promise<{ success: boolean; transactionHash?: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    
    try {
      console.log(`Transferring ${amount} shares of token ${tokenId} to ${toAddress}`);
      
      // ERC-1155 safeTransferFrom(from, to, id, amount, data)
      // CTF tokens use 6 decimals (like USDC)
      const amountInWei = ethers.utils.parseUnits(amount.toString(), 6);
      console.log(`Amount in wei: ${amountInWei.toString()}`);
      
      const transferData = erc1155Interface.encodeFunctionData('safeTransferFrom', [
        user.safeAddress,  // from
        toAddress,         // to
        tokenId,           // token id
        amountInWei,       // amount with 6 decimals
        '0x'               // data (empty)
      ]);

      const safeTransaction: SafeTransaction = {
        to: config.contracts.ctf,
        operation: OperationType.Call,
        data: transferData,
        value: '0',
      };

      // Create RelayClient for gasless transaction
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

      // Execute the transfer
      const response = await relayClient.execute(
        [safeTransaction],
        `Transfer ${amount} shares to ${toAddress}`
      );

      console.log('Transfer submitted, waiting for confirmation...');
      
      // Poll until confirmed
      const result = await relayClient.pollUntilState(
        response.transactionID,
        ['STATE_CONFIRMED', 'STATE_MINED'],
        'STATE_FAILED',
        60,
        2000
      );
      
      if (result) {
        console.log('Transfer confirmed! TX:', result.transactionHash);
        
        // Log activity
        await prisma.activityLog.create({
          data: {
            userId,
            action: 'SHARES_TRANSFERRED',
            resource: 'position',
            resourceId: tokenId,
            details: {
              from: user.safeAddress,
              to: toAddress,
              tokenId,
              amount,
              transactionHash: result.transactionHash,
            },
          },
        });

        return {
          success: true,
          transactionHash: result.transactionHash,
        };
      } else {
        throw new Error('Transfer transaction failed or timed out');
      }
    } catch (error) {
      console.error('Failed to transfer shares:', error);
      throw new Error(`Failed to transfer shares: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Transfer USDC from user's Safe to another address (gasless via relayer)
   */
  async transferUsdc(
    userId: string,
    toAddress: string,
    amount: number
  ): Promise<{ success: boolean; transactionHash?: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    
    try {
      console.log(`Transferring ${amount} USDC to ${toAddress}`);
      
      // USDC uses 6 decimals
      const amountInWei = ethers.utils.parseUnits(amount.toString(), 6);
      console.log(`Amount in wei: ${amountInWei.toString()}`);
      
      // Encode ERC-20 transfer call
      const transferData = erc20Interface.encodeFunctionData('transfer', [
        toAddress,    // to
        amountInWei,  // amount
      ]);

      const safeTransaction: SafeTransaction = {
        to: config.contracts.usdc,
        operation: OperationType.Call,
        data: transferData,
        value: '0',
      };

      // Create RelayClient for gasless transaction
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

      // Execute the transfer
      const response = await relayClient.execute(
        [safeTransaction],
        `Transfer ${amount} USDC to ${toAddress}`
      );

      console.log('USDC transfer submitted, waiting for confirmation...');
      
      // Poll until confirmed
      const result = await relayClient.pollUntilState(
        response.transactionID,
        ['STATE_CONFIRMED', 'STATE_MINED'],
        'STATE_FAILED',
        60,
        2000
      );
      
      if (result) {
        console.log('USDC transfer confirmed! TX:', result.transactionHash);
        
        // Log activity
        await prisma.activityLog.create({
          data: {
            userId,
            action: 'USDC_TRANSFERRED',
            resource: 'wallet',
            resourceId: user.safeAddress,
            details: {
              from: user.safeAddress,
              to: toAddress,
              amount,
              transactionHash: result.transactionHash,
            },
          },
        });

        return {
          success: true,
          transactionHash: result.transactionHash,
        };
      } else {
        throw new Error('USDC transfer transaction failed or timed out');
      }
    } catch (error) {
      console.error('Failed to transfer USDC:', error);
      throw new Error(`Failed to transfer USDC: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Transfer MATIC (native token) from user's Safe to another address (gasless via relayer)
   */
  async transferMatic(
    userId: string,
    toAddress: string,
    amount: number
  ): Promise<{ success: boolean; transactionHash?: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    
    try {
      console.log(`Transferring ${amount} MATIC to ${toAddress}`);
      
      // MATIC is native token - just send value, no contract call
      const amountInWei = ethers.utils.parseEther(amount.toString());
      console.log(`Amount in wei: ${amountInWei.toString()}`);

      const safeTransaction: SafeTransaction = {
        to: toAddress,
        operation: OperationType.Call,
        data: '0x',  // Empty data for native transfer
        value: amountInWei.toString(),
      };

      // Create RelayClient for gasless transaction
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

      // Execute the transfer
      const response = await relayClient.execute(
        [safeTransaction],
        `Transfer ${amount} MATIC to ${toAddress}`
      );

      console.log('MATIC transfer submitted, waiting for confirmation...');
      
      // Poll until confirmed
      const result = await relayClient.pollUntilState(
        response.transactionID,
        ['STATE_CONFIRMED', 'STATE_MINED'],
        'STATE_FAILED',
        60,
        2000
      );
      
      if (result) {
        console.log('MATIC transfer confirmed! TX:', result.transactionHash);
        
        // Log activity
        await prisma.activityLog.create({
          data: {
            userId,
            action: 'MATIC_TRANSFERRED',
            resource: 'wallet',
            resourceId: user.safeAddress,
            details: {
              from: user.safeAddress,
              to: toAddress,
              amount,
              transactionHash: result.transactionHash,
            },
          },
        });

        return {
          success: true,
          transactionHash: result.transactionHash,
        };
      } else {
        throw new Error('MATIC transfer transaction failed or timed out');
      }
    } catch (error) {
      console.error('Failed to transfer MATIC:', error);
      throw new Error(`Failed to transfer MATIC: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Transfer Native USDC (Circle's native, not bridged) from user's Safe to another address
   */
  async transferNativeUsdc(
    userId: string,
    toAddress: string,
    amount: number
  ): Promise<{ success: boolean; transactionHash?: string }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.safeAddress) {
      throw new Error('User not found or Safe not deployed');
    }

    const wallet = await this.keyService.getUserWallet(userId);
    
    try {
      console.log(`Transferring ${amount} Native USDC to ${toAddress}`);
      
      // Native USDC uses 6 decimals
      const amountInWei = ethers.utils.parseUnits(amount.toString(), 6);
      console.log(`Amount in wei: ${amountInWei.toString()}`);
      
      // Encode ERC-20 transfer call
      const transferData = erc20Interface.encodeFunctionData('transfer', [
        toAddress,
        amountInWei,
      ]);

      const safeTransaction: SafeTransaction = {
        to: NATIVE_USDC_ADDRESS,
        operation: OperationType.Call,
        data: transferData,
        value: '0',
      };

      // Create RelayClient for gasless transaction
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

      // Execute the transfer
      const response = await relayClient.execute(
        [safeTransaction],
        `Transfer ${amount} Native USDC to ${toAddress}`
      );

      console.log('Native USDC transfer submitted, waiting for confirmation...');
      
      // Poll until confirmed
      const result = await relayClient.pollUntilState(
        response.transactionID,
        ['STATE_CONFIRMED', 'STATE_MINED'],
        'STATE_FAILED',
        60,
        2000
      );
      
      if (result) {
        console.log('Native USDC transfer confirmed! TX:', result.transactionHash);
        
        // Log activity
        await prisma.activityLog.create({
          data: {
            userId,
            action: 'NATIVE_USDC_TRANSFERRED',
            resource: 'wallet',
            resourceId: user.safeAddress,
            details: {
              from: user.safeAddress,
              to: toAddress,
              amount,
              token: 'NATIVE_USDC',
              transactionHash: result.transactionHash,
            },
          },
        });

        return {
          success: true,
          transactionHash: result.transactionHash,
        };
      } else {
        throw new Error('Native USDC transfer transaction failed or timed out');
      }
    } catch (error) {
      console.error('Failed to transfer Native USDC:', error);
      throw new Error(`Failed to transfer Native USDC: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get Native USDC balance for a user's Safe wallet
   */
  async getNativeUsdcBalance(safeAddress: string): Promise<string> {
    try {
      const usdcContract = new ethers.Contract(
        NATIVE_USDC_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );
      const balance = await usdcContract.balanceOf(safeAddress);
      return ethers.utils.formatUnits(balance, 6);
    } catch (error) {
      console.error('Failed to get native USDC balance:', error);
      return '0';
    }
  }

  /**
   * Get WMATIC (Wrapped MATIC) balance for a user's Safe wallet
   * Note: WMATIC is required for swaps via relayer since native MATIC transfers are not supported
   */
  async getWmaticBalance(safeAddress: string): Promise<string> {
    try {
      const wmaticContract = new ethers.Contract(
        WMATIC_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );
      const balance = await wmaticContract.balanceOf(safeAddress);
      return ethers.utils.formatUnits(balance, 18);
    } catch (error) {
      console.error('Failed to get WMATIC balance:', error);
      return '0';
    }
  }
}

// Singleton instance
let walletServiceInstance: WalletService | null = null;

export function getWalletService(): WalletService {
  if (!walletServiceInstance) {
    walletServiceInstance = new WalletService();
  }
  return walletServiceInstance;
}

