import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardDealershipDto } from './dto/onboard-dealership.dto';
import { PublicService } from '../public/public.service';
import * as bcrypt from 'bcryptjs';
import { InventoryFeedType, Prisma, Role } from '@prisma/client';
import { assertFeedUrlAllowed } from '../common/security/feed-url.guard';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicService: PublicService,
  ) {}

  /**
   * Idempotent dealership onboarding for internal/ops use.
   * Safe to re-run: updates mutable fields; does not delete data.
   */
  async onboard(dto: OnboardDealershipDto, actorUserId?: string) {
    const idempotent = dto.idempotent !== false;
    const dryRun = dto.dryRun === true;

    if (dto.inventoryFeedUrl) {
      assertFeedUrlAllowed(dto.inventoryFeedUrl);
    }

    /** Thrown to abort the transaction after a successful dry run. */
    class DryRunRollback extends Error {
      constructor(public readonly payload: unknown) {
        super('DRY_RUN_ROLLBACK');
      }
    }

    const runTransaction = () =>
      this.prisma.$transaction(async (tx) => {
        let dealerGroupId: string | null = null;
        if (dto.dealerGroupSlug && dto.dealerGroupName) {
          const existingGroup = await tx.dealerGroup.findUnique({
            where: { slug: dto.dealerGroupSlug },
          });
          if (existingGroup) {
            dealerGroupId = existingGroup.id;
            if (idempotent && existingGroup.name !== dto.dealerGroupName) {
              await tx.dealerGroup.update({
                where: { id: existingGroup.id },
                data: { name: dto.dealerGroupName },
              });
            }
          } else {
            const created = await tx.dealerGroup.create({
              data: {
                slug: dto.dealerGroupSlug,
                name: dto.dealerGroupName,
              },
            });
            dealerGroupId = created.id;
          }
        }

        let tenant = await tx.tenant.findUnique({
          where: { slug: dto.tenantSlug },
        });

        const publicConfig = {
          ...(typeof tenant?.publicConfig === 'object' && tenant?.publicConfig
            ? (tenant.publicConfig as object)
            : {}),
          ...(dto.branding ?? {}),
        };

        const featureFlags = {
          ...(typeof tenant?.featureFlags === 'object' && tenant?.featureFlags
            ? (tenant.featureFlags as object)
            : {}),
          ...(dto.featureFlags ?? {}),
        };

        if (!tenant) {
          tenant = await tx.tenant.create({
            data: {
              name: dto.tenantName,
              slug: dto.tenantSlug,
              dealerGroupId,
              allowedOrigins: dto.allowedOrigins?.join(',') ?? null,
              publicConfig,
              featureFlags,
              dataRetentionDays: dto.dataRetentionDays ?? 365,
              consentText: dto.consentText ?? null,
            },
          });
        } else if (idempotent) {
          tenant = await tx.tenant.update({
            where: { id: tenant.id },
            data: {
              name: dto.tenantName,
              dealerGroupId: dealerGroupId ?? tenant.dealerGroupId,
              allowedOrigins:
                dto.allowedOrigins?.join(',') ?? tenant.allowedOrigins,
              publicConfig,
              featureFlags,
              dataRetentionDays:
                dto.dataRetentionDays ?? tenant.dataRetentionDays,
              consentText: dto.consentText ?? tenant.consentText,
              configVersion: { increment: 1 },
            },
          });
        } else {
          throw new BadRequestException('TENANT_ALREADY_EXISTS');
        }

        let location = await tx.location.findUnique({
          where: {
            tenantId_slug: { tenantId: tenant.id, slug: dto.locationSlug },
          },
        });

        const locPublic = {
          ...(typeof location?.publicConfig === 'object' &&
          location?.publicConfig
            ? (location.publicConfig as object)
            : {}),
          ...(dto.branding ?? {}),
        };

        const feedType = dto.inventoryFeedType
          ? (dto.inventoryFeedType as InventoryFeedType)
          : undefined;

        if (!location) {
          location = await tx.location.create({
            data: {
              tenantId: tenant.id,
              name: dto.locationName,
              slug: dto.locationSlug,
              address: dto.address ?? null,
              phone: dto.phone ?? null,
              timezone: dto.timezone ?? 'America/Chicago',
              storeHours:
                (dto.storeHours as Prisma.InputJsonValue) ?? undefined,
              publicConfig: locPublic as Prisma.InputJsonValue,
              inventoryFeedUrl: dto.inventoryFeedUrl ?? null,
              inventoryFeedType: feedType,
              escalationRecipients: dto.escalationRecipients?.join(',') ?? null,
            },
          });
        } else if (idempotent) {
          location = await tx.location.update({
            where: { id: location.id },
            data: {
              name: dto.locationName,
              address: dto.address ?? location.address,
              phone: dto.phone ?? location.phone,
              timezone: dto.timezone ?? location.timezone,
              storeHours:
                (dto.storeHours as Prisma.InputJsonValue) ??
                (location.storeHours as Prisma.InputJsonValue),
              publicConfig: locPublic as Prisma.InputJsonValue,
              inventoryFeedUrl:
                dto.inventoryFeedUrl ?? location.inventoryFeedUrl,
              inventoryFeedType: feedType ?? location.inventoryFeedType,
              escalationRecipients:
                dto.escalationRecipients?.join(',') ??
                location.escalationRecipients,
            },
          });
        }

        let adminUserId: string | undefined;
        if (dto.adminUser) {
          const hash = await bcrypt.hash(dto.adminUser.password, 12);
          const existingUser = await tx.user.findUnique({
            where: {
              tenantId_email: {
                tenantId: tenant.id,
                email: dto.adminUser.email.toLowerCase(),
              },
            },
          });
          if (!existingUser) {
            const user = await tx.user.create({
              data: {
                tenantId: tenant.id,
                locationId: location!.id,
                email: dto.adminUser.email.toLowerCase(),
                password: hash,
                firstName: dto.adminUser.firstName,
                lastName: dto.adminUser.lastName,
                role: Role.ADMIN,
              },
            });
            adminUserId = user.id;
          } else {
            adminUserId = existingUser.id;
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: actorUserId,
            action: 'onboarding.dealership',
            resource: 'Tenant',
            resourceId: tenant.id,
            metadata: {
              tenantSlug: tenant.slug,
              locationSlug: location!.slug,
              dealerGroupId,
              idempotent,
            },
          },
        });

        this.logger.log(
          `Onboarded tenant=${tenant.slug} location=${location!.slug} group=${dto.dealerGroupSlug ?? 'none'}`,
        );

        const payload = {
          dryRun,
          dealerGroupId,
          tenant: {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            configVersion: tenant.configVersion,
          },
          location: {
            id: location!.id,
            slug: location!.slug,
            name: location!.name,
          },
          adminUserId: adminUserId ?? null,
        };

        if (dryRun) {
          // Roll everything back — the payload shows what WOULD be applied.
          throw new DryRunRollback(payload);
        }

        return payload;
      });

    let result: unknown;
    try {
      result = await runTransaction();
    } catch (err) {
      if (err instanceof DryRunRollback) {
        this.logger.log(
          `Dry-run onboarding rolled back tenant=${dto.tenantSlug} location=${dto.locationSlug}`,
        );
        return err.payload;
      }
      throw err;
    }

    // Invalidate widget-config cache keys (version already incremented on update)
    await this.publicService
      .invalidateWidgetConfigCache()
      .catch(() => undefined);

    return result;
  }
}
