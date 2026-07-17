import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query('tenantId') tenantId?: string) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.usersService.findAll(scoped);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthUser) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user, dto.tenantId);
    return this.usersService.create({ ...dto, tenantId }, user);
  }
}
