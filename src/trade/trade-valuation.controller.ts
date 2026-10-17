import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import type { GetValuationResult } from '../integrations/trade/trade-valuation.provider';
import { TradeService } from './trade.service';

class ValuationVehicleDto {
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
  @IsOptional() @IsString() @MinLength(11) @MaxLength(17) vin?: string;
  @IsOptional() @IsInt() @Min(1980) @Max(2100) year?: number;
  @IsOptional() @IsString() @MaxLength(80) make?: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  @IsOptional() @IsString() @MaxLength(80) trim?: string;
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000) mileage?: number;
  @IsOptional() @IsString() @MaxLength(10) zip?: string;
  @IsOptional() @IsString() @MaxLength(80) condition?: string;
}

function hasVehicleIdentity(d: ValuationVehicleDto): boolean {
  const vin = d.vin?.trim();
  if (vin && vin.length >= 11) return true;
  return !!(d.year && d.make?.trim() && d.model?.trim());
}

@Controller('trade/valuation')
@UseGuards(RolesGuard)
export class TradeValuationController {
  constructor(private readonly trades: TradeService) {}

  /** Rooftop integration gate (manager+); no dollar amounts. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('status')
  async valuationStatus(
    @CurrentUser() u: AuthUser,
    @Query() q: ValuationVehicleDto,
  ): Promise<
    | Awaited<ReturnType<TradeService['getValuationIntegrationStatus']>>
    | GetValuationResult
  > {
    assertStaffRole(u);
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, q.locationId);
    const locationId = scopedLocation ?? q.locationId ?? null;

    if (!hasVehicleIdentity(q)) {
      return this.trades.getValuationIntegrationStatus(tenantId, locationId);
    }

    return this.trades.getValuation(
      {
        tenantId,
        locationId,
        mode: 'sandbox',
        timeoutMs: 15_000,
      },
      {
        vin: q.vin?.trim().toUpperCase() ?? null,
        year: q.year ?? null,
        make: q.make?.trim() ?? null,
        model: q.model?.trim() ?? null,
        trim: q.trim?.trim() ?? null,
        mileage: q.mileage ?? null,
        zip: q.zip?.trim() ?? null,
        condition: q.condition?.trim() ?? null,
      },
    );
  }

  /** Request a licensed provider valuation (manager+); fail-closed without live adapter. */
  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('request')
  requestValuation(
    @CurrentUser() u: AuthUser,
    @Body() body: ValuationVehicleDto,
  ): Promise<GetValuationResult> {
    assertStaffRole(u);
    if (!hasVehicleIdentity(body)) {
      throw new BadRequestException(
        'Supply VIN (11–17 chars) or year + make + model for a valuation request',
      );
    }
    const tenantId = resolveTenantId(u);
    const scopedLocation = resolveLocationScope(u, body.locationId);
    const locationId = scopedLocation ?? body.locationId ?? null;
    return this.trades.getValuation(
      {
        tenantId,
        locationId,
        mode: 'sandbox',
        timeoutMs: 15_000,
      },
      {
        vin: body.vin?.trim().toUpperCase() ?? null,
        year: body.year ?? null,
        make: body.make?.trim() ?? null,
        model: body.model?.trim() ?? null,
        trim: body.trim?.trim() ?? null,
        mileage: body.mileage ?? null,
        zip: body.zip?.trim() ?? null,
        condition: body.condition?.trim() ?? null,
      },
    );
  }
}
