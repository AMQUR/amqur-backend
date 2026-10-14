import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SecretVaultService } from '../integrations/core/secret-vault.service';
import { decodeCanonicalBase64Url } from '../common/security/webhook-signature';
import {
  checkDestination,
  CREDIT_CONNECTION_CAPABILITY,
  CREDIT_SECRET_KEY,
  CreditConnectionConfig,
  CreditLinkType,
  urlLooksSensitive,
} from './credit-destination';

/**
 * Dealer-approved secure credit application handoff. AMQUR never collects SSN, bank or card
 * data in chat; it sends the shopper to the dealership's approved HTTPS destination.
 *
 * Config (Tenant.creditApplication, overridden by Location.creditApplication):
 *   { enabled, url, label?, allowedHosts: string[], providerName?, lastVerifiedAt, verifiedBy?,
 *     returnUrlSupport?, webhookSupport? }
 *
 * Safety:
 *  - destination must be https AND its host must be in allowedHosts AND staff-verified
 *  - destination is re-read from config at click time — never taken from the request/token
 *  - no PII is ever appended to the destination URL
 *  - click tracking uses an opaque HMAC-signed token (financeRequest id + expiry only)
 *  - "completed" is recorded only from an approved provider callback, never from a click
 */
export type CreditApplicationConfig = {
  enabled: boolean;
  url: string;
  label: string;
  allowedHosts: string[];
  providerName: string | null;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  returnUrlSupport: boolean;
  webhookSupport: boolean;
  /** Vendor-confirmed link type (plain-JSON legacy destinations are treated as reusable). */
  linkType?: CreditLinkType;
  host?: string;
};

export type CreditUnavailableReason =
  | 'not_configured'
  | 'disabled'
  | 'not_https'
  | 'host_not_allowlisted'
  | 'not_verified'
  | 'invalid_url'
  | 'sensitive_url_in_plaintext'
  | 'vault_unavailable'
  | 'awaiting_vendor_confirmation'
  | 'not_authorized_for_location'
  | 'per_customer_provider_required';

/**
 * `preview: true` = non-production demo of a destination whose link type/authorization is
 * not yet confirmed. The customer sees a clearly labeled card; the click lands on an AMQUR
 * interstitial and NEVER navigates to (or consumes) the vendor link.
 */
export type CreditLinkResolution =
  | { available: true; preview: boolean; config: CreditApplicationConfig }
  | { available: false; reason: CreditUnavailableReason };

export type CreditClickResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'preview'; providerName: string | null; host: string | null }
  | null;

export function validateCreditConfig(raw: unknown): CreditLinkResolution {
  if (!raw || typeof raw !== 'object')
    return { available: false, reason: 'not_configured' };
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url.trim())
    return { available: false, reason: 'not_configured' };
  if (r.enabled !== true) return { available: false, reason: 'disabled' };
  let u: URL;
  try {
    u = new URL(r.url.trim());
  } catch {
    return { available: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'https:' || u.username || u.password)
    return { available: false, reason: 'not_https' };
  // Credential-bearing links (e.g. ?token=…) belong in the encrypted vault, never plaintext JSON.
  if (urlLooksSensitive(u.toString()))
    return { available: false, reason: 'sensitive_url_in_plaintext' };
  const hosts = Array.isArray(r.allowedHosts)
    ? r.allowedHosts
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim().toLowerCase())
    : [];
  if (!hosts.includes(u.hostname.toLowerCase()))
    return { available: false, reason: 'host_not_allowlisted' };
  if (
    typeof r.lastVerifiedAt !== 'string' ||
    Number.isNaN(Date.parse(r.lastVerifiedAt))
  ) {
    return { available: false, reason: 'not_verified' };
  }
  return {
    available: true,
    preview: false,
    config: {
      enabled: true,
      url: u.toString(),
      host: u.hostname.toLowerCase(),
      linkType: 'PUBLIC_REUSABLE',
      label:
        typeof r.label === 'string' && r.label.trim()
          ? r.label.trim().slice(0, 60)
          : 'Secure credit application',
      allowedHosts: hosts,
      providerName:
        typeof r.providerName === 'string' ? r.providerName.slice(0, 60) : null,
      lastVerifiedAt: r.lastVerifiedAt,
      verifiedBy: typeof r.verifiedBy === 'string' ? r.verifiedBy : null,
      returnUrlSupport: r.returnUrlSupport === true,
      webhookSupport: r.webhookSupport === true,
    },
  };
}

