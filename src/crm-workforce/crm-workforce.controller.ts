import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  assertStaffRole,
  CurrentUser,
  resolveLocationScope,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmWfActionService } from './action.service';
import { ExportImportError, parseCrmExport } from './adapters/export-import';
import { Actor, CrmWfControlService } from './control.service';
import { CRM_WORKFORCE_FLAG, DEPARTMENTS } from './crm-workforce.types';
import { CrmWfIntakeService } from './intake.service';
import { CrmWfLeadControlService } from './lead-control.service';
import { CrmWfQueueService } from './queue.service';
import { CrmWfReadService } from './read.service';
import { CrmWfSuppressionService } from './suppression.service';

const STAFF = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] as const;
const MANAGERS = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] as const;
const ADMINS = ['SUPER_ADMIN', 'ADMIN'] as const;
const SCOPES = [
  'GLOBAL',
  'TENANT',
  'LOCATION',
  'DEPARTMENT',
  'WORKFLOW',
  'SALESPERSON',
] as const;
const MODES = [
  'OBSERVE',
  'ASSIST',
  'SUPERVISED',
  'CONTROLLED_AUTONOMOUS',
] as const;

class SetControlDto {
  @IsIn(SCOPES) scope!: (typeof SCOPES)[number];
  @IsOptional() @IsString() @MaxLength(64) locationId?: string;
  @IsOptional() @IsIn(DEPARTMENTS as unknown as string[]) department?:
    | 'SALES'
    | 'SERVICE'
    | 'PARTS';
  @IsOptional() @IsString() @MaxLength(120) subjectKey?: string;
  @IsOptional() @IsBoolean() halted?: boolean;
  @IsOptional() @IsIn(MODES) mode?: (typeof MODES)[number];
  @IsOptional() @IsBoolean() externalSendEnabled?: boolean;
  @IsOptional() @IsObject() authorization?: Record<string, unknown>;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
class ProfileDto {
  @IsString() @MaxLength(64) locationId!: string;
  @IsIn(DEPARTMENTS as unknown as string[]) department!:
    | 'SALES'
    | 'SERVICE'
    | 'PARTS';
  @IsString() @MinLength(2) @MaxLength(40) displayName!: string;
  @IsString() @MinLength(3) @MaxLength(80) title!: string;
  @IsString() @MinLength(10) @MaxLength(200) disclosure!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ConnectorDto {
  @IsString() @MaxLength(64) locationId!: string;
  @IsString() @MaxLength(40) adapterKey!: string;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(200) authorizationRef?: string;
}
class ImportDto {
  @IsString() @MaxLength(64) locationId!: string;
  @IsString() @MinLength(1) @MaxLength(5_000_000) csv!: string;
  @IsISO8601() exportedAt!: string;
  @IsString() @MinLength(3) @MaxLength(200) authorizationRef!: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class ApproveDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(900) body?: string;
}
class NoteDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class SuppressDto {
  @IsString() @MaxLength(64) crmLeadId!: string;
  @IsIn(['CHANNEL', 'ALL']) scope!: 'CHANNEL' | 'ALL';
  @IsIn(['SMS', 'EMAIL']) channel!: 'SMS' | 'EMAIL';
  @IsIn([
    'DO_NOT_CONTACT',
    'WRONG_NUMBER',
    'COMPLAINT',
    'CUSTOMER_REQUEST',
    'MANUAL',
  ])
  reason!: string;
}
class ReplayDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}
class ReviewDto {
  @IsString() @MaxLength(64) actionId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) score!: number;
  @IsIn([
    'good',
    'too_long',
    'wrong_fact',
    'wrong_tone',
    'should_escalate',
    'compliance',
    'other',
  ])
  label!: string;
  @IsOptional() @IsString() @MaxLength(900) correctedBody?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

const maskContacts = (s: string) =>
  s
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]');

/**
 * AMQUR CRM Workforce — Command Center API (`/api/ops/crm-workforce/*`).
 * Staff JWT only; tenant from the token; STAFF/MANAGER bound to their rooftop. Reads work even
 * when the feature is off (they show the off state). Kill switches always work. Every other
 * mutation requires the `crmWorkforce` flag for that rooftop.
 */
