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

import { LeadFunnelController } from './funnel/lead-funnel.controller';
import { LeadFunnelService } from './funnel/lead-funnel.service';

@Module({
  imports: [
    IntegrationsModule,
    ChatModule,
    TradeModule,
    UploadsModule,
    PartsModule,
    AppointmentsModule,
  ],
  controllers: [
    OperationsController,
    WidgetLiveController,
    LeadFunnelController,
  ],
  providers: [OperationsService, RooftopReadinessService, LeadFunnelService],
})
export class OperationsModule {}
