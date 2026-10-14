import { Module } from '@nestjs/common';
import { OperationsService } from './operations.service';
import {
  OperationsController,
  WidgetLiveController,
} from './operations.controller';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [IntegrationsModule, ChatModule],
  controllers: [OperationsController, WidgetLiveController],
  providers: [OperationsService],
})
export class OperationsModule {}
