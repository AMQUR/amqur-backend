import { Controller, Get, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CreditApplicationService } from './credit-application.service';

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
    const dest = await this.credit.click(token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!dest) {
      res
        .status(404)
        .type('text/plain')
        .send(
          'This link is no longer available. Please return to the dealership website.',
        );
      return;
    }
    res.redirect(302, dest);
  }
}
