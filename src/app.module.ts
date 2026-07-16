import {
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';

import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from './prisma/prisma.module';
import { TenantsModule } from './tenants/tenants.module';
import { LocationsModule } from './locations/locations.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { InventoryModule } from './inventory/inventory.module';
import { InventoryFeedModule } from './inventory-feed/inventory-feed.module';
import { InventorySyncModule } from './inventory-sync/inventory-sync.module';
import { PublicModule } from './public/public.module';
import { HealthModule } from './health/health.module';
import { LeadsModule } from './leads/leads.module';
import { EscalationsModule } from './escalations/escalations.module';
import { ObservabilityModule } from './observability/observability.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { SourceAuthorityModule } from './source-authority/source-authority.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AiModule } from './ai/ai.module';
import { SavedVehiclesModule } from './saved-vehicles/saved-vehicles.module';
import { PartsModule } from './parts/parts.module';
import { FollowUpModule } from './follow-up/follow-up.module';
import { CopilotModule } from './copilot/copilot.module';
import { CapabilityModule } from './capability/capability.module';
import { CacheModule } from './cache/cache.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { DealerGroupsModule } from './dealer-groups/dealer-groups.module';

import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { LoggerMiddleware } from './common/middleware/logger.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
        allowUnknown: true,
      },
    }),

    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
      {
        name: 'auth',
        ttl: 60_000,
        limit: 20,
      },
    ]),

    ScheduleModule.forRoot(),
    PrismaModule,
    CacheModule,
    FeatureFlagsModule,
    CapabilityModule,
    SourceAuthorityModule,
    AiModule,
    IntegrationsModule,
    TenantsModule,
    LocationsModule,
    UsersModule,
    AuthModule,
    PublicModule,
    OnboardingModule,
    DealerGroupsModule,
    HealthModule,
    LeadsModule,
    EscalationsModule,
    ObservabilityModule,
    SavedVehiclesModule,
    PartsModule,
    FollowUpModule,
    CopilotModule,
    ChatModule,
    InventoryModule,
    InventoryFeedModule,
    InventorySyncModule,
  ],

  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('{*path}');
  }
}
