import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { EscalationsService } from './escalations.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Controller('escalations')
@UseGuards(RolesGuard)
export class EscalationsController {
  constructor(private readonly escalationsService: EscalationsService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.escalationsService.list(scoped);
  }
}
