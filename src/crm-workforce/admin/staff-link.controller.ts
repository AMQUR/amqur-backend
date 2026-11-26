import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { CrmWfStaffService } from './staff.service';

class TokenDto {
  @IsString() @MinLength(20) @MaxLength(100) token!: string;
}
class AcceptDto {
  @IsString() @MinLength(20) @MaxLength(100) token!: string;
  @IsString() @MinLength(12) @MaxLength(200) password!: string;
}

/**
 * Public routes behind a staff invitation or password-reset link. The token travels in the
 * request body (never the URL, so it is not written to access logs), is single-use, and is
 * rate-limited with the platform's credential throttle.
 */
@Controller('public/crm-workforce/staff-link')
export class CrmWfStaffLinkController {
  constructor(private readonly staff: CrmWfStaffService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('describe')
  describe(@Body() dto: TokenDto) {
    return this.staff.describe(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  accept(@Body() dto: AcceptDto) {
    return this.staff.accept(dto.token, dto.password);
  }
}
