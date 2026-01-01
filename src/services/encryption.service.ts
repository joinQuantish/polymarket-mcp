import crypto from 'crypto';
import { config } from '../config';

/**
 * EncryptionService
 * 
 * Handles secure encryption/decryption of sensitive data like private keys.
 * 
 * VERSION 2: Uses AES-256-GCM with random IV per encryption (more secure)
 * VERSION 1: Uses AES-256-CBC with static IV (backward compatible)
 * 
 * Format:
 * - v2: "v2:iv:authTag:ciphertext" (random IV, GCM authenticated)
 * - v1: "mac:ciphertext" (static IV, HMAC authenticated) - legacy
 */
export class EncryptionService {
  private readonly key: Buffer;
  private readonly legacyIv: Buffer;

  // V2 uses GCM which is more secure (authenticated encryption)
  private readonly v2Algorithm = 'aes-256-gcm';
  // V1 legacy uses CBC
  private readonly v1Algorithm = 'aes-256-cbc';

  constructor() {
    // Validate encryption key
    if (!config.encryption.key || config.encryption.key.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    
    this.key = Buffer.from(config.encryption.key, 'hex');
    
    // Legacy IV for backward compatibility (V1 decryption only)
    if (config.encryption.iv && config.encryption.iv.length === 32) {
      this.legacyIv = Buffer.from(config.encryption.iv, 'hex');
    } else {
      // If no legacy IV, create a dummy (will fail on v1 decrypt, which is fine for new deployments)
      this.legacyIv = crypto.randomBytes(16);
    }
  }

  /**
   * Encrypt plaintext data (V2 - Random IV + GCM)
   * Returns: "v2:iv:authTag:ciphertext"
   */
  encrypt(plaintext: string): string {
    try {
      // Generate random IV for each encryption
      const iv = crypto.randomBytes(16);
      
      const cipher = crypto.createCipheriv(this.v2Algorithm, this.key, iv) as crypto.CipherGCM;
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // Get authentication tag (GCM provides this)
      const authTag = cipher.getAuthTag().toString('hex');

      // Format: v2:iv:authTag:ciphertext
      return `v2:${iv.toString('hex')}:${authTag}:${encrypted}`;
    } catch (error) {
      throw new Error('Encryption failed');
    }
  }

  /**
   * Decrypt ciphertext (supports both V2 and V1 formats)
   */
  decrypt(ciphertext: string): string {
    // Check version
    if (ciphertext.startsWith('v2:')) {
      return this.decryptV2(ciphertext);
    } else {
      // Legacy V1 format
      return this.decryptV1(ciphertext);
    }
  }

  /**
   * Decrypt V2 format: "v2:iv:authTag:ciphertext"
   */
  private decryptV2(ciphertext: string): string {
    try {
      const parts = ciphertext.split(':');
      if (parts.length !== 4 || parts[0] !== 'v2') {
        throw new Error('Invalid V2 ciphertext format');
      }

      const [, ivHex, authTagHex, encrypted] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(this.v2Algorithm, this.key, iv) as crypto.DecipherGCM;
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unsupported state')) {
        throw new Error('Decryption failed - authentication failed (data may be tampered)');
      }
      throw new Error('Decryption failed');
    }
  }

  /**
   * Decrypt V1 format: "mac:ciphertext" (legacy, backward compatible)
   */
  private decryptV1(ciphertext: string): string {
    try {
      const [mac, encrypted] = ciphertext.split(':');
      
      if (!mac || !encrypted) {
        throw new Error('Invalid V1 ciphertext format');
      }

      // Verify HMAC
      const hmac = crypto.createHmac('sha256', this.key);
      hmac.update(encrypted);
      const expectedMac = hmac.digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expectedMac, 'hex'))) {
        throw new Error('HMAC verification failed - data may be tampered');
      }

      const decipher = crypto.createDecipheriv(this.v1Algorithm, this.key, this.legacyIv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      if (error instanceof Error && error.message.includes('HMAC')) {
        throw error;
      }
      throw new Error('Decryption failed');
    }
  }

  /**
   * Re-encrypt data from V1 to V2 format
   * Use this for migration
   */
  reencryptToV2(v1Ciphertext: string): string {
    const plaintext = this.decryptV1(v1Ciphertext);
    return this.encrypt(plaintext);
  }

  /**
   * Check if ciphertext is V2 format
   */
  isV2Format(ciphertext: string): boolean {
    return ciphertext.startsWith('v2:');
  }

  /**
   * Generate a secure random encryption key
   * Use this to generate ENCRYPTION_KEY for .env
   */
  static generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate a secure random IV (for legacy use only)
   */
  static generateIV(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Hash a string (for non-reversible data like API key identifiers)
   */
  hash(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}

// Singleton instance
let encryptionServiceInstance: EncryptionService | null = null;

export function getEncryptionService(): EncryptionService {
  if (!encryptionServiceInstance) {
    encryptionServiceInstance = new EncryptionService();
  }
  return encryptionServiceInstance;
}
