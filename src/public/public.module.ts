import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { WidgetAuthService } from './widget-auth.service';
import { CanaryAuthService } from './canary-auth.service';
import { CanaryAuthController } from './canary-auth.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule, // provides JwtService
  ],
  controllers: [PublicController, CanaryAuthController],
  providers: [PublicService, WidgetAuthService, CanaryAuthService],
  exports: [PublicService],
})
export class PublicModule {}
