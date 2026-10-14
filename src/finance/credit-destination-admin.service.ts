import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretVaultService } from '../integrations/core/secret-vault.service';
import { CreditApplicationService } from './credit-application.service';
import {
  checkDestination,
  CREDIT_CONNECTION_CAPABILITY,
  CREDIT_LINK_TYPES,
  CREDIT_SECRET_KEY,
  CreditConnectionConfig,
  CreditLinkType,
  destinationFingerprint,
  KNOWN_CREDIT_PROVIDERS,
  maskedDestination,
} from './credit-destination';

/**
 * Administrator lifecycle for a location's credit-application destination:
 * configure / rotate (replace URL), record vendor link type + dealership authorization,
 * validate, disable. No redeploy needed. The URL is encrypted at rest; responses, logs and
 * audit entries only ever contain the host and a short fingerprint.
 *
 * Validation is STRUCTURAL ONLY (https, exact allowlisted host, credentials in vault).
 * AMQUR never navigates to the destination to "test" it — a tokenized link could be
 * single-use or tied to a customer.
 */
@Injectable()
export class CreditDestinationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: SecretVaultService,
    private readonly credit: CreditApplicationService,
  ) {}

  private async location(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true, creditApplication: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  private async audit(
    tenantId: string,
    userId: string,
    locationId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        // Operator-script actors ("cli:<email>") are not staff user rows.
        userId: userId.startsWith('cli:') ? null : userId,
        action,
        resource: 'Location',
        resourceId: locationId,
        metadata: { ...metadata, actor: userId } as Prisma.InputJsonValue,
      },
    });
  }

  async status(tenantId: string, locationId: string) {
    const loc = await this.location(tenantId, locationId);
    const conn = await this.credit.loadVaultConnection(tenantId, locationId);
    const res = await this.credit.resolve(tenantId, locationId);
    const raw = (loc.creditApplication ?? {}) as Record<string, unknown>;
    return {
      enabled: raw.enabled === true,
      destination:
        raw.destination === 'vault' ? 'vault' : raw.url ? 'plain' : 'none',
      vault: conn
        ? maskedDestination(conn.config as unknown as CreditConnectionConfig)
        : null,
      customerFacing: res.available
        ? { available: true, preview: res.preview }
        : { available: false, reason: res.reason },
    };
  }

  /** Configure or ROTATE the destination. A new URL resets authorization (must be re-approved). */
  async configure(
    tenantId: string,
    locationId: string,
    userId: string,
    input: {
      url: string;
      providerName?: string;
      label?: string;
      linkType?: CreditLinkType;
      demoPreview?: boolean;
      enable?: boolean;
    },
  ) {
    await this.location(tenantId, locationId);
    if (!this.vault.isReady())
      throw new BadRequestException(
        'INTEGRATION_ENCRYPTION_KEY is not configured — cannot store a credit destination securely',
      );
    let host: string;
    try {
      host = new URL(input.url.trim()).hostname.toLowerCase();
    } catch {
      throw new BadRequestException('Destination is not a valid URL');
    }
    const chk = checkDestination(input.url, [host]);
    if (!chk.ok)
      throw new BadRequestException(`Destination rejected: ${chk.reason}`);
    const linkType = input.linkType ?? 'UNVERIFIED';
    if (!CREDIT_LINK_TYPES.includes(linkType))
      throw new BadRequestException('Unknown linkType');
    const url = chk.url.toString();
    const fingerprint = destinationFingerprint(url);
    const existing = await this.credit.loadVaultConnection(
      tenantId,
      locationId,
    );
    const prev = existing?.config as unknown as
      | CreditConnectionConfig
      | undefined;
    const sameUrl = prev?.fingerprint === fingerprint;
    const config: CreditConnectionConfig = {
      host,
      providerName:
        input.providerName?.slice(0, 60) ??
        KNOWN_CREDIT_PROVIDERS[host] ??
        null,
      linkType,
      fingerprint,
      configuredAt:
        sameUrl && prev ? prev.configuredAt : new Date().toISOString(),
      configuredBy: sameUrl && prev ? prev.configuredBy : userId,
      // Rotation (different URL) always clears a previous authorization.
      authorization: sameUrl && prev?.authorization ? prev.authorization : null,
      demoPreview: input.demoPreview === true,
      label: input.label?.slice(0, 60) ?? null,
    };
    const enc = this.vault.encrypt(url);
    await this.prisma.$transaction(async (tx) => {
      const conn = await tx.integrationConnection.upsert({
        where: {
          tenantId_locationId_provider_capability: {
            tenantId,
            locationId,
            provider: 'TEKION',
            capability: CREDIT_CONNECTION_CAPABILITY,
          },
        },
        create: {
          tenantId,
          locationId,
          provider: 'TEKION',
          capability: CREDIT_CONNECTION_CAPABILITY,
          enabled: true,
          liveReady: false,
          config: config as unknown as Prisma.InputJsonValue,
        },
        update: {
          enabled: true,
          config: config as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.integrationSecret.upsert({
        where: {
          connectionId_keyName: {
            connectionId: conn.id,
            keyName: CREDIT_SECRET_KEY,
          },
        },
        create: { connectionId: conn.id, keyName: CREDIT_SECRET_KEY, ...enc },
        update: enc,
      });
      await tx.location.update({
        where: { id: locationId },
        data: {
          creditApplication: {
            enabled: input.enable !== false,
            destination: 'vault',
            allowedHosts: [host],
            providerName: config.providerName,
            label: config.label ?? 'Secure Credit Application',
          } as Prisma.InputJsonValue,
        },
      });
    });
    await this.audit(
      tenantId,
      userId,
      locationId,
      sameUrl ? 'credit_destination.updated' : 'credit_destination.configured',
      {
        host,
        fingerprint,
        linkType,
        demoPreview: config.demoPreview,
        rotated: !!prev && !sameUrl,
      },
    );
    return this.status(tenantId, locationId);
  }

  /**
   * Records the vendor-confirmed link type and the dealership's written authorization for THIS
   * location. Required before any live redirect. PER_CUSTOMER can be recorded but never goes
   * live with a static token.
   */
  async authorize(
    tenantId: string,
    locationId: string,
    userId: string,
    input: { linkType: CreditLinkType; evidenceRef: string },
  ) {
    await this.location(tenantId, locationId);
    if (
      !CREDIT_LINK_TYPES.includes(input.linkType) ||
      input.linkType === 'UNVERIFIED'
    )
      throw new BadRequestException(
        'linkType must be PUBLIC_REUSABLE, DEALER_REUSABLE or PER_CUSTOMER',
      );
    const ref = (input.evidenceRef ?? '').trim();
    if (ref.length < 6)
      throw new BadRequestException(
        'evidenceRef must reference the written vendor/dealership confirmation',
      );
    const conn = await this.credit.loadVaultConnection(tenantId, locationId);
    if (!conn) throw new BadRequestException('No destination configured');
    const cfg = conn.config as unknown as CreditConnectionConfig;
    const next: CreditConnectionConfig = {
      ...cfg,
      linkType: input.linkType,
      authorization: {
        approvedBy: userId,
        approvedAt: new Date().toISOString(),
        evidenceRef: ref.slice(0, 200),
      },
    };
    await this.prisma.integrationConnection.update({
      where: { id: conn.id },
      data: {
        config: next as unknown as Prisma.InputJsonValue,
        liveReady: input.linkType !== 'PER_CUSTOMER',
      },
    });
    await this.audit(
      tenantId,
      userId,
      locationId,
      'credit_destination.authorized',
      {
        host: cfg.host,
        fingerprint: cfg.fingerprint,
        linkType: input.linkType,
        evidenceRef: ref.slice(0, 200),
      },
    );
    return this.status(tenantId, locationId);
  }

  async disable(tenantId: string, locationId: string, userId: string) {
    const loc = await this.location(tenantId, locationId);
    const raw = (loc.creditApplication ?? {}) as Record<string, unknown>;
    await this.prisma.location.update({
      where: { id: locationId },
      data: {
        creditApplication: { ...raw, enabled: false } as Prisma.InputJsonValue,
      },
    });
    await this.prisma.integrationConnection.updateMany({
      where: {
        tenantId,
        locationId,
        provider: 'TEKION',
        capability: CREDIT_CONNECTION_CAPABILITY,
      },
      data: { enabled: false },
    });
    await this.audit(
      tenantId,
      userId,
      locationId,
      'credit_destination.disabled',
      {},
    );
    return this.status(tenantId, locationId);
  }
}
