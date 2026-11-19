import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LeadDeliveryChannel,
  LeadDeliveryDepartment,
  LeadDeliveryFormat,
  LeadDeliveryRoute,
  LeadDeliveryRouteEnvironment,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretVaultService } from '../core/secret-vault.service';
import {
  destinationDomain,
  fingerprintDestination,
  isReservedTestDomain,
  maskDestination,
  normalizeDestination,
} from './destination';

/** Staff-safe projection — never the ciphertext, never the address. */
export const ROUTE_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  channel: true,
  department: true,
  environment: true,
  enabled: true,
  destinationMasked: true,
  format: true,
  adfVersion: true,
  verified: true,
  verifiedAt: true,
  verifiedBy: true,
  // verificationEvidence is free text that may contain the full destination address, which
  // this projection promises never to return. Staff see who verified and when, not the text.
  productionEnabled: true,
  productionEnabledAt: true,
  productionEnabledBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Per-rooftop destination registry. Mutations are server-side only (seed / operator CLI) in
 * this phase — there is deliberately no HTTP endpoint that can verify or production-enable a
 * route.
 */
@Injectable()
export class LeadDeliveryRouteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: SecretVaultService,
    private readonly config: ConfigService,
  ) {}

  private keyMaterial(): string {
    const raw = this.config.get<string>('INTEGRATION_ENCRYPTION_KEY') ?? '';
    if (!this.vault.isReady() || raw.length < 32)
      throw new BadRequestException(
        'INTEGRATION_ENCRYPTION_KEY is not configured — cannot store a lead destination',
      );
    return raw;
  }

  fingerprint(address: string): string {
    return fingerprintDestination(address, this.keyMaterial());
  }

  private async audit(
    tenantId: string,
    actor: string,
    action: string,
    route: { id: string; locationId: string; department: string },
    extra: Record<string, unknown> = {},
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action,
        resource: 'lead_delivery_route',
        resourceId: route.id,
        metadata: {
          actor,
          locationId: route.locationId,
          department: route.department,
          ...extra,
        },
      },
    });
  }

  /**
   * Create or rotate a route. Always lands `verified=false, productionEnabled=false`; rotating
   * the address clears any earlier verification.
   */
  async configure(
    tenantId: string,
    input: {
      locationId: string;
      department: LeadDeliveryDepartment;
      address: string;
      environment?: LeadDeliveryRouteEnvironment;
      format?: LeadDeliveryFormat;
      enabled?: boolean;
    },
    actor: string,
  ) {
    const address = normalizeDestination(input.address);
    if (!address)
      throw new BadRequestException(
        'Destination must be exactly one plain mailbox address',
      );
    const environment = input.environment ?? 'SANDBOX';
    const reserved = isReservedTestDomain(destinationDomain(address));
    if (environment === 'SANDBOX' && !reserved)
      throw new BadRequestException(
        'A SANDBOX route may only point at a reserved test domain (e.g. *.example.invalid)',
      );
    if (environment === 'PRODUCTION' && reserved)
      throw new BadRequestException(
        'A PRODUCTION route cannot point at a reserved test domain',
      );
    const loc = await this.prisma.location.findFirst({
      where: { id: input.locationId, tenantId },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found for this tenant');
    const fingerprint = this.fingerprint(address);
    const enc = this.vault.encrypt(address);
    const where = {
      tenantId_locationId_channel_department: {
        tenantId,
        locationId: input.locationId,
        channel: LeadDeliveryChannel.ADF_EMAIL,
        department: input.department,
      },
    };
    const existing = await this.prisma.leadDeliveryRoute.findUnique({ where });
    const sameTarget =
      existing?.destinationFingerprint === fingerprint &&
      existing.environment === environment;
    const secret = {
      destinationCiphertext: enc.ciphertext,
      destinationIv: enc.iv,
      destinationAuthTag: enc.authTag,
      destinationFingerprint: fingerprint,
      destinationMasked: maskDestination(address),
    };
    const route = await this.prisma.leadDeliveryRoute.upsert({
      where,
      create: {
        tenantId,
        locationId: input.locationId,
        department: input.department,
        environment,
        enabled: input.enabled !== false,
        format: input.format ?? 'XML_BODY',
        ...secret,
      },
      update: {
        environment,
        enabled: input.enabled !== false,
        ...(input.format ? { format: input.format } : {}),
        ...secret,
        ...(sameTarget
          ? {}
          : {
              verified: false,
              verifiedAt: null,
              verifiedBy: null,
              verificationEvidence: null,
              productionEnabled: false,
              productionEnabledAt: null,
              productionEnabledBy: null,
            }),
      },
      select: ROUTE_PUBLIC_SELECT,
    });
    await this.audit(
      tenantId,
      actor,
      sameTarget
        ? 'lead_delivery_route.updated'
        : 'lead_delivery_route.configured',
      route,
      { environment, fingerprint },
    );
    return route;
  }

  private async own(tenantId: string, routeId: string) {
    const route = await this.prisma.leadDeliveryRoute.findFirst({
      where: { id: routeId, tenantId },
    });
    if (!route) throw new NotFoundException('Route not found');
    return route;
  }

  /**
   * Record that the recipient was verified, with the evidence reference. The verification is
   * bound to the DESTINATION that was reviewed: pass `address` (the mailbox the reviewer
   * confirmed) and it must still be the route's destination; and the write itself is
   * conditional on the fingerprint read here, so an address rotated concurrently can never end
   * up marked verified.
   */
  async verify(
    tenantId: string,
    routeId: string,
    input: { evidence: string; address?: string },
    actor: string,
  ) {
    const route = await this.own(tenantId, routeId);
    const evidence = (input.evidence ?? '').trim().slice(0, 500);
    if (evidence.length < 6)
      throw new BadRequestException('Verification evidence is required');
    if (input.address !== undefined) {
      const reviewed = normalizeDestination(input.address);
      if (
        !reviewed ||
        this.fingerprint(reviewed) !== route.destinationFingerprint
      )
        throw new ConflictException('route_destination_changed');
    }
    const res = await this.prisma.leadDeliveryRoute.updateMany({
      where: {
        id: route.id,
        tenantId,
        destinationFingerprint: route.destinationFingerprint,
      },
      data: {
        verified: true,
        verifiedAt: new Date(),
        verifiedBy: actor,
        verificationEvidence: evidence,
      },
    });
    // The destination changed between the read and the write: nothing was verified.
    if (res.count !== 1)
      throw new ConflictException('route_destination_changed');
    const updated = await this.prisma.leadDeliveryRoute.findFirstOrThrow({
      where: { id: route.id, tenantId },
      select: ROUTE_PUBLIC_SELECT,
    });
    await this.audit(tenantId, actor, 'lead_delivery_route.verified', route, {
      environment: route.environment,
    });
    return updated;
  }

  /** Only a verified PRODUCTION route can be production-enabled (also a DB CHECK). */
  async setProductionEnabled(
    tenantId: string,
    routeId: string,
    enabled: boolean,
    actor: string,
  ) {
    const route = await this.own(tenantId, routeId);
    if (enabled && route.environment !== 'PRODUCTION')
      throw new ConflictException(
        'A SANDBOX route can never be production-enabled',
      );
    if (enabled && !route.verified)
      throw new ConflictException('Route is not verified');
    const updated = await this.prisma.leadDeliveryRoute.update({
      where: { id: route.id },
      data: {
        productionEnabled: enabled,
        productionEnabledAt: enabled ? new Date() : null,
        productionEnabledBy: enabled ? actor : null,
      },
      select: ROUTE_PUBLIC_SELECT,
    });
    await this.audit(
      tenantId,
      actor,
      enabled
        ? 'lead_delivery_route.production_enabled'
        : 'lead_delivery_route.production_disabled',
      route,
    );
    return updated;
  }

  async setEnabled(
    tenantId: string,
    routeId: string,
    enabled: boolean,
    actor: string,
  ) {
    const route = await this.own(tenantId, routeId);
    const updated = await this.prisma.leadDeliveryRoute.update({
      where: { id: route.id },
      data: { enabled },
      select: ROUTE_PUBLIC_SELECT,
    });
    await this.audit(
      tenantId,
      actor,
      enabled ? 'lead_delivery_route.enabled' : 'lead_delivery_route.disabled',
      route,
    );
    return updated;
  }

  /**
   * The ONLY lookup used for sending: keyed by the lead's own tenant + location + department.
   * There is no default, fallback, tenant-wide or group-wide route.
   */
  async findForLead(
    tenantId: string,
    locationId: string | null,
    department: LeadDeliveryDepartment,
  ): Promise<LeadDeliveryRoute | null> {
    if (!locationId) return null;
    return this.prisma.leadDeliveryRoute.findUnique({
      where: {
        tenantId_locationId_channel_department: {
          tenantId,
          locationId,
          channel: LeadDeliveryChannel.ADF_EMAIL,
          department,
        },
      },
    });
  }

  /** Internal only — decrypts the address and re-checks it against the stored fingerprint. */
  revealDestination(route: LeadDeliveryRoute): string | null {
    try {
      const address = normalizeDestination(
        this.vault.decrypt({
          ciphertext: route.destinationCiphertext,
          iv: route.destinationIv,
          authTag: route.destinationAuthTag,
        }),
      );
      if (!address) return null;
      return this.fingerprint(address) === route.destinationFingerprint
        ? address
        : null;
    } catch {
      return null;
    }
  }

  listMasked(tenantId: string, locationId?: string | null) {
    return this.prisma.leadDeliveryRoute.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: [{ locationId: 'asc' }, { department: 'asc' }],
      select: ROUTE_PUBLIC_SELECT,
    });
  }
}
