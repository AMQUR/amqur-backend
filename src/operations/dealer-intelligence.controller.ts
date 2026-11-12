import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DealerIntelligenceService } from './dealer-intelligence.service';

/** Only platform SUPER_ADMIN may see cross-rooftop private financial/CRM aggregates. */
@Controller('ops/dealer-intelligence')
@UseGuards(RolesGuard)
@Roles('SUPER_ADMIN')
export class DealerIntelligenceController {
  constructor(private readonly intelligence: DealerIntelligenceService) {}

  @Get('snapshot')
  @Header('Cache-Control', 'private, no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  getSnapshot() {
    return this.intelligence.snapshot();
  }
}
