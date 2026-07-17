import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class CrmWebhookService {
  private readonly logger = new Logger(CrmWebhookService.name);
  private readonly webhookUrl: string | undefined;

  constructor(config: ConfigService) {
    this.webhookUrl = config.get<string>('CRM_WEBHOOK_URL');
  }

  async send(payload: any) {
    const url = this.webhookUrl;
    if (!url) {
      this.logger.debug('CRM_WEBHOOK_URL not configured — skipping webhook.');
      return;
    }

    try {
      await axios.post(url, payload, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      this.logger.log('CRM webhook sent successfully.');
    } catch (error: any) {
      this.logger.error(
        'CRM webhook failed',
        error?.response?.data || error.message,
      );
    }
  }
}
export type CrmPayload = {
  source: string;
  tenantId: string;
  locationId?: string | null;
  timestamp: string;

  lead?: {
    name?: string;
    phone?: string;
    email?: string;
  };

  selectedVehicle?: {
    vin?: string;
    status?: 'VIEWED' | 'COMPARE' | 'HOLD';
  };

  appointment?: {
    date?: string;
    time?: string;
  };

  leadIntelligence?: {
    score: number;
    stage: 'cold' | 'warm' | 'hot';
    events: string[];
    lastEvent?: string;
  };
};
