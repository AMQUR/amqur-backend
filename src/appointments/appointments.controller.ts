import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AppointmentService } from './appointment.service';
import { parseClock, parseIsoDate } from '../common/time/zoned-time';

class TransitionDto {
  @IsIn([
    'CONFIRMED',
    'CANCELLED',
    'COMPLETED',
    'NO_SHOW',
    'PENDING_CONFIRMATION',
  ])
  to!: AppointmentStatus;
  @IsOptional() @IsString() @MaxLength(40) scheduledAt?: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class RescheduleDto {
  @IsString() @MaxLength(10) date!: string;
  @IsString() @MaxLength(10) time!: string;
}

@Controller('appointments')
@UseGuards(RolesGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('tenantId') tenantId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: AppointmentStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ) {
    assertStaffRole(user);
    const t = resolveTenantId(user, tenantId);
    return this.appointments.list(t, {
      locationId: resolveLocationScope(user, locationId),
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      cursor,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/transition')
  transition(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: TransitionDto,
  ) {
    assertStaffRole(user);
    return this.appointments.staffTransition({
      tenantId: user.tenantId,
      appointmentId: id,
      to: body.to,
      actorId: user.sub,
      scheduledAt: body.scheduledAt,
      note: body.note,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/reschedule')
  async reschedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: RescheduleDto,
  ) {
    assertStaffRole(user);
    const date = parseIsoDate(body.date);
    const time = parseClock(body.time);
    if (!date || time === null)
      throw new BadRequestException('date (YYYY-MM-DD) and time required');
    return this.appointments.reschedule({
      tenantId: user.tenantId,
      appointmentId: id,
      when: { date, time, phrase: `${body.date} ${body.time}` },
      source: 'staff',
      actorId: user.sub,
    });
  }
}
