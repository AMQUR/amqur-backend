import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { ExperimentsService } from './experiments.service';

class CreateDto {
  @IsString() @MaxLength(40) key!: string;
  @IsOptional() @IsString() locationId?: string;
  @IsArray() variants!: unknown[];
}

@Controller('ops/experiments')
@UseGuards(RolesGuard)
export class ExperimentsController {
  constructor(private readonly ex: ExperimentsService) {}
  private t(u: AuthUser) {
    assertStaffRole(u);
    return resolveTenantId(u, undefined);
  }
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.ex.list(this.t(u));
  }
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() b: CreateDto) {
    return this.ex.create(this.t(u), u.sub, b);
  }
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':id/start')
  start(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ex.setStatus(this.t(u), { id: u.sub, role: u.role }, id, true);
  }
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':id/stop')
  stop(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ex.setStatus(this.t(u), { id: u.sub, role: u.role }, id, false);
  }
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get(':id/results')
  results(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ex.results(this.t(u), id);
  }
}