const TOKEN_TTL_MS = 7 * 24 * 3600_000;

@Injectable()
export class CreditApplicationService {
  private readonly logger = new Logger(CreditApplicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly analytics: AnalyticsService,
    private readonly vault: SecretVaultService,
  ) {}

  private isProduction() {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private secret(): string {
    const dedicated = this.config
      .get<string>('CREDIT_LINK_SIGNING_SECRET')
      ?.trim();
    if (dedicated && dedicated.length >= 32) return dedicated;
    const jwt = this.config.get<string>('JWT_SECRET') ?? '';
    // Domain-separated derivation so the JWT secret itself is never used directly.
    return createHmac('sha256', jwt)
      .update('amqur.credit-link.v1')
      .digest('hex');
  }

  async resolve(
    tenantId: string,
    locationId?: string | null,
  ): Promise<CreditLinkResolution> {
    const [tenant, loc] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { creditApplication: true },
      }),
      locationId
        ? this.prisma.location.findFirst({
            where: { id: locationId, tenantId },
            select: { creditApplication: true },
          })
        : Promise.resolve(null),
    ]);
    const merged =
      loc?.creditApplication && typeof loc.creditApplication === 'object'
        ? {
            ...(tenant?.creditApplication as object | null),
            ...(loc.creditApplication as object),
          }
        : tenant?.creditApplication;
    if (
      merged &&
      typeof merged === 'object' &&
      (merged as Record<string, unknown>).destination === 'vault'
    ) {
      return this.resolveVault(
        tenantId,
        locationId ?? null,
        merged as Record<string, unknown>,
      );
    }
    return validateCreditConfig(merged);
  }

  /** Load the vault-backed destination for exactly this tenant + location. */
  async loadVaultConnection(tenantId: string, locationId: string | null) {
    if (!locationId) return null;
    return this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        locationId,
        provider: 'TEKION',
        capability: CREDIT_CONNECTION_CAPABILITY,
      },
      include: { secrets: { where: { keyName: CREDIT_SECRET_KEY } } },
    });
  }

  private async resolveVault(
    tenantId: string,
    locationId: string | null,
    r: Record<string, unknown>,
  ): Promise<CreditLinkResolution> {
    if (r.enabled !== true) return { available: false, reason: 'disabled' };
    const conn = await this.loadVaultConnection(tenantId, locationId);
    if (!conn || !conn.enabled || !conn.secrets.length)
      return { available: false, reason: 'not_configured' };
    const cfg = conn.config as unknown as CreditConnectionConfig;
    if (!this.vault.isReady())
      return { available: false, reason: 'vault_unavailable' };
    let url: string;
    try {
      url = this.vault.decrypt(conn.secrets[0]);
    } catch {
      this.logger.warn(
        `credit destination decrypt failed tenant=${tenantId} location=${locationId}`,
      );
      return { available: false, reason: 'vault_unavailable' };
    }
    const allowed = Array.isArray(r.allowedHosts)
      ? (r.allowedHosts as unknown[]).filter(
          (h): h is string => typeof h === 'string',
        )
      : [];
    const chk = checkDestination(url, allowed);
    if (!chk.ok) return { available: false, reason: chk.reason };
    if (cfg.linkType === 'PER_CUSTOMER')
      return { available: false, reason: 'per_customer_provider_required' };
    const config: CreditApplicationConfig = {
      enabled: true,
      url: chk.url.toString(),
      host: chk.host,
      linkType: cfg.linkType,
      label:
        typeof r.label === 'string' && r.label.trim()
          ? r.label.trim().slice(0, 60)
          : 'Secure Credit Application',
      allowedHosts: allowed.map((h) => h.toLowerCase()),
      providerName: cfg.providerName ?? null,
      lastVerifiedAt: cfg.authorization?.approvedAt ?? null,
      verifiedBy: cfg.authorization?.approvedBy ?? null,
      returnUrlSupport: false,
      webhookSupport: false,
    };
    const confirmedType =
      cfg.linkType === 'PUBLIC_REUSABLE' || cfg.linkType === 'DEALER_REUSABLE';
    if (confirmedType && cfg.authorization) {
      return { available: true, preview: false, config };
    }
    if (cfg.demoPreview && !this.isProduction()) {
      return { available: true, preview: true, config };
    }
    return {
      available: false,
      reason: confirmedType
        ? 'not_authorized_for_location'
        : 'awaiting_vendor_confirmation',
    };
  }

  sign(financeRequestId: string, tenantId: string, now = Date.now()): string {
    const body = Buffer.from(
      JSON.stringify({
        f: financeRequestId,
        t: tenantId,
        e: now + TOKEN_TTL_MS,
      }),
    ).toString('base64url');
    const mac = createHmac('sha256', this.secret())
      .update(body)
      .digest('base64url');
    return `${body}.${mac}`;
  }

  verify(
    token: string,
    now = Date.now(),
  ): { financeRequestId: string; tenantId: string } | null {
    const [body, mac] = token.split('.');
    if (!body || !mac || body.length > 400) return null;
    const expected = createHmac('sha256', this.secret()).update(body).digest();
    const got = decodeCanonicalBase64Url(mac);
    if (!got) return null;
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        f?: string;
        t?: string;
        e?: number;
      };
      if (!p.f || !p.t || !p.e || p.e < now) return null;
      return { financeRequestId: p.f, tenantId: p.t };
    } catch {
      return null;
    }
  }

  /** Build the customer-facing tracked link (relative to the public API base). */
  trackedPath(financeRequestId: string, tenantId: string): string {
    return `/public/credit-link/${this.sign(financeRequestId, tenantId)}`;
  }

  async markOffered(
    tenantId: string,
    financeRequestId: string,
    locationId?: string | null,
  ) {
    await this.prisma.financeRequest.updateMany({
      where: { id: financeRequestId, tenantId, creditLinkState: 'NONE' },
      data: { creditLinkState: 'OFFERED', creditLinkOfferedAt: new Date() },
    });
    void this.analytics.trackEvent(
      tenantId,
      locationId ?? null,
      'credit_link_offered',
      {},
      undefined,
    );
  }

  /** Click handler: returns the CURRENT approved destination or null (never from the token). */
  async click(token: string): Promise<CreditClickResult> {
    const v = this.verify(token);
    if (!v) return null;
    const fr = await this.prisma.financeRequest.findFirst({
      where: { id: v.financeRequestId, tenantId: v.tenantId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        creditLinkState: true,
      },
    });
    if (!fr) return null;
    const res = await this.resolve(fr.tenantId, fr.locationId);
    if (!res.available) {
      this.logger.warn(
        `credit link click blocked tenant=${fr.tenantId} reason=${res.reason}`,
      );
      return null;
    }
    if (res.preview) {
      // Demo preview: nothing is opened at the vendor, so the link is NOT recorded as clicked.
      void this.analytics.trackEvent(
        fr.tenantId,
        fr.locationId,
        'credit_link_preview_opened',
        {},
        undefined,
      );
      return {
        kind: 'preview',
        providerName: res.config.providerName,
        host: res.config.host ?? null,
      };
    }
    await this.prisma.financeRequest.update({
      where: { id: fr.id },
      data: {
        creditLinkState:
          fr.creditLinkState === 'COMPLETED_VERIFIED'
            ? fr.creditLinkState
            : 'CLICKED',
        creditLinkClickedAt: new Date(),
      },
    });
    void this.analytics.trackEvent(
      fr.tenantId,
      fr.locationId,
      'credit_link_clicked',
      {},
      undefined,
    );
    return { kind: 'redirect', url: res.config.url };
  }
}
