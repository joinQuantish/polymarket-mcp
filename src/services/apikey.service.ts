import crypto from 'crypto';
import { prisma } from '../db';
import { getEncryptionService } from './encryption.service';

/**
 * ApiKeyService
 * 
 * Handles secure API key generation, hashing, and validation.
 * API keys are hashed before storage so they cannot be recovered.
 */
export class ApiKeyService {
  private encryption = getEncryptionService();

  /**
   * Generate a new secure API key
   * Format: pk_live_<random32chars>
   */
  generateApiKey(): string {
    const randomBytes = crypto.randomBytes(24);
    const key = `pk_live_${randomBytes.toString('base64url')}`;
    return key;
  }

  /**
   * Generate a secret for HMAC signing
   * Format: sk_live_<random32chars>
   */
  generateApiSecret(): string {
    const randomBytes = crypto.randomBytes(32);
    return `sk_live_${randomBytes.toString('base64url')}`;
  }

  /**
   * Hash an API key for storage
   * Uses SHA-256 for fast lookups (API keys are already high entropy)
   */
  hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Get the prefix of an API key (for identification without exposing full key)
   */
  getKeyPrefix(apiKey: string): string {
    return apiKey.substring(0, 16);
  }

  /**
   * Create a new API key for a user
   * Returns the raw key and secret (only time they're visible)
   */
  async createApiKey(
    userId: string,
    name?: string
  ): Promise<{ apiKey: string; apiSecret: string; keyId: string; keyPrefix: string }> {
    const apiKey = this.generateApiKey();
    const apiSecret = this.generateApiSecret();
    const keyHash = this.hashApiKey(apiKey);
    const keyPrefix = this.getKeyPrefix(apiKey);
    
    // Encrypt the secret for storage (we need to decrypt to verify HMAC)
    const encryptedSecret = this.encryption.encrypt(apiSecret);

    const keyRecord = await prisma.userApiKey.create({
      data: {
        userId,
        keyHash,
        keyPrefix,
        encryptedSecret,
        name: name || 'Default',
        isActive: true,
      },
    });

    // Log the creation
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'API_KEY_CREATED',
        resource: 'api_key',
        resourceId: keyRecord.id,
        details: { keyPrefix, name },
      },
    });

    return {
      apiKey,      // This is the ONLY time the full key is returned
      apiSecret,   // This is the ONLY time the secret is returned
      keyId: keyRecord.id,
      keyPrefix,
    };
  }

  /**
   * Validate an API key and return the associated user
   * Returns null if key is invalid or inactive
   */
  async validateApiKey(apiKey: string): Promise<{
    userId: string;
    keyId: string;
    encryptedSecret: string | null;
    user: {
      id: string;
      externalId: string;
      eoaAddress: string;
      safeAddress: string | null;
      status: string;
    };
  } | null> {
    if (!apiKey || !apiKey.startsWith('pk_live_')) {
      return null;
    }

    const keyHash = this.hashApiKey(apiKey);

    const keyRecord = await prisma.userApiKey.findUnique({
      where: { keyHash },
      include: {
        user: {
          select: {
            id: true,
            externalId: true,
            eoaAddress: true,
            safeAddress: true,
            status: true,
          },
        },
      },
    });

    if (!keyRecord) {
      return null;
    }

    // Check if key is active
    if (!keyRecord.isActive) {
      return null;
    }

    // Check expiration
    if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
      return null;
    }

    // Update last used timestamp (async, don't wait)
    prisma.userApiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {}); // Ignore errors

    return {
      userId: keyRecord.userId,
      keyId: keyRecord.id,
      encryptedSecret: keyRecord.encryptedSecret,
      user: keyRecord.user,
    };
  }

  /**
   * Verify HMAC signature for request signing
   * Expected signature format: HMAC-SHA256(timestamp + method + path + body, secret)
   */
  verifyHmacSignature(
    signature: string,
    timestamp: string,
    method: string,
    path: string,
    body: string,
    encryptedSecret: string
  ): boolean {
    try {
      // Decrypt the stored secret
      const secret = this.encryption.decrypt(encryptedSecret);
      
      // Check timestamp is within 30 seconds (replay attack prevention)
      const timestampMs = parseInt(timestamp, 10);
      const now = Date.now();
      const timeDiff = Math.abs(now - timestampMs);
      
      if (timeDiff > 30000) { // 30 seconds
        console.log('HMAC: Timestamp too old or too far in future');
        return false;
      }
      
      // Build the message to sign: timestamp + method + path + body
      const message = `${timestamp}${method.toUpperCase()}${path}${body || ''}`;
      
      // Calculate expected signature
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('hex');
      
      // Constant-time comparison
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch (error) {
      console.error('HMAC verification error:', error);
      return false;
    }
  }

  /**
   * Revoke an API key
   */
  async revokeApiKey(keyId: string, userId: string): Promise<boolean> {
    const keyRecord = await prisma.userApiKey.findFirst({
      where: { id: keyId, userId },
    });

    if (!keyRecord) {
      return false;
    }

    await prisma.userApiKey.update({
      where: { id: keyId },
      data: {
        isActive: false,
        revokedAt: new Date(),
      },
    });

    await prisma.activityLog.create({
      data: {
        userId,
        action: 'API_KEY_REVOKED',
        resource: 'api_key',
        resourceId: keyId,
      },
    });

    return true;
  }

  /**
   * List all API keys for a user (without exposing actual keys)
   */
  async listUserApiKeys(userId: string): Promise<Array<{
    id: string;
    keyPrefix: string;
    name: string | null;
    isActive: boolean;
    lastUsedAt: Date | null;
    createdAt: Date;
  }>> {
    const keys = await prisma.userApiKey.findMany({
      where: { userId },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return keys;
  }

  /**
   * Get active key count for a user
   */
  async getActiveKeyCount(userId: string): Promise<number> {
    return prisma.userApiKey.count({
      where: { userId, isActive: true },
    });
  }
}

// Singleton instance
let apiKeyServiceInstance: ApiKeyService | null = null;

export function getApiKeyService(): ApiKeyService {
  if (!apiKeyServiceInstance) {
    apiKeyServiceInstance = new ApiKeyService();
  }
  return apiKeyServiceInstance;
}

