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

@Module({
  imports: [IntegrationsModule, ChatModule, TradeModule],
  controllers: [OperationsController, WidgetLiveController],
  providers: [OperationsService, RooftopReadinessService],
})
export class OperationsModule {}
