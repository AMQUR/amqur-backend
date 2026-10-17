import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { KnowledgeStatus, KnowledgeVisibility } from '@prisma/client';
import { KnowledgeLifecycleService } from './knowledge-lifecycle.service';
import { resolveLocationScope } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  resolveTenantId,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { KnowledgeService } from './knowledge.service';

class CreateKnowledgeDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  canonicalUrl?: string;

  @IsOptional()
  @IsIn(['CUSTOMER', 'STAFF', 'INTERNAL'])
  visibility?: KnowledgeVisibility;
  @IsOptional() @IsDateString() effectiveAt?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}

class EditKnowledgeDocumentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100_000) content?: string;
  @IsOptional()
  @IsIn(['CUSTOMER', 'STAFF', 'INTERNAL'])
  visibility?: KnowledgeVisibility;
  @IsOptional() @IsString() locationId?: string | null;
  @IsOptional() @IsDateString() effectiveAt?: string | null;
  @IsOptional() @IsDateString() expiresAt?: string | null;
}

class TransitionKnowledgeDto {
  @IsIn([
    'PENDING_REVIEW',
    'APPROVED',
    'PUBLISHED',
    'DRAFT',
    'REJECTED',
    'ARCHIVED',
    'EXPIRED',
  ])
  to!: KnowledgeStatus;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class IngestWebsiteDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() locationId?: string;
}

@Controller('knowledge')
@UseGuards(RolesGuard)
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly lifecycle: KnowledgeLifecycleService,
  ) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('documents')
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateKnowledgeDocumentDto,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    const locationId =
      user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
        ? dto.locationId
        : (user.locationId ?? dto.locationId);
    // Visibility is chosen explicitly; documents always start as DRAFT and must be
    // approved + published before the customer assistant can retrieve them.
    return this.lifecycle.create({
      tenantId: scoped,
      locationId,
      title: dto.title,
      content: dto.content,
      canonicalUrl: dto.canonicalUrl,
      visibility: dto.visibility ?? KnowledgeVisibility.STAFF,
      effectiveAt: dto.effectiveAt ? new Date(dto.effectiveAt) : null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      actorId: user.sub,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('documents')
  list(
    @CurrentUser() user: AuthUser,
    @Query('tenantId') tenantId?: string,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    const loc =
      user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
        ? locationId
        : (user.locationId ?? locationId);
    return this.lifecycle.list(scoped, { locationId: loc ?? undefined });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('documents/:id/publish')
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    assertStaffRole(user);
    const scoped = resolveTenantId(user, tenantId);
    return this.lifecycle.transition({
      tenantId: scoped,
      id,
      to: 'PUBLISHED',
      actorId: user.sub,
      actorRole: user.role,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('documents/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    assertStaffRole(user);
    return this.lifecycle.detail(user.tenantId, id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Patch('documents/:id')
  edit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: EditKnowledgeDocumentDto,
  ) {
    assertStaffRole(user);
    return this.lifecycle.edit({
      tenantId: user.tenantId,
      id,
      title: dto.title,
      content: dto.content,
      visibility: dto.visibility,
      locationId:
        dto.locationId === undefined
          ? undefined
          : resolveLocationScope(user, dto.locationId),
      effectiveAt:
        dto.effectiveAt === undefined
          ? undefined
          : dto.effectiveAt
            ? new Date(dto.effectiveAt)
            : null,
      expiresAt:
        dto.expiresAt === undefined
          ? undefined
          : dto.expiresAt
            ? new Date(dto.expiresAt)
            : null,
      actorId: user.sub,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('documents/:id/transition')
  transition(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: TransitionKnowledgeDto,
  ) {
    assertStaffRole(user);
    return this.lifecycle.transition({
      tenantId: user.tenantId,
      id,
      to: dto.to,
      actorId: user.sub,
      actorRole: user.role,
      note: dto.note,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('documents/:id/verify')
  verify(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    assertStaffRole(user);
    return this.lifecycle.markVerified(user.tenantId, id, user.sub);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('preview')
  preview(
    @CurrentUser() user: AuthUser,
    @Query('q') q: string,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    return this.lifecycle.preview(
      user.tenantId,
      resolveLocationScope(user, locationId),
      (q ?? '').slice(0, 300),
    );
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('ingest/website')
  ingest(@CurrentUser() user: AuthUser, @Body() dto: IngestWebsiteDto) {
    assertStaffRole(user);
    return this.lifecycle.ingestWebsite(
      user.tenantId,
      resolveLocationScope(user, dto.locationId),
      dto.url,
      dto.title,
    );
  }
}
