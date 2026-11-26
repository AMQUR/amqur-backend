import { Module, Global } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { RetentionService } from './retention.service';
import { OpsAlertService } from './ops-alert.service';

@Global()
@Module({
  providers: [MetricsService, RetentionService, OpsAlertService],
  controllers: [MetricsController],
  exports: [MetricsService, RetentionService, OpsAlertService],
})
export class ObservabilityModule {}