@Controller('ops/crm-workforce')
@UseGuards(RolesGuard)
export class CrmWorkforceController {
  constructor(
    private readonly read: CrmWfReadService,
    private readonly controls: CrmWfControlService,
    private readonly actions: CrmWfActionService,
    private readonly leads: CrmWfLeadControlService,
    private readonly intake: CrmWfIntakeService,
    private readonly queue: CrmWfQueueService,
    private readonly suppression: CrmWfSuppressionService,
    private readonly flags: FeatureFlagsService,
    private readonly prisma: PrismaService,
  ) {}

  private scope(u: AuthUser, tenantId?: string, locationId?: string) {
    assertStaffRole(u);
    return {
      tenantId: resolveTenantId(u, tenantId),
      locationId: resolveLocationScope(u, locationId),
    };
  }
  private actor(u: AuthUser): Actor {
    return { userId: u.sub, role: u.role, tenantId: u.tenantId };
  }
  private async requireEnabled(tenantId: string, locationId?: string | null) {
    const f = await this.flags.resolve(tenantId, locationId ?? undefined);
    if (!f[CRM_WORKFORCE_FLAG])
      throw new ForbiddenException(
        'crm_workforce_not_enabled_for_this_rooftop',
      );
  }
  private since(days?: string) {
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);
    return new Date(Date.now() - n * 86_400_000);
  }

  // ── reads ────────────────────────────────────────────────────────────────
  @Roles(...STAFF)
  @Get('status')
  status(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.status(this.scope(u, t, l));
  }
  @Roles(...STAFF)
  @Get('overview')
  overview(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.overview(this.scope(u, t, l));
  }
  @Roles(...STAFF)
  @Get('tasks')
  tasks(
    @CurrentUser() u: AuthUser,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('department') department?: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.tasks(this.scope(u, t, l), {
      status: status ? status.split(',') : undefined,
      priority:
        priority !== undefined && priority !== ''
          ? Number(priority)
          : undefined,
      department,
    });
  }
  @Roles(...STAFF)
  @Get('actions')
  listActions(
    @CurrentUser() u: AuthUser,
    @Query('status') status?: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.actions(this.scope(u, t, l), {
      status: status ? status.split(',') : undefined,
    });
  }
  @Roles(...STAFF)
  @Get('leads/:id')
  async lead(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    const out = await this.read.lead(this.scope(u, t, l), id);
    if (!out) throw new NotFoundException('lead_not_found');
    return out;
  }
  @Roles(...STAFF)
  @Get('agents')
  agents(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.agents(this.scope(u, t, l));
  }
  @Roles(...MANAGERS)
  @Get('audit')
  audit(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.audit(this.scope(u, t, l));
  }
  @Roles(...MANAGERS)
  @Get('performance')
  performance(
    @CurrentUser() u: AuthUser,
    @Query('days') days?: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.performance(this.scope(u, t, l), this.since(days));
  }
  @Roles(...MANAGERS)
  @Get('costs')
  costs(
    @CurrentUser() u: AuthUser,
    @Query('days') days?: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.costs(this.scope(u, t, l), this.since(days));
  }
  @Roles(...MANAGERS)
  @Get('reviews')
  reviews(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.read.reviews(this.scope(u, t, l));
  }
  @Roles(...MANAGERS)
  @Get('suppressions')
  async suppressions(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
  ) {
    const rows = await this.suppression.list(this.scope(u, t).tenantId);
    // Endpoints are masked in the list; the full value never leaves the server here.
    return rows.map((r) => ({
      ...r,
      endpoint: r.endpoint.includes('@')
        ? r.endpoint.replace(/^(.).*(@.*)$/, '$1…$2')
        : `…${r.endpoint.slice(-4)}`,
    }));
  }

  /** Group overview: one row per rooftop the user may see. Counts only — no customer data. */
  @Roles(...STAFF)
  @Get('group')
  async group(@CurrentUser() u: AuthUser) {
    assertStaffRole(u);
    const own = await this.prisma.tenant.findUnique({
      where: { id: u.tenantId },
      select: { dealerGroupId: true },
    });
    const memberships = await this.prisma.dealerGroupMembership.findMany({
      where: { userId: u.sub },
      select: { dealerGroupId: true },
    });
    const groupIds = new Set(memberships.map((m) => m.dealerGroupId));
    if (u.role === 'SUPER_ADMIN' && own?.dealerGroupId)
      groupIds.add(own.dealerGroupId);
    const tenants = groupIds.size
      ? await this.prisma.tenant.findMany({
          where: { dealerGroupId: { in: [...groupIds] } },
          select: { id: true, name: true, slug: true },
        })
      : await this.prisma.tenant.findMany({
          where: { id: u.tenantId },
          select: { id: true, name: true, slug: true },
        });
    return Promise.all(
      tenants.map(async (t) => {
        const s = { tenantId: t.id, locationId: null };
        const [overview, status] = await Promise.all([
          this.read.overview(s),
          this.read.status(s),
        ]);
        const loc = status.controls.filter(
          (c) => c.scope === 'LOCATION' && c.tenantId === t.id,
        );
        return {
          tenantId: t.id,
          name: t.name,
          slug: t.slug,
          featureFlag: status.featureFlag,
          mode: loc[0]?.mode ?? 'OBSERVE',
          halted:
            status.globalHalted ||
            status.controls.some(
              (c) => c.halted && (c.scope === 'GLOBAL' || c.tenantId === t.id),
            ),
          externalSendEnabled: loc.some((c) => c.externalSendEnabled),
          dataLabel: overview.dataLabel,
          leads: overview.leads,
          tasks: overview.tasks,
          actions: overview.actions,
          connectors: status.connectors.flatMap((c) =>
            c.connections.map((x) => ({
              adapterKey: c.adapterKey,
              enabled: x.enabled,
              status: x.status,
            })),
          ),
        };
      }),
    );
  }

  // ── emergency + policy controls (always available) ───────────────────────
  @Roles(...STAFF)
  @Get('controls')
  listControls(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    const s = this.scope(u, t, l);
    return this.controls.list(s.tenantId, s.locationId);
  }
  @Roles(...STAFF)
  @Post('controls')
  setControl(
    @CurrentUser() u: AuthUser,
    @Body() dto: SetControlDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    return this.controls.set(this.actor(u), {
      ...dto,
      tenantId: s.tenantId,
      locationId: s.locationId ?? dto.locationId,
    });
  }

  // ── configuration ────────────────────────────────────────────────────────
  @Roles(...ADMINS)
  @Post('agents/profile')
  async profile(
    @CurrentUser() u: AuthUser,
    @Body() dto: ProfileDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    await this.requireEnabled(s.tenantId, dto.locationId);
    return this.leads.upsertProfile(this.actor(u), s.tenantId, dto);
  }
  @Roles(...ADMINS)
  @Post('connectors')
  async connector(
    @CurrentUser() u: AuthUser,
    @Body() dto: ConnectorDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    if (dto.enabled) await this.requireEnabled(s.tenantId, dto.locationId);
    return this.leads.setConnector(this.actor(u), s.tenantId, dto);
  }

  /** Permitted dealership export upload (read-only import into the mirror). */
  @Roles(...MANAGERS)
  @Post('import')
  async import(
    @CurrentUser() u: AuthUser,
    @Body() dto: ImportDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    await this.requireEnabled(s.tenantId, dto.locationId);
    const loc = await this.prisma.location.findFirst({
      where: { id: dto.locationId, tenantId: s.tenantId },
      select: { id: true },
    });
    if (!loc) throw new ForbiddenException('Location access denied');
    const connector = await this.prisma.crmWfConnector.findUnique({
      where: {
        tenantId_locationId_adapterKey: {
          tenantId: s.tenantId,
          locationId: dto.locationId,
          adapterKey: 'export_import',
        },
      },
    });
    if (!connector?.enabled || !connector.authorizedAt)
      throw new ForbiddenException(
        'export_import_connector_not_authorized_for_this_rooftop',
      );
    const exportedAt = new Date(dto.exportedAt);
    if (exportedAt.getTime() > Date.now() + 60_000)
      throw new BadRequestException('exportedAt_in_the_future');
    let parsed;
    try {
      parsed = parseCrmExport(dto.csv, { exportedAt });
    } catch (e) {
      if (e instanceof ExportImportError)
        throw new BadRequestException(e.message);
      throw e;
    }
    const summary = await this.intake.ingest(
      { tenantId: s.tenantId, locationId: dto.locationId },
      'export_import',
      parsed.records,
    );
    await this.prisma.auditLog.create({
      data: {
        tenantId: s.tenantId,
        userId: u.sub,
        action: 'crmwf.import.completed',
        resource: 'Location',
        resourceId: dto.locationId,
        metadata: {
          ...summary,
          rejectedRows: parsed.rejectedRows.length,
          ignoredColumns: parsed.ignoredColumns.length,
          authorizationRef: dto.authorizationRef,
          exportedAt: dto.exportedAt,
        },
      },
    });
    return {
      summary,
      rejectedRows: parsed.rejectedRows.slice(0, 50),
      ignoredColumns: parsed.ignoredColumns,
    };
  }

  // ── drafts and actions ───────────────────────────────────────────────────
  @Roles(...MANAGERS)
  @Post('actions/:id/approve')
  async approve(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ApproveDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t);
    await this.requireEnabled(s.tenantId, s.locationId);
    return this.actions.approve(this.actor(u), s, id, dto.body);
  }
  @Roles(...STAFF)
  @Post('actions/:id/reject')
  reject(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Query('tenantId') t?: string,
  ) {
    return this.actions.reject(this.actor(u), this.scope(u, t), id, dto.reason);
  }
  @Roles(...STAFF)
  @Post('actions/:id/staff-confirm')
  async staffConfirm(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: NoteDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t);
    await this.requireEnabled(s.tenantId, s.locationId);
    return this.actions.staffConfirm(this.actor(u), s, id, dto.note);
  }
  @Roles(...MANAGERS)
  @Post('actions/:id/reconcile')
  reconcile(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('retry') retry?: string,
    @Query('tenantId') t?: string,
  ) {
    return this.actions.reconcile(this.scope(u, t), id, {
      allowRetry: retry === 'true',
    });
  }

  // ── human coordination ───────────────────────────────────────────────────
  @Roles(...STAFF)
  @Post('leads/:id/takeover')
  takeover(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Query('tenantId') t?: string,
  ) {
    return this.leads.pause(this.actor(u), this.scope(u, t), id, dto.reason);
  }
  @Roles(...MANAGERS)
  @Post('leads/:id/resume')
  resume(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') t?: string,
  ) {
    return this.leads.resume(this.actor(u), this.scope(u, t), id);
  }

  // ── compliance ───────────────────────────────────────────────────────────
  @Roles(...STAFF)
  @Post('suppressions')
  suppress(
    @CurrentUser() u: AuthUser,
    @Body() dto: SuppressDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t);
    return this.suppression.suppressLead({
      tenantId: s.tenantId,
      crmLeadId: dto.crmLeadId,
      scope: dto.scope,
      channel: dto.channel,
      reason: dto.reason,
      source: 'STAFF',
      userId: u.sub,
    });
  }
  @Roles(...ADMINS)
  @Post('suppressions/:id/lift')
  async lift(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @Query('tenantId') t?: string,
  ) {
    const out = await this.suppression.lift(
      this.scope(u, t).tenantId,
      id,
      u.sub,
      dto.reason,
    );
    if (!out) throw new NotFoundException('suppression_not_found');
    if ('refused' in out) throw new ForbiddenException(out.refused);
    return out;
  }

  // ── queue operations ─────────────────────────────────────────────────────
  @Roles(...ADMINS)
  @Post('tasks/replay')
  replay(
    @CurrentUser() u: AuthUser,
    @Body() dto: ReplayDto,
    @Query('tenantId') t?: string,
  ) {
    return this.queue
      .replay(this.scope(u, t).tenantId, dto.ids.slice(0, 100))
      .then((replayed) => ({ replayed }));
  }

  // ── training ─────────────────────────────────────────────────────────────
  @Roles(...MANAGERS)
  @Post('reviews')
  async review(
    @CurrentUser() u: AuthUser,
    @Body() dto: ReviewDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t);
    const a = await this.prisma.crmWfAction.findFirst({
      where: {
        id: dto.actionId,
        tenantId: s.tenantId,
        ...(s.locationId ? { locationId: s.locationId } : {}),
      },
      select: { id: true, locationId: true },
    });
    if (!a) throw new NotFoundException('action_not_found');
    return this.prisma.crmWfReview.create({
      // Stored for evaluation, so contact details are masked on the way in.
      data: {
        tenantId: s.tenantId,
        locationId: a.locationId,
        actionId: a.id,
        score: dto.score,
        label: dto.label,
        correctedBody: dto.correctedBody
          ? maskContacts(dto.correctedBody)
          : null,
        note: dto.note ? maskContacts(dto.note) : null,
        reviewerUserId: u.sub,
      },
    });
  }
}
