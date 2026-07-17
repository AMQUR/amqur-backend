import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Controller('tenants')
@UseGuards(RolesGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Roles('SUPER_ADMIN')
  @Post()
  create(@Body() dto: CreateTenantDto, @CurrentUser() user: AuthUser) {
    assertStaffRole(user);
    return this.tenantsService.create(dto, user);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query('tenantId') tenantId?: string) {
    assertStaffRole(user);
    if (user.role === 'SUPER_ADMIN' && !tenantId) {
      return this.tenantsService.findAll();
    }
    const scoped = resolveTenantId(user, tenantId);
    return this.tenantsService.findOne(scoped);
  }
}
