import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { EscalationsService } from './escalations.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

class EscalationNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}

class EscalationResolveDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@Controller('escalations')
@UseGuards(RolesGuard)
export class EscalationsController {
  constructor(private readonly escalationsService: EscalationsService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('tenantId') tenantId?: string,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    // Non-admins are locked to their JWT location when present.
    const loc =
      user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
        ? locationId
        : (user.locationId ?? locationId);
    return this.escalationsService.list(scoped, loc ?? undefined);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/acknowledge')
  acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.escalationsService.acknowledge({
      tenantId: scoped,
      escalationId: id,
      actorUserId: user.sub,
      locationId:
        user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
          ? null
          : user.locationId,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/claim')
  claim(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.escalationsService.claim({
      tenantId: scoped,
      escalationId: id,
      actorUserId: user.sub,
      locationId:
        user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
          ? null
          : user.locationId,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/resolve')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: EscalationResolveDto,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.escalationsService.resolve({
      tenantId: scoped,
      escalationId: id,
      actorUserId: user.sub,
      note: body.note,
      locationId:
        user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
          ? null
          : user.locationId,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/notes')
  addNote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: EscalationNoteDto,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.escalationsService.addNote({
      tenantId: scoped,
      escalationId: id,
      actorUserId: user.sub,
      note: body.note,
      locationId:
        user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
          ? null
          : user.locationId,
    });
  }
}
