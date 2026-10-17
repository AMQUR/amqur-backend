import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { ActionPagesService } from './action-pages.service';

class CreateActionPageDto {
  @IsIn([
    'SCHEDULE',
    'TRADE_INTAKE',
    'PARTS_INTAKE',
    'DOCUMENT_UPLOAD',
    'FINANCE_INFO',
    'CONTACT_UPDATE',
    'CUSTOM',
  ])
  kind!: string;
  @IsString() @MinLength(2) @MaxLength(120) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsObject() formSchema?: Record<string, unknown>;
  @IsOptional() @IsObject() staffMeta?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(1) @Max(720) expiresInHours?: number;
}

class CompleteDto {
  @IsObject() payload!: Record<string, unknown>;
}

@Controller()
export class ActionPagesController {
  constructor(private readonly pages: ActionPagesService) {}

  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('action-pages')
  list(@CurrentUser() u: AuthUser) {
    assertStaffRole(u);
    return this.pages.list(u.tenantId);
  }

  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('action-pages')
  create(@CurrentUser() u: AuthUser, @Body() b: CreateActionPageDto) {
    assertStaffRole(u);
    return this.pages.create({
      tenantId: u.tenantId,
      locationId: resolveLocationScope(u, b.locationId),
      leadId: b.leadId,
      conversationId: b.conversationId,
      kind: b.kind,
      title: b.title,
      description: b.description,
      formSchema: b.formSchema,
      staffMeta: b.staffMeta,
      expiresInHours: b.expiresInHours,
      createdByUserId: u.sub,
    });
  }

  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('action-pages/:id/revoke')
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    assertStaffRole(u);
    return this.pages.revoke(u.tenantId, id, u.sub);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('public/action-pages/:token')
  resolve(@Param('token') token: string) {
    return this.pages.resolvePublic(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/action-pages/:token/complete')
  complete(@Param('token') token: string, @Body() b: CompleteDto) {
    return this.pages.completePublic(token, b.payload ?? {});
  }
}
