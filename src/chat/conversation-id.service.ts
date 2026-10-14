import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Server-issued, tenant-bound conversation identifiers for anonymous widget traffic.
 * Format: `cv1.<random 128-bit b64url>.<hmac 128-bit b64url>` where the HMAC binds the id to
 * the tenant. A widget token for tenant A can never address tenant B's conversation, and a
 * client cannot pick an arbitrary id (e.g. "test") that collides with someone else's thread.
 */
@Injectable()
export class ConversationIdService {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const dedicated = this.config.get<string>('CONVERSATION_ID_SECRET')?.trim();
    const base =
      dedicated && dedicated.length >= 32
        ? dedicated
        : (this.config.get<string>('JWT_SECRET') ?? '');
    return createHmac('sha256', base)
      .update('amqur.conversation-id.v1')
      .digest();
  }

  private mac(tenantId: string, rnd: string): string {
    return createHmac('sha256', this.key())
      .update(`${tenantId}:${rnd}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }

  issue(tenantId: string): string {
    const rnd = randomBytes(16).toString('base64url');
    return `cv1.${rnd}.${this.mac(tenantId, rnd)}`;
  }

  verify(tenantId: string, id: string | null | undefined): boolean {
    if (!id || id.length > 80) return false;
    const m = /^cv1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(id);
    if (!m) return false;
    const want = Buffer.from(this.mac(tenantId, m[1]));
    const got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
