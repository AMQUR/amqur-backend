import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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

    const ok = database === 'up';
    return {
      ok,
      status: ok ? 'ready' : 'degraded',
      checks: {
        database,
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Public()
  @Get('live')
  live() {
    return { ok: true, status: 'live' };
  }
}
