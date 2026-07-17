import { Module } from '@nestjs/common';

import { ChatOrchestrator } from './chat.orchestrator';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PaymentModule } from '../payment/payment.module';

import { InventoryEngine } from './engines/inventory.engine';
import { PaymentEngine } from './engines/payment.engine';

import { ConversationStore } from './memory/conversation.store';

import { FilterExtractor } from './filter-extractor';
import { LeadExtractor } from './lead-extractor';
import { AppointmentExtractor } from './appointment-extractor';
import { VinExtractor } from './vin-extractor';
import { CompareExtractor } from './compare-extractor';

import { CrmWebhookService } from './crm-webhook.service';
import { PhotoEnrichmentService } from './engines/photo-enrichment.service';
import { AuthModule } from '../auth/auth.module';
import { VinDecoderService } from './vin/vin-decoder.service';
import { GoogleCalendarService } from './calendar/google-calendar.service';
import { PaymentExplainer } from './payment-explainer';
import { MediaEngine } from './media/media.engine';
import { IntelligentRouter } from './intelligence/intelligent.router';
import { IntelligentService } from './intelligence/intelligent.service';
import { VinExplainerService } from './vin/vin-explainer.service';
import { FollowupEngine } from './followup/followup.engine';
import { ClaudeConversationService } from './claude/claude-conversation.service';
import { EscalationsModule } from '../escalations/escalations.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [AuthModule, PaymentModule, EscalationsModule, LeadsModule],
  controllers: [ChatController],
  providers: [
    // orchestrator
    ChatOrchestrator,
    ChatService,
    FollowupEngine,

    // engines
    InventoryEngine,
    PaymentEngine,
    PaymentExplainer,
    MediaEngine,
    IntelligentRouter,
    IntelligentService,
    ClaudeConversationService,

    // memory
    ConversationStore,

    // extractors
    FilterExtractor,
    LeadExtractor,
    AppointmentExtractor,
    VinExtractor,
    CompareExtractor,

    // integrations
    CrmWebhookService,
    PhotoEnrichmentService,

    // VIN decoding
    VinDecoderService,
    VinExplainerService,

    // calendar (E6.7)
    GoogleCalendarService,
  ],
  exports: [ChatOrchestrator, CrmWebhookService],
})
export class ChatModule {}
