import { Controller, Get, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CreditApplicationService } from './credit-application.service';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/**
 * Opaque, signed click-through to the dealership-approved credit application.
 * The destination comes from verified tenant/location config at click time — never from
 * the request — so this cannot be used as an open redirect.
 */
@Controller('public/credit-link')
export class CreditLinkController {
  constructor(private readonly credit: CreditApplicationService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  async go(@Param('token') token: string, @Res() res: Response) {
    const result = await this.credit.click(token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!result) {
      res
        .status(404)
        .type('text/plain')
        .send(
          'This link is no longer available. Please return to the dealership website.',
        );
      return;
    }
    if (result.kind === 'preview') {
      // Demo preview: the vendor link type / dealership authorization is not confirmed, so we
      // do not navigate to it (a token might be single-use or customer-specific).
      const provider = esc(result.providerName ?? 'the provider');
      const host = esc(result.host ?? '');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      res
        .status(200)
        .type('text/html')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Credit application — demo preview</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#14171c}main{max-width:520px;margin:12vh auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}.tag{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:#fff4d6;color:#7a5200;border-radius:999px;padding:3px 10px;margin-bottom:12px}p{margin:8px 0;color:#3b4250}</style></head>
<body><main><span class="tag">Demo preview</span><h1>Secure credit application</h1>
<p>In production this opens the dealership's ${provider} credit application${host ? ` (${host})` : ''} in a new tab.</p>
<p>The live redirect is turned off for this demo until ${provider} confirms the link type and the dealership authorizes it for this rooftop. Nothing was submitted and no application was started.</p>
<p>You can close this tab and return to the chat.</p></main></body></html>`,
        );
      return;
    }
    res.redirect(302, result.url);
  }
}
