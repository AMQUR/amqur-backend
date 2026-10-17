import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { MetaLeadsWebhookService } from './meta-leads-webhook.service';

type RequestWithRawBody = Request & { rawBody?: Buffer };

/**
 * Meta Lead Ads webhook intake — signature-verified POST + hub GET verify.
 * Lead materialization is separate (inbox processor). Not live CRM sync.
 */
@Controller('webhooks/meta')
export class MetaLeadsWebhookController {
  constructor(private readonly intake: MetaLeadsWebhookService) {}

  @Public()
  @Get('leads')
  hubVerify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const result = this.intake.verifyHubSubscription({
      mode,
      verifyToken,
      challenge,
    });
    if (!result.ok) {
      if (result.reason === 'not_configured') {
        throw new ServiceUnavailableException({
          reason: 'not_configured',
          message:
            'Meta hub verify is not configured (META_WEBHOOK_VERIFY_TOKEN).',
        });
      }
      throw new ForbiddenException({ reason: result.reason });
    }
    res.status(200).type('text/plain').send(result.challenge);
  }

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
        message:
          'Meta lead webhook intake is not configured (META_APP_SECRET).',
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
