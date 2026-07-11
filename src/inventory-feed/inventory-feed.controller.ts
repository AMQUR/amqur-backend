import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InventoryFeedService } from './inventory-feed.service';
import { VehicleNormalizer } from './normalizer/vehicle.normalizer';
import { ParseInventoryFeedDto } from './dto/parse-inventory-feed.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  assertStaffRole,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { assertFeedUrlAllowed } from '../common/security/feed-url.guard';

@Controller('inventory-feed')
@UseGuards(RolesGuard)
export class InventoryFeedController {
  constructor(private readonly feed: InventoryFeedService) {}

  /** Staff-only debug/parse endpoint — never expose to widget JWTs. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('parse')
  async parse(
    @Body() body: ParseInventoryFeedDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertStaffRole(user);

    let url: URL;
    try {
      url = assertFeedUrlAllowed(body.url);
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof ForbiddenException) {
        throw e;
      }
      throw new BadRequestException('Invalid feed URL');
    }

    // Also enforce env host allowlist when configured
    const raw = process.env.INVENTORY_FEED_ALLOWED_HOSTS ?? '';
    const allowed = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) {
      throw new ForbiddenException(
        'INVENTORY_FEED_ALLOWED_HOSTS must be configured to use parse',
      );
    }
    if (!allowed.includes(url.hostname.toLowerCase())) {
      throw new ForbiddenException('Feed host is not allowed');
    }

    const feedRaw = await this.feed.fetchFeed(url.toString());
    const records = this.feed.parseFeed(body.type, feedRaw);

    if (!Array.isArray(records)) {
      throw new BadRequestException(
        'Feed parsed successfully but no vehicle array was found. Please verify feed structure.',
      );
    }

    const vehicles = records
      .map((record) => VehicleNormalizer.normalize(record))
      .filter((v) => v !== null);

    return {
      count: vehicles.length,
      sample: vehicles.slice(0, 3),
    };
  }
}
