import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsInt,
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
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { CustomerSurveyService } from './customer-survey.service';

class CreateDraftDto {
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() appointmentId?: string;
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() templateId?: string;
  @IsOptional() @IsString() channel?: string;
}

class RecordResponseDto {
  @IsInt() @Min(1) @Max(10) score!: number;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

class ResolveFollowUpDto {
  @IsOptional() @IsString() @MaxLength(2000) managerNote?: string;
}

class CreateTemplateDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsString() @MinLength(10) @MaxLength(4000) scriptBody!: string;
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsString() defaultChannel?: string;
}

@Controller('ops/surveys')
@UseGuards(RolesGuard)
export class SurveysController {
  constructor(private readonly surveys: CustomerSurveyService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.surveys.list(tenantId, {
      locationId: loc,
      status: status as never,
      kind,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('rollup')
  rollup(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('kind') kind?: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.surveys.rollup(tenantId, { locationId: loc, kind });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('follow-ups')
  followUps(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.surveys.listFollowUps(tenantId, { locationId: loc });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('templates')
  templates(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('kind') kind?: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.surveys.listTemplates(tenantId, { locationId: loc, kind });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('templates')
  createTemplate(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateTemplateDto,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, body.locationId);
    return this.surveys.createTemplate({
      tenantId,
      locationId: loc,
      kind: body.kind,
      name: body.name,
      scriptBody: body.scriptBody,
      defaultChannel: body.defaultChannel,
      createdByUserId: user.sub,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateDraftDto) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, body.locationId);
    return this.surveys.createDraft({
      tenantId,
      locationId: loc,
      leadId: body.leadId,
      conversationId: body.conversationId,
      appointmentId: body.appointmentId,
      kind: body.kind,
      templateId: body.templateId,
      channel: body.channel,
      createdByUserId: user.sub,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post(':id/response')
  record(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: RecordResponseDto,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    return this.surveys.recordResponse({
      tenantId,
      surveyId: id,
      score: body.score,
      comment: body.comment,
      actorUserId: user.sub,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':id/follow-up/acknowledge')
  ackFollowUp(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    return this.surveys.acknowledgeFollowUp({
      tenantId,
      surveyId: id,
      actorUserId: user.sub,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':id/follow-up/resolve')
  resolveFollowUp(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ResolveFollowUpDto,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    return this.surveys.resolveFollowUp({
      tenantId,
      surveyId: id,
      actorUserId: user.sub,
      managerNote: body.managerNote,
    });
  }
}
