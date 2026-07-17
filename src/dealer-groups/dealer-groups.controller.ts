import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DealerGroupsService } from './dealer-groups.service';
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
  constructor(private readonly groups: DealerGroupsService) {}

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
