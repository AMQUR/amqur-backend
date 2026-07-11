import { Controller, Get, UseGuards } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Controller('metrics')
@UseGuards(RolesGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Get()
  snapshot(@CurrentUser() user: AuthUser) {
    assertStaffRole(user);
    return {
      counters: this.metrics.snapshot(),
      timestamp: new Date().toISOString(),
    };
  }
}
