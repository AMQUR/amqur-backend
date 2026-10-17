import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { GbpReviewsService } from './gbp-reviews.service';

class DraftReplyDto {
  @IsString() @MinLength(1) @MaxLength(4000) replyText!: string;
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
}

class PublishReplyDto {
  @IsString() @MinLength(1) @MaxLength(4000) replyText!: string;
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
}

@Controller('ops/reviews')
@UseGuards(RolesGuard)
export class ReviewsController {
  constructor(private readonly gbpReviews: GbpReviewsService) {}

  /** Pending GBP reviews for staff triage (manager+); fail-closed without live GBP. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('pending')
  listPending(
    @CurrentUser() u: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, locationId);
    return this.gbpReviews.listPendingReviews({
      tenantId,
      locationId: scopedLocation ?? locationId ?? null,
    });
  }

  /** Save a reply draft locally — never posts to Google without publish. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':reviewId/draft')
  draft(
    @CurrentUser() u: AuthUser,
    @Param('reviewId') reviewId: string,
    @Body() body: DraftReplyDto,
  ) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    return this.gbpReviews.draftReply({
      tenantId,
      locationId: scopedLocation ?? body.locationId ?? null,
      reviewId,
      replyText: body.replyText,
    });
  }

  /** Publish a staff-approved reply to GBP (manager+); fail-closed until live adapter. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post(':reviewId/publish')
  publish(
    @CurrentUser() u: AuthUser,
    @Param('reviewId') reviewId: string,
    @Body() body: PublishReplyDto,
  ) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    return this.gbpReviews.publishReply({
      tenantId,
      locationId: scopedLocation ?? body.locationId ?? null,
      reviewId,
      replyText: body.replyText,
    });
  }
}
