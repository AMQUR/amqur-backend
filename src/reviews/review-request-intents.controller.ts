import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { ReviewRequestIntentService } from './review-request-intent.service';

class CreateReviewRequestIntentDto {
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() surveyId?: string;
  @IsOptional() @IsString() channel?: string;
}

class CheckEligibilityDto {
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() surveyId?: string;
  @IsOptional() @IsString() channel?: string;
}

@Controller('ops/review-request-intents')
@UseGuards(RolesGuard)
export class ReviewRequestIntentsController {
  constructor(private readonly intents: ReviewRequestIntentService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, locationId);
    return this.intents.listIntents(tenantId, { locationId: loc });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('check-eligibility')
  checkEligibility(
    @CurrentUser() user: AuthUser,
    @Body() body: CheckEligibilityDto,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, body.locationId);
    return this.intents.checkEligibility({
      tenantId,
      locationId: loc,
      leadId: body.leadId,
      conversationId: body.conversationId,
      surveyId: body.surveyId,
      channel: body.channel,
    });
  }

  /** Creates a PENDING intent only — never queues or sends outbound messages. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateReviewRequestIntentDto,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const loc = resolveLocationScope(user, body.locationId);
    return this.intents.createPendingIntent({
      tenantId,
      locationId: loc,
      leadId: body.leadId,
      conversationId: body.conversationId,
      surveyId: body.surveyId,
      channel: body.channel,
      createdByUserId: user.sub,
    });
  }
}
