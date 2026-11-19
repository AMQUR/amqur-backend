import { Body, Controller, Get, Param, Query, Post } from '@nestjs/common';
import { DealerGroupsService } from './dealer-groups.service';
import { GroupOverviewService } from './overview/group-overview.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { DealerGroupRole } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

class AddMembershipDto {
  @IsString()
  userId!: string;

  @IsEnum(DealerGroupRole)
  role!: DealerGroupRole;
}

@Controller('dealer-groups')
export class DealerGroupsController {
  constructor(
    private readonly groups: DealerGroupsService,
    private readonly overviews: GroupOverviewService,
  ) {}

  @Get()
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  list(@CurrentUser() user: AuthUser) {
    return this.groups.listForUser(user.sub, user.role === 'SUPER_ADMIN');
  }

  @Get(':id/reporting')
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  reporting(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.groups.reportingSummary({
      dealerGroupId: id,
      actorUserId: user.sub,
      isSuperAdmin: user.role === 'SUPER_ADMIN',
    });
  }

  @Get(':id/rooftops')
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  rooftops(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.groups.rooftopMetrics({
      dealerGroupId: id,
      actorUserId: user.sub,
      isSuperAdmin: user.role === 'SUPER_ADMIN',
    });
  }

  @Get(':id/comparison')
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  comparison(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
  ) {
    return this.groups.comparison({
      dealerGroupId: id,
      actorUserId: user.sub,
      isSuperAdmin: user.role === 'SUPER_ADMIN',
      days: Number(days ?? 7),
    });
  }

  /**
   * Group overview: each member rooftop's lead/appointment funnel and integration capability
   * matrix. Counts and status words only; group members and SUPER_ADMIN.
   */
  @Get(':id/overview')
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  overview(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
  ) {
    return this.overviews.overview({
      dealerGroupId: id,
      actorUserId: user.sub,
      isSuperAdmin: user.role === 'SUPER_ADMIN',
      days,
    });
  }

  @Post(':id/memberships')
  @Roles('SUPER_ADMIN', 'ADMIN')
  addMembership(
    @Param('id') id: string,
    @Body() dto: AddMembershipDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.groups.addMembership({
      dealerGroupId: id,
      userId: dto.userId,
      role: dto.role,
      actorUserId: user.sub,
      isSuperAdmin: user.role === 'SUPER_ADMIN',
    });
  }
}
