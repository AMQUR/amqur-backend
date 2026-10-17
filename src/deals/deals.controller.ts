import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { SoldDealService } from './sold-deal.service';

class RecordSoldDealDto {
  @IsString() @MinLength(1) @MaxLength(64) locationId!: string;
  @IsIn(['staff', 'dms']) source!: 'staff' | 'dms';
  @IsString() @MinLength(1) @MaxLength(128) dmsDealId!: string;
  @IsOptional() @IsString() @MaxLength(64) leadId?: string;
  @IsOptional() @IsString() @MaxLength(17) vin?: string;
  @IsOptional() @IsString() @MaxLength(32) stockNumber?: string;
  @IsOptional() @IsString() @MaxLength(40) soldAt?: string;
}

@Controller('deals')
@UseGuards(RolesGuard)
export class DealsController {
  constructor(private readonly soldDeals: SoldDealService) {}

  /** Reconcile a DMS-attributed sold deal (manager+); fail-closed without live DMS. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('sold/record')
  recordSold(
    @CurrentUser() u: AuthUser,
    @Body() body: RecordSoldDealDto,
  ) {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    return this.soldDeals.recordSoldDeal(
      tenantId,
      { id: u.sub, role: u.role },
      {
        ...body,
        locationId: scopedLocation ?? body.locationId,
      },
    );
  }
}
