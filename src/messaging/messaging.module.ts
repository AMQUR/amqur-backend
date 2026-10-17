import { Global, Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ConsentService } from './consent.service';
import { MessagingService } from './messaging.service';
import { CampaignEngine } from './campaign.engine';
import { MessagingWebhooksController } from './messaging-webhooks.controller';
import { CampaignsController } from './campaigns.controller';

@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [MessagingWebhooksController, CampaignsController],
  providers: [ConsentService, MessagingService, CampaignEngine],
  exports: [ConsentService, MessagingService, CampaignEngine],
})
export class MessagingModule {}
