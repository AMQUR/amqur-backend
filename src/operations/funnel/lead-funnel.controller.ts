import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { clampWindowDays } from './lead-funnel';
import { LeadFunnelService } from './lead-funnel.service';

/**
 * Staff-only funnel counts. Tenant comes from the JWT (SUPER_ADMIN may pass ?tenantId=);
 * rooftop-bound staff are confined to their rooftop. Returns counts only.
 */
@Controller('ops')
@UseGuards(RolesGuard)
export class LeadFunnelController {
  constructor(private readonly funnels: LeadFunnelService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('funnel')
  funnel(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
    @Query('locationId') locationId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    return this.funnels.funnel(
      {
        tenantId: resolveTenantId(user, tenantId),
        locationId: resolveLocationScope(user, locationId),
      },
      clampWindowDays(days),
    );
  }
}
