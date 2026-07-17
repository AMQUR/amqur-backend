import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { LocationsService } from './locations.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Controller('locations')
@UseGuards(RolesGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query('tenantId') tenantId?: string) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.locationsService.findAll(scoped);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post()
  create(@Body() dto: CreateLocationDto, @CurrentUser() user: AuthUser) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user, dto.tenantId);
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    return this.locationsService.create({ ...dto, tenantId }, user);
  }
}
