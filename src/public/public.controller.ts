import { Controller, Get, Query, Post, Body, Headers } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicService } from './public.service';
import { WidgetAuthService } from './widget-auth.service';
import { WidgetTokenDto } from './dto/widget-token.dto';
import { Public } from '../common/decorators/public.decorator';

@Controller('public')
export class PublicController {
  constructor(
    private readonly publicService: PublicService,
    private readonly widgetAuthService: WidgetAuthService,
  ) {}

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
