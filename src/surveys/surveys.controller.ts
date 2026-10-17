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
  @IsOptional() @IsString() channel?: string;
}

class RecordResponseDto {
  @IsInt() @Min(1) @Max(10) score!: number;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
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
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.surveys.list(tenantId, {
      locationId: loc,
      status: status as never,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('rollup')
  rollup(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.surveys.rollup(tenantId, { locationId: loc });
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
}
