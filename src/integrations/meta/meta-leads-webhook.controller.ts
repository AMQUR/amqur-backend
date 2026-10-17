import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { MetaLeadsWebhookService } from './meta-leads-webhook.service';

type RequestWithRawBody = Request & { rawBody?: Buffer };

/**
 * Meta Lead Ads webhook intake stub — verifies signatures, persists to WebhookInbox only.
 * Does not create Lead records or enable live Meta CRM sync.
 */
@Controller('webhooks/meta')
export class MetaLeadsWebhookController {
  constructor(private readonly intake: MetaLeadsWebhookService) {}

  @Public()
  @Post('leads')
  @HttpCode(200)
  async leads(
    @Req() req: RequestWithRawBody,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
  ) {
    if (!process.env.META_APP_SECRET?.trim()) {
      throw new ServiceUnavailableException({
        reason: 'not_configured',
        message: 'Meta lead webhook intake is not configured (META_APP_SECRET).',
      });
    }

    const rawBody =
      req.rawBody ??
      (typeof req.body === 'string'
        ? Buffer.from(req.body)
        : Buffer.from(JSON.stringify(req.body ?? {})));

    const row = await this.intake.intake({
      rawBody,
      signatureHeader,
      parsedBody: req.body,
    });

    return {
      ok: row.status !== 'REJECTED',
      inboxId: row.id,
      status: row.status,
    };
  }
}
