import { Controller, Get, Query, Post, Body, Headers } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicService } from './public.service';
import { WidgetAuthService } from './widget-auth.service';
import { WidgetTokenDto } from './dto/widget-token.dto';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StoreHoursService } from '../locations/store-hours.service';
import { formatClock } from '../common/time/zoned-time';

@Controller('public')
export class PublicController {
  constructor(
    private readonly publicService: PublicService,
    private readonly widgetAuthService: WidgetAuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Public, verified-only store status for the widget storefront. Returns `known:false`
   * whenever hours are not staff-verified — the widget then shows no open/closed badge.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('store-status')
  async storeStatus(
    @Query('tenantSlug') tenantSlug: string,
    @Query('locationSlug') locationSlug: string,
    @Query('lang') lang?: string,
  ) {
    if (!tenantSlug || !locationSlug) return { known: false };
    const loc = await this.prisma.location.findFirst({
      where: { slug: locationSlug, tenant: { slug: tenantSlug } },
      select: {
        id: true,
        name: true,
        timezone: true,
        storeHours: true,
        departmentHours: true,
        holidayHours: true,
        storeHoursVerifiedAt: true,
        storeHoursVerifiedBy: true,
      },
    });
    if (!loc) return { known: false };
    const profile = StoreHoursService.buildProfile(loc);
    const locale = lang === 'es' ? 'es' : 'en';
    const dept = (d: 'store' | 'service' | 'parts') => {
      const s = StoreHoursService.isOpenAt(profile, new Date(), d);
      return s.known
        ? {
            open: s.open,
            closesAt:
              s.closesAt != null ? formatClock(s.closesAt, locale) : null,
            nextOpen: s.nextOpen
              ? {
                  date: s.nextOpen.date,
                  at: formatClock(s.nextOpen.open, locale),
                }
              : null,
          }
        : null;
    };
    return {
      known: profile.verified,
      /** Local demo only: hours are synthetic and must be labeled as such. */
      simulated: profile.synthetic === true,
      timezone: profile.timezone,
      summary: StoreHoursService.summarize(profile, 'store', locale),
      sales: dept('store'),
      service: profile.weekly.service ? dept('service') : null,
      parts: profile.weekly.parts ? dept('parts') : null,
    };
  }

  @Public()
  @Get('widget-config')
  async widgetConfig(
    @Query('tenantSlug') tenantSlug: string,
    @Query('locationSlug') locationSlug?: string,
  ) {
    return this.publicService.getWidgetConfig(tenantSlug, locationSlug);
  }

  @Public()
  @Throttle({
    default: {
      // Production: 30/min. Test/load lab: raised for paced profiles.
      limit: process.env.NODE_ENV === 'test' ? 5_000 : 30,
      ttl: 60_000,
    },
  })
  @Post('widget-token')
  async createWidgetToken(
    @Body() dto: WidgetTokenDto,
    @Headers('origin') origin?: string,
    @Headers('cookie') cookie?: string,
  ) {
    return this.widgetAuthService.createWidgetToken(
      dto.tenantSlug,
      dto.locationSlug,
      origin,
      cookie,
    );
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}
