import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { TekionProvider } from './tekion/tekion.provider';
import { VAutoFeedProvider } from './vauto/vauto-feed.provider';
import { SecretVaultService } from './core/secret-vault.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveTenantId } from '../common/decorators/current-user.decorator';

@Controller('integrations')
@UseGuards(RolesGuard)
export class IntegrationsHealthController {
  constructor(
    private readonly tekion: TekionProvider,
    private readonly vauto: VAutoFeedProvider,
    private readonly vault: SecretVaultService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('health')
  async health(@CurrentUser() user: AuthUser) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const connections = tenantId
      ? await this.prisma.integrationConnection.findMany({
          where: { tenantId },
          select: {
            id: true,
            provider: true,
            capability: true,
            enabled: true,
            liveReady: true,
            healthStatus: true,
            lastSuccessAt: true,
            lastError: true,
          },
        })
      : [];

    const [tekionHealth, vautoHealth] = await Promise.all([
      this.tekion.healthCheck(),
      this.vauto.healthCheck(),
    ]);

    return {
      secretVaultReady: this.vault.isReady(),
      providers: {
        tekion: {
          liveConfigured: this.tekion.isLiveConfigured(),
          ...tekionHealth,
        },
        vauto: {
          liveConfigured: this.vauto.isLiveConfigured(),
          ...vautoHealth,
        },
      },
      connections,
      note: 'Live Tekion remains disabled until partner credentials and official API contract are supplied.',
    };
  }
}
