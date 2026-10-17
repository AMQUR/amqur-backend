import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsDefined, IsOptional, IsString, ValidateIf } from 'class-validator';
import { LeadsService } from './leads.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  resolveLocationScope,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { LeadStatus } from '@prisma/client';

class AssignLeadDto {
  @IsDefined()
  @ValidateIf((_o, v) => v !== null)
  @IsOptional()
  @IsString()
  assignedUserId!: string | null;
}

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

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Patch(':id/assign')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: AssignLeadDto,
    @Query('tenantId') tenantId?: string,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    const loc = resolveLocationScope(user, locationId);
    return this.leadsService.assignManual(
      scoped,
      loc,
      id,
      user.sub,
      body.assignedUserId,
    );
  }
}
