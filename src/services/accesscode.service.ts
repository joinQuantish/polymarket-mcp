import { prisma } from '../db';
import crypto from 'crypto';

/**
 * AccessCodeService
 * 
 * Manages developer access codes for SDK registration.
 * Only developers with valid access codes can request API keys.
 */

export class AccessCodeService {
  /**
   * Generate a new access code
   * Format: QNT-XXXX-XXXX-XXXX (16 chars + dashes)
   */
  generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0/O, 1/I/L)
    let code = 'QNT-';
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) code += '-';
      code += chars[crypto.randomInt(chars.length)];
    }
    return code;
  }

  /**
   * Create a new access code for a developer
   */
  async createAccessCode(params: {
    developerName?: string;
    developerEmail?: string;
    notes?: string;
    maxUses?: number;
    expiresInDays?: number;
    createdBy?: string;
  }): Promise<{
    code: string;
    id: string;
    expiresAt: Date | null;
    maxUses: number;
  }> {
    const code = this.generateCode();
    
    let expiresAt: Date | null = null;
    if (params.expiresInDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + params.expiresInDays);
    }

    const accessCode = await prisma.accessCode.create({
      data: {
        code,
        developerName: params.developerName,
        developerEmail: params.developerEmail,
        notes: params.notes,
        maxUses: params.maxUses || 1,
        expiresAt,
        createdBy: params.createdBy,
      },
    });

    return {
      code: accessCode.code,
      id: accessCode.id,
      expiresAt: accessCode.expiresAt,
      maxUses: accessCode.maxUses,
    };
  }

  /**
   * Validate and consume an access code
   * Returns true if valid and marks it as used
   */
  async validateAndConsume(code: string, userId: string): Promise<{
    valid: boolean;
    error?: string;
    developerName?: string;
  }> {
    const accessCode = await prisma.accessCode.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (!accessCode) {
      return { valid: false, error: 'Invalid access code' };
    }

    if (!accessCode.isActive) {
      return { valid: false, error: 'Access code has been deactivated' };
    }

    if (accessCode.expiresAt && accessCode.expiresAt < new Date()) {
      return { valid: false, error: 'Access code has expired' };
    }

    // maxUses of -1 means unlimited
    if (accessCode.maxUses !== -1 && accessCode.usedCount >= accessCode.maxUses) {
      return { valid: false, error: 'Access code has reached maximum uses' };
    }

    // Mark as used
    await prisma.accessCode.update({
      where: { id: accessCode.id },
      data: {
        usedCount: { increment: 1 },
        usedBy: accessCode.maxUses === 1 ? userId : accessCode.usedBy,
        usedAt: new Date(),
      },
    });

    return { 
      valid: true, 
      developerName: accessCode.developerName || undefined 
    };
  }

  /**
   * List all access codes (for admin)
   */
  async listAccessCodes(): Promise<any[]> {
    return prisma.accessCode.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        developerName: true,
        developerEmail: true,
        maxUses: true,
        usedCount: true,
        isActive: true,
        expiresAt: true,
        usedAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Revoke an access code
   */
  async revokeAccessCode(codeOrId: string): Promise<boolean> {
    try {
      await prisma.accessCode.updateMany({
        where: {
          OR: [
            { id: codeOrId },
            { code: codeOrId.toUpperCase() },
          ],
        },
        data: { isActive: false },
      });
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton
let accessCodeServiceInstance: AccessCodeService | null = null;

export function getAccessCodeService(): AccessCodeService {
  if (!accessCodeServiceInstance) {
    accessCodeServiceInstance = new AccessCodeService();
  }
  return accessCodeServiceInstance;
}

