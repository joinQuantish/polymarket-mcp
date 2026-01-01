import { ethers } from 'ethers';
import { getEncryptionService } from './encryption.service';
import { getProvider } from './provider.service';
import { prisma } from '../db';
import { config } from '../config';

/**
 * KeyService
 * 
 * Handles wallet generation, key management, and secure storage.
 */

export class KeyService {
  private encryption = getEncryptionService();
  private provider: ethers.providers.JsonRpcProvider;

  constructor() {
    this.provider = getProvider(); // Use shared provider with retry logic
  }

  /**
   * Generate a new Ethereum wallet (EOA)
   * Returns the wallet with address and private key
   */
  generateWallet(): { address: string; privateKey: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
  }

  /**
   * Create a wallet from an existing private key
   */
  walletFromPrivateKey(privateKey: string): ethers.Wallet {
    return new ethers.Wallet(privateKey, this.provider);
  }

  /**
   * Encrypt and store a private key for a user
   */
  async storePrivateKey(userId: string, privateKey: string): Promise<void> {
    const encryptedKey = this.encryption.encrypt(privateKey);
    
    await prisma.user.update({
      where: { id: userId },
      data: { encryptedPrivateKey: encryptedKey },
    });
  }

  /**
   * Retrieve and decrypt a user's private key
   */
  async getPrivateKey(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { encryptedPrivateKey: true },
    });

    if (!user || !user.encryptedPrivateKey) {
      throw new Error('User or private key not found');
    }

    return this.encryption.decrypt(user.encryptedPrivateKey);
  }

  /**
   * Get a connected wallet instance for a user
   */
  async getUserWallet(userId: string): Promise<ethers.Wallet> {
    const privateKey = await this.getPrivateKey(userId);
    return new ethers.Wallet(privateKey, this.provider);
  }

  /**
   * Store encrypted API credentials for a user
   */
  async storeApiCredentials(
    userId: string,
    credentials: { key: string; secret: string; passphrase: string }
  ): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: {
        encryptedApiKey: this.encryption.encrypt(credentials.key),
        encryptedApiSecret: this.encryption.encrypt(credentials.secret),
        encryptedApiPassphrase: this.encryption.encrypt(credentials.passphrase),
        apiCredentialsCreatedAt: new Date(),
      },
    });
  }

  /**
   * Retrieve and decrypt a user's API credentials
   */
  async getApiCredentials(userId: string): Promise<{
    key: string;
    secret: string;
    passphrase: string;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        encryptedApiKey: true,
        encryptedApiSecret: true,
        encryptedApiPassphrase: true,
      },
    });

    if (!user || !user.encryptedApiKey || !user.encryptedApiSecret || !user.encryptedApiPassphrase) {
      throw new Error('API credentials not found for user');
    }

    const key = this.encryption.decrypt(user.encryptedApiKey);
    let secret = this.encryption.decrypt(user.encryptedApiSecret);
    const passphrase = this.encryption.decrypt(user.encryptedApiPassphrase);

    // CRITICAL: The CLOB API returns URL-safe base64 (with '-' and '_')
    // but the @polymarket/clob-client library uses atob() internally which
    // ONLY accepts standard base64 (with '+' and '/').
    // We MUST convert URL-safe to standard base64 here.
    
    // Remove any whitespace
    secret = secret.replace(/\s/g, '');
    
    // Convert URL-safe base64 to standard base64
    // '-' -> '+' and '_' -> '/'
    secret = secret.replace(/-/g, '+').replace(/_/g, '/');
    
    // Ensure proper padding (atob requires it)
    while (secret.length % 4 !== 0) {
      secret += '=';
    }
    
    // Validate the converted secret
    try {
      const decoded = Buffer.from(secret, 'base64');
      console.log('getApiCredentials: secret converted to standard base64, decoded length:', decoded.length);
      
      // Verify it's valid for atob() (only standard base64 chars)
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      if (!base64Regex.test(secret)) {
        const invalidChars = secret.replace(/[A-Za-z0-9+/=]/g, '');
        console.error('getApiCredentials: Secret still has invalid chars after conversion:', invalidChars);
        throw new Error('Invalid characters in secret after conversion');
      }
    } catch (b64Error) {
      console.error('getApiCredentials: CORRUPTED SECRET - not valid base64!');
      console.error('  Secret length:', secret.length);
      console.error('  Secret preview:', secret.substring(0, 20) + '...');
      throw new Error('Stored API secret is corrupted (invalid base64). Call reset_credentials to regenerate.');
    }

    return { key, secret, passphrase };
  }

  /**
   * Validate a private key format
   */
  isValidPrivateKey(privateKey: string): boolean {
    try {
      new ethers.Wallet(privateKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate a secure key export package
   * 
   * SECURITY: This creates an encrypted export that requires a user-provided
   * password to decrypt. The raw private key is NEVER sent over the network.
   * 
   * Flow:
   * 1. User provides a password they'll use to decrypt locally
   * 2. We encrypt the private key with that password using AES-256-GCM
   * 3. Return the encrypted package + instructions
   * 4. User decrypts locally using the provided script/tool
   */
  async generateSecureExport(
    userId: string,
    exportPassword: string
  ): Promise<{
    encryptedBundle: string;
    salt: string;
    iv: string;
    algorithm: string;
    instructions: string;
  }> {
    if (!exportPassword || exportPassword.length < 12) {
      throw new Error('Export password must be at least 12 characters');
    }

    const privateKey = await this.getPrivateKey(userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { eoaAddress: true, safeAddress: true },
    });

    // Create a bundle with all wallet info
    const bundle = JSON.stringify({
      privateKey,
      eoaAddress: user?.eoaAddress,
      safeAddress: user?.safeAddress,
      exportedAt: new Date().toISOString(),
      warning: 'KEEP THIS SECURE. Anyone with this key controls your wallet.',
    });

    // Generate cryptographic salt and IV
    const crypto = await import('crypto');
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);

    // Derive key from password using PBKDF2
    const derivedKey = crypto.pbkdf2Sync(exportPassword, salt, 100000, 32, 'sha256');

    // Encrypt with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    let encrypted = cipher.update(bundle, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    // Combine encrypted data with auth tag
    const encryptedBundle = encrypted + ':' + authTag.toString('base64');

    return {
      encryptedBundle,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      algorithm: 'aes-256-gcm',
      instructions: `
SECURE KEY EXPORT - DECRYPT LOCALLY ONLY
========================================

Your private key is encrypted with your password using AES-256-GCM.
NEVER share this data or your password with anyone.

To decrypt (Node.js):
----------------------
const crypto = require('crypto');
const password = 'YOUR_EXPORT_PASSWORD';
const salt = Buffer.from('${salt.toString('base64')}', 'base64');
const iv = Buffer.from('${iv.toString('base64')}', 'base64');
const [encrypted, authTag] = '${encryptedBundle}'.split(':');

const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
decipher.setAuthTag(Buffer.from(authTag, 'base64'));

let decrypted = decipher.update(encrypted, 'base64', 'utf8');
decrypted += decipher.final('utf8');
console.log(JSON.parse(decrypted));

To decrypt (Python):
--------------------
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import base64, json

password = b'YOUR_EXPORT_PASSWORD'
salt = base64.b64decode('${salt.toString('base64')}')
iv = base64.b64decode('${iv.toString('base64')}')
encrypted, auth_tag = '${encryptedBundle}'.split(':')

kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100000)
key = kdf.derive(password)

cipher = Cipher(algorithms.AES(key), modes.GCM(iv, base64.b64decode(auth_tag)))
decryptor = cipher.decryptor()
decrypted = decryptor.update(base64.b64decode(encrypted)) + decryptor.finalize()
print(json.loads(decrypted))
      `.trim(),
    };
  }

  /**
   * Verify ownership before export by checking a signed message
   * This ensures only the actual wallet owner can export
   */
  async verifyOwnershipForExport(
    userId: string,
    message: string,
    signature: string
  ): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { eoaAddress: true },
    });

    if (!user?.eoaAddress) {
      throw new Error('User wallet not found');
    }

    try {
      const recoveredAddress = ethers.utils.verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === user.eoaAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Get wallet balance (MATIC)
   */
  async getBalance(address: string): Promise<string> {
    const balance = await this.provider.getBalance(address);
    return ethers.utils.formatEther(balance);
  }

  /**
   * Get USDC balance
   */
  async getUsdcBalance(address: string): Promise<string> {
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(
      config.contracts.usdc,
      usdcAbi,
      this.provider
    );
    
    const balance = await usdcContract.balanceOf(address);
    // USDC has 6 decimals
    return ethers.utils.formatUnits(balance, 6);
  }
}

// Singleton instance
let keyServiceInstance: KeyService | null = null;

export function getKeyService(): KeyService {
  if (!keyServiceInstance) {
    keyServiceInstance = new KeyService();
  }
  return keyServiceInstance;
}

