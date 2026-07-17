import { Injectable, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';
import { ConfigService } from '@nestjs/config';

/**
 * AES-256-GCM encryption for integration secrets.
 * Requires INTEGRATION_ENCRYPTION_KEY (32+ chars) — derives 32-byte key via SHA-256.
 */
@Injectable()
export class SecretVaultService {
  private readonly logger = new Logger(SecretVaultService.name);

  constructor(private readonly config: ConfigService) {}

  private key(): Buffer | null {
    const raw = this.config.get<string>('INTEGRATION_ENCRYPTION_KEY') ?? '';
    if (!raw || raw.length < 32) return null;
    return createHash('sha256').update(raw).digest();
  }

  isReady(): boolean {
    return this.key() !== null;
  }

  encrypt(plaintext: string): {
    ciphertext: string;
    iv: string;
    authTag: string;
  } {
    const key = this.key();
    if (!key) {
      throw new Error(
        'INTEGRATION_ENCRYPTION_KEY missing or too short — cannot store secrets',
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: enc.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  decrypt(parts: { ciphertext: string; iv: string; authTag: string }): string {
    const key = this.key();
    if (!key) {
      throw new Error(
        'INTEGRATION_ENCRYPTION_KEY missing — cannot decrypt secrets',
      );
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(parts.authTag, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(parts.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  }

  /** Never log secret values — helper for safe operational messages. */
  redact(_value: string): string {
    this.logger.debug('secret redacted');
    return '[REDACTED]';
  }
}
