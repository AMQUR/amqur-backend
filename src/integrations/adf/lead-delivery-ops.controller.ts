import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { LeadDeliveryService } from './lead-delivery.service';
import type { ReconcileResult } from './lead-delivery.service';
import { LeadDeliveryRouteService } from './lead-delivery-route.service';

const RECONCILE_RESULTS = [
  'CRM_PARSED',
  'CRM_MATCHED',
  'CRM_REJECTED',
] as const;

class ReconcileDto {
  @IsIn(RECONCILE_RESULTS) result!: ReconcileResult;
  @IsOptional() @IsString() @MaxLength(128) crmRecordRef?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

const ASSERT_EVIDENCE_KINDS = [
  'mailbox_message_id',
  'smtp_relay_log',
  'crm_ingest_receipt',
] as const;

class AssertAcceptedDto {
  @IsString() @MaxLength(300) note!: string;
  @IsIn(ASSERT_EVIDENCE_KINDS)
  evidenceKind!: (typeof ASSERT_EVIDENCE_KINDS)[number];
  /** Durable Message-ID (mailbox/smtp) or opaque CRM ingest id. */
  @IsString() @MaxLength(200) evidenceReference!: string;
}

const STAFF = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] as const;

/**
 * Staff-only operator API for lead deliveries. Tenant comes from the JWT (SUPER_ADMIN may pass
 * ?tenantId=); location-bound staff are confined to their rooftop. Another tenant's delivery is
 * a 404. Responses never contain a destination address or customer contact data.
 */
@Controller('ops')
@UseGuards(RolesGuard)
export class LeadDeliveryOpsController {
  constructor(
    private readonly deliveries: LeadDeliveryService,
    private readonly routes: LeadDeliveryRouteService,
  ) {}

  private scope(user: AuthUser, tenantId?: string, locationId?: string) {
    assertStaffRole(user);
    return {
      tenantId: resolveTenantId(user, tenantId),
      locationId: resolveLocationScope(user, locationId),
    };
  }

  @Roles(...STAFF)
  @Get('lead-deliveries')
  list(
    @CurrentUser() u: AuthUser,
    @Query('status') status?: string,
    @Query('locationId') locationId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.deliveries.list(this.scope(u, tenantId, locationId), {
      status,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Get('lead-delivery-routes')
  listRoutes(
    @CurrentUser() u: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const s = this.scope(u, tenantId, locationId);
    return this.routes.listMasked(s.tenantId, s.locationId);
  }

  @Roles(...STAFF)
  @Get('lead-deliveries/:id')
  get(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.deliveries.get(this.scope(u, tenantId), id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('lead-deliveries/:id/replay')
  replay(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.deliveries.replay(this.scope(u, tenantId), id, u.sub);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER')
  @Post('lead-deliveries/:id/reconcile')
  reconcile(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: ReconcileDto,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.deliveries.reconcile(this.scope(u, tenantId), id, b, u.sub);
  }

  /**
   * Mark a SENT delivery ACCEPTED after out-of-band verification that the durable Message-ID
   * was accepted by the relay. Never re-sends. Does not create a CRM match.
   */
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('lead-deliveries/:id/assert-accepted')
  assertAccepted(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() b: AssertAcceptedDto,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.deliveries.assertAccepted(
      this.scope(u, tenantId),
      id,
      b,
      u.sub,
    );
  }
}
