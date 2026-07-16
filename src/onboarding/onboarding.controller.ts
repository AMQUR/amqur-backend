import { Body, Controller, Post } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardDealershipDto } from './dto/onboard-dealership.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * Internal authenticated onboarding API — SUPER_ADMIN only.
 * Idempotent and audited. Never expose publicly without auth.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('dealership')
  @Roles('SUPER_ADMIN')
  onboard(
    @Body() dto: OnboardDealershipDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onboarding.onboard(dto, user.sub);
  }
}
