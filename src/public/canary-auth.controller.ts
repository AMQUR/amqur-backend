import {
  Body,
  Controller,
  Headers,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CanaryAuthService } from './canary-auth.service';
import {
  CanaryEligibilityDto,
  IssueCanaryInviteDto,
  RedeemCanaryInviteDto,
  RevokeCanaryInviteDto,
} from './dto/canary-auth.dto';

/**
 * Staff: issue/revoke one-time canary invites.
 * Public: redeem invite → HttpOnly cookie; eligibility check for loader.
 */
@Controller()
export class CanaryAuthController {
  constructor(private readonly canaryAuth: CanaryAuthService) {}

  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('canary/invites')
  issueInvite(
    @Body() dto: IssueCanaryInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canaryAuth.issueInvite({
      tenantSlug: dto.tenantSlug,
      locationSlug: dto.locationSlug,
      testerLabel: dto.testerLabel,
      createdByUserId: user.sub,
    });
  }

  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('canary/invites/revoke')
  revokeInvite(
    @Body() dto: RevokeCanaryInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canaryAuth.revokeInvite(dto.jti, user.sub);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/canary-redeem')
  async redeem(
    @Body() dto: RedeemCanaryInviteDto,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.canaryAuth.redeemInvite(dto.inviteToken, origin);
    res.setHeader(
      'Set-Cookie',
      this.canaryAuth.buildSetCookieHeader(
        result.cookieValue,
        result.maxAgeSec,
      ),
    );
    return {
      ok: true,
      expiresInSec: result.maxAgeSec,
      tenantSlug: result.claims.tenantSlug,
      locationSlug: result.claims.locationSlug,
      environment: result.claims.env,
      // Never echo the cookie value or invite token.
    };
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('public/canary-eligibility')
  async eligibility(
    @Body() dto: CanaryEligibilityDto,
    @Headers('origin') origin: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ) {
    return this.canaryAuth.checkEligibility({
      cookieHeader: cookie,
      requestOrigin: origin,
      tenantSlug: dto.tenantSlug,
      locationSlug: dto.locationSlug,
    });
  }
}
