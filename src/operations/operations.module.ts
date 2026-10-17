import { Module } from '@nestjs/common';
import { OperationsService } from './operations.service';
import { RooftopReadinessService } from './rooftop-readiness';
import { TradeModule } from '../trade/trade.module';
import {
  OperationsController,
  WidgetLiveController,
} from './operations.controller';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ChatModule } from '../chat/chat.module';
import { UploadsModule } from '../uploads/uploads.module';
import { PartsModule } from '../parts/parts.module';
import { AppointmentsModule } from '../appointments/appointments.module';

@Module({
  imports: [
    IntegrationsModule,
    ChatModule,
    TradeModule,
    UploadsModule,
    PartsModule,
    AppointmentsModule,
  ],
  controllers: [OperationsController, WidgetLiveController],
  providers: [OperationsService, RooftopReadinessService],
})
export class OperationsModule {}
