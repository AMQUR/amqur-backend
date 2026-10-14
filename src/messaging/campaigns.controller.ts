import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CAMPAIGN_TRIGGERS, renderTemplate } from './campaign.engine';

class CampaignDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsIn(Object.keys(CAMPAIGN_TRIGGERS)) trigger!: string;
  @IsIn(['SMS']) channel!: string;
  @IsString() @MinLength(5) @MaxLength(480) template!: string;
  @IsOptional() @IsObject() policy?: Record<string, unknown>;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
}
class PatchDto {
  @IsOptional() @IsString() @MinLength(5) @MaxLength(480) template?: string;
  @IsOptional() @IsObject() policy?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
}

/** Campaign playbooks. Every change bumps `version` (in-flight steps of older versions stop). */
@Controller('campaigns')
@UseGuards(RolesGuard)
export class CampaignsController {
  constructor(private readonly prisma: PrismaService) {}

  private validateTemplate(t: string) {
    const probe = renderTemplate(t, {
      firstName: 'x',
      dealerName: 'x',
      appointmentDate: 'x',
      appointmentTime: 'x',
      vehicle: 'x',
    });
    if (probe === null)
      throw new BadRequestException(
        'Template may only use {firstName} {dealerName} {appointmentDate} {appointmentTime} {vehicle}',
      );
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get()
  list(@CurrentUser() u: AuthUser) {
    assertStaffRole(u);
    return this.prisma.followUpCampaign.findMany({
      where: { tenantId: u.tenantId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() b: CampaignDto) {
    assertStaffRole(u);
    this.validateTemplate(b.template);
    const row = await this.prisma.followUpCampaign.create({
      data: {
        tenantId: u.tenantId,
        name: b.name,
        trigger: b.trigger,
        channel: b.channel,
        template: b.template,
        policy: (b.policy ?? {}) as Prisma.InputJsonValue,
        enabled: false,
        locationId: resolveLocationScope(u, b.locationId),
        startsAt: b.startsAt ? new Date(b.startsAt) : null,
        endsAt: b.endsAt ? new Date(b.endsAt) : null,
        createdByUserId: u.sub,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: u.tenantId,
        userId: u.sub,
        action: 'campaign.create',
        resource: 'FollowUpCampaign',
        resourceId: row.id,
      },
    });
    return row;
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch(':id')
  async update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: PatchDto,
  ) {
    assertStaffRole(u);
    const c = await this.prisma.followUpCampaign.findFirst({
      where: { id, tenantId: u.tenantId },
    });
    if (!c) throw new NotFoundException();
    if (b.template) this.validateTemplate(b.template);
    const row = await this.prisma.followUpCampaign.update({
      where: { id },
      data: {
        ...(b.template !== undefined ? { template: b.template } : {}),
        ...(b.policy !== undefined
          ? { policy: b.policy as Prisma.InputJsonValue }
          : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.startsAt !== undefined
          ? { startsAt: b.startsAt ? new Date(b.startsAt) : null }
          : {}),
        ...(b.endsAt !== undefined
          ? { endsAt: b.endsAt ? new Date(b.endsAt) : null }
          : {}),
        version: { increment: 1 },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: u.tenantId,
        userId: u.sub,
        action: 'campaign.update',
        resource: 'FollowUpCampaign',
        resourceId: id,
        metadata: { fields: Object.keys(b), version: row.version },
      },
    });
    return row;
  }
}
