import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { LeadStatus } from '@prisma/client';

@Controller('leads')
@UseGuards(RolesGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: LeadStatus,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.leadsService.list(scoped, { status });
  }
}
