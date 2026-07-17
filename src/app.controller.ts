import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // existing root route
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // ✅ health check for Railway / Render / uptime monitoring
  @Get('/health')
  health() {
    return {
      status: 'ok',
      service: 'amqur-backend',
      time: new Date().toISOString(),
    };
  }
}
