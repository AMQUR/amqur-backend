import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SpotlightsService } from './spotlights.service';

class SpotlightDto {
  @IsIn(['VEHICLE', 'OFFER', 'EVENT', 'ANNOUNCEMENT']) kind!:
    | 'VEHICLE'
    | 'OFFER'
    | 'EVENT'
    | 'ANNOUNCEMENT';
  @IsString() @MaxLength(80) title!: string;
  @IsString() @MaxLength(400) body!: string;
  @IsOptional() @IsString() @MaxLength(500) linkUrl?: string;
  @IsOptional() @IsString() @MaxLength(17) vehicleVin?: string;
  @IsOptional() @IsString() @MaxLength(120) source?: string;
  @IsOptional() @IsString() @MaxLength(400) disclaimer?: string;
  @IsISO8601() startsAt!: string;
  @IsISO8601() endsAt!: string;
}
class DecideDto {
  @IsBoolean() approve!: boolean;
}

@Controller()
@UseGuards(RolesGuard)
export class SpotlightsController {
  constructor(
    private readonly spotlights: SpotlightsService,
    private readonly prisma: PrismaService,
  ) {}

  private scope(u: AuthUser, locationId?: string) {
    assertStaffRole(u);
    return {
      tenantId: resolveTenantId(u, undefined),
      locationId: resolveLocationScope(u, locationId),
    };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('ops/spotlights')
  list(@CurrentUser() u: AuthUser, @Query('locationId') locationId?: string) {
    const s = this.scope(u, locationId);
    return this.spotlights.list(s.tenantId, s.locationId);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Post('ops/locations/:id/spotlights')
  create(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: SpotlightDto,
  ) {
    const s = this.scope(u, id);
    return this.spotlights.create(s.tenantId, s.locationId ?? id, u.sub, b);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('ops/spotlights/:id/decision')
  decide(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: DecideDto,
  ) {
    return this.spotlights.decide(
      this.scope(u).tenantId,
      { id: u.sub, role: u.role },
      id,
      b.approve,
    );
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('ops/spotlights/:id/archive')
  archive(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.spotlights.archive(this.scope(u).tenantId, id);
  }

  /** Public, read-only: approved spotlights for one store (no auth; public content only). */
  @Public()
  @Get('public/spotlights')
  async publicList(
    @Query('tenantSlug') tenantSlug: string,
    @Query('locationSlug') locationSlug: string,
  ) {
    if (!tenantSlug || !locationSlug) return [];
    const loc = await this.prisma.location.findFirst({
      where: { slug: locationSlug, tenant: { slug: tenantSlug } },
      select: { id: true, tenantId: true },
    });
    if (!loc) return [];
    return this.spotlights.activeForStore(loc.tenantId, loc.id);
  }
}
