import { Module } from '@nestjs/common';
import { ChatOrchestrator } from './chat.orchestrator';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PaymentModule } from '../payment/payment.module';
import { InventoryEngine } from './engines/inventory.engine';
import { JourneyStore } from './memory/journey.store';
import { AuthModule } from '../auth/auth.module';
import { VinDecoderService } from './vin/vin-decoder.service';
import { ClaudeConversationService } from './claude/claude-conversation.service';
import { ConversationComposerService } from './compose/conversation-composer.service';
import { LiveInfoService } from '../live-info/live-info.service';
import { EscalationsModule } from '../escalations/escalations.module';
import { LeadsModule } from '../leads/leads.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { TradeModule } from '../trade/trade.module';
import { PartsModule } from '../parts/parts.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ConversationIdService } from './conversation-id.service';

@Module({
  imports: [
    AuthModule,
    PaymentModule,
    EscalationsModule,
    LeadsModule,
    AnalyticsModule,
    TradeModule,
    PartsModule,
    KnowledgeModule,
    IntegrationsModule,
  ],
  controllers: [ChatController],
  providers: [
    ChatOrchestrator,
    ChatService,
    InventoryEngine,
    JourneyStore,
    ClaudeConversationService,
    ConversationComposerService,
    LiveInfoService,
    VinDecoderService,
    ConversationIdService,
  ],
  exports: [
    ChatOrchestrator,
    InventoryEngine,
    JourneyStore,
    ClaudeConversationService,
    ConversationIdService,
  ],
})
export class ChatModule {}
