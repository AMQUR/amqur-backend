import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigCacheService } from '../cache/config-cache.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ConfigCacheService,
  ) {}

  @Public()
  @Get()
  async check() {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    const redisConfigured = Boolean(process.env.REDIS_URL?.trim());
    const redis = redisConfigured
      ? this.cache.isRedisHealthy()
        ? 'up'
        : 'down'
      : 'not_configured';

    // Ready requires DB. Redis outage degrades cache but must not block readiness.
    const ok = database === 'up';
    if (!ok) {
      throw new ServiceUnavailableException({
        ok: false,
        status: 'not_ready',
        checks: {
          database,
          redis,
          timestamp: new Date().toISOString(),
        },
      });
    }

    return {
      ok: true,
      status: redis === 'down' ? 'degraded' : 'ready',
      checks: {
        database,
        redis,
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Public()
  @Get('live')
  live() {
    return { ok: true, status: 'live' };
  }

  /** Alias for orchestrators that probe /ready separately from /live. */
  @Public()
  @Get('ready')
  ready() {
    return this.check();
  }
}
