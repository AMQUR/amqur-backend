import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetricsService } from './metrics.service';

export type OpsAlertSeverity = 'info' | 'warning' | 'critical';

export type OpsAlertPayload = {
  code: string;
  severity: OpsAlertSeverity;
  summary: string;
  /** Non-secret structured context only. */
  context?: Record<string, string | number | boolean | null>;
};

/**
 * Fail-closed outbound ops alerts.
 * Delivers only when OPS_ALERT_WEBHOOK_URL is configured. Never logs secrets.
 */
@Injectable()
export class OpsAlertService {
  private readonly logger = new Logger(OpsAlertService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  webhookConfigured(): boolean {
    return Boolean(
      (this.config.get<string>('OPS_ALERT_WEBHOOK_URL') ?? '').trim(),
    );
  }

  async notify(
    alert: OpsAlertPayload,
  ): Promise<{ delivered: boolean; reason?: string }> {
    const url = (this.config.get<string>('OPS_ALERT_WEBHOOK_URL') ?? '').trim();
    if (!url) {
      this.metrics.increment('ops.alert.skipped_unconfigured');
      return { delivered: false, reason: 'OPS_ALERT_WEBHOOK_URL_unset' };
    }
    try {
      const body = {
        source: 'amqur-ops',
        code: alert.code.slice(0, 80),
        severity: alert.severity,
        summary: alert.summary.slice(0, 400),
        context: alert.context ?? {},
        at: new Date().toISOString(),
        deploymentTier:
          this.config.get<string>('DEPLOYMENT_TIER') ?? 'unknown',
      };
      await axios.post(url, body, {
        timeout: 8_000,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      this.metrics.increment('ops.alert.delivered');
      this.logger.log(`ops_alert_delivered code=${alert.code}`);
      return { delivered: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.metrics.increment('ops.alert.failed');
      this.logger.warn(
        `ops_alert_failed code=${alert.code} err=${msg.slice(0, 160)}`,
      );
      return { delivered: false, reason: 'delivery_failed' };
    }
  }
}
