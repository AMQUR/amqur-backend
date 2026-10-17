import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from './messaging.service';
import { ConsentService, normalizeEndpoint } from './consent.service';
import { validateTwilioRequest } from './twilio';
import { redactCreditSensitive } from '../common/security/sensitive-data';
import { MetricsService } from '../observability/metrics.service';

const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)$/i;
const START = /^(start|unstop|yes)$/i;
const HELP = /^(help|info)$/i;
const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Twilio webhooks (official signature validation). Requires PUBLIC_API_URL so the exact
 * URL Twilio signed can be reconstructed; without it every request is rejected (fail closed).
 * Inbound texts never trigger autonomous AI replies here — they land in the staff inbox.
 */
@Controller('webhooks/twilio')
export class MessagingWebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly consent: ConsentService,
    private readonly metrics: MetricsService,
  ) {}

  private async verify(
    tenantSlug: string,
    req: Request,
    signature: string | undefined,
    params: Record<string, string>,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    const base = (
      process.env.PUBLIC_API_URL || process.env.PUBLIC_API_BASE_URL
    )?.replace(/\/$/, '');
    if (!tenant || !base) return null;
    const creds = await this.messaging.twilioCredentials(tenant.id);
    if (!creds) return null;
    const ok = validateTwilioRequest({
      authToken: creds.authToken,
      url: `${base}${req.originalUrl}`,
      signature,
      params,
    });
    if (!ok) {
      this.metrics.increment('messaging.webhook.bad_signature');
      return null;
    }
    return tenant.id;
  }

  @Public()
  @Post(':tenantSlug/sms')
  @HttpCode(200)
  async inbound(
    @Param('tenantSlug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-twilio-signature') sig: string | undefined,
    @Body() body: Record<string, string>,
  ) {
    const tenantId = await this.verify(slug, req, sig, body ?? {});
    res.type('text/xml');
    if (!tenantId) {
      res.status(403).send(EMPTY_TWIML);
      return;
    }
    const from = normalizeEndpoint('SMS', body.From ?? '');
    const text = (body.Body ?? '').trim();
    const kw = (body.OptOutType ?? text).toUpperCase();
    if (from && (body.OptOutType === 'STOP' || STOP.test(text))) {
      await this.consent.record({
        tenantId,
        channel: 'SMS',
        endpoint: from,
        purpose: 'CONVERSATIONAL',
        granted: false,
        source: 'SMS_KEYWORD',
        evidence: { messageSid: body.MessageSid, keyword: kw },
      });
      await this.consent.record({
        tenantId,
        channel: 'SMS',
        endpoint: from,
        purpose: 'MARKETING',
        granted: false,
        source: 'SMS_KEYWORD',
        evidence: { messageSid: body.MessageSid, keyword: kw },
      });
      res.send(EMPTY_TWIML); // Twilio sends the carrier-compliant confirmation itself.
      return;
    }
    if (from && (body.OptOutType === 'START' || START.test(kw))) {
      await this.consent.record({
        tenantId,
        channel: 'SMS',
        endpoint: from,
        purpose: 'CONVERSATIONAL',
        granted: true,
        source: 'SMS_KEYWORD',
        evidence: { messageSid: body.MessageSid, keyword: kw },
      });
      res.send(EMPTY_TWIML);
      return;
    }
    if (body.OptOutType === 'HELP' || HELP.test(kw)) {
      res.send(EMPTY_TWIML);
      return;
    }
    // Link to an existing conversation only through an exact verified endpoint (consent ledger).
    const grant = from
      ? await this.prisma.consentRecord.findFirst({
          where: {
            tenantId,
            channel: 'SMS',
            endpoint: from,
            granted: true,
            conversationExternalKey: { not: null },
          },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const conv = grant?.conversationExternalKey
      ? await this.prisma.conversation.findUnique({
          where: {
            tenantId_externalKey: {
              tenantId,
              externalKey: grant.conversationExternalKey,
            },
          },
        })
      : null;
    if (conv) {
      await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          role: 'USER',
          content: redactCreditSensitive(text).slice(0, 4000),
          metadata: { channel: 'SMS', providerMessageId: body.MessageSid },
        },
      });
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          lastActivityAt: new Date(),
          handoffState: conv.aiPaused ? conv.handoffState : 'REQUESTED',
        },
      });
    } else {
      this.metrics.increment('messaging.inbound.unlinked');
    }
    res.send(EMPTY_TWIML);
  }

  @Public()
  @Post(':tenantSlug/status')
  @HttpCode(200)
  async status(
    @Param('tenantSlug') slug: string,
    @Req() req: Request,
    @Headers('x-twilio-signature') sig: string | undefined,
    @Body() body: Record<string, string>,
  ) {
    const tenantId = await this.verify(slug, req, sig, body ?? {});
    if (!tenantId || !body.MessageSid) return { ok: false };
    const map: Record<string, string> = {
      delivered: 'DELIVERED',
      undelivered: 'UNDELIVERED',
      failed: 'FAILED',
      sent: 'SENT',
    };
    const status = map[(body.MessageStatus ?? '').toLowerCase()];
    if (status) {
      await this.prisma.outboundMessage.updateMany({
        where: { tenantId, providerMessageId: body.MessageSid },
        data: {
          status,
          error: body.ErrorCode ? `twilio_${body.ErrorCode}` : undefined,
        },
      });
    }
    return { ok: true };
  }
}
