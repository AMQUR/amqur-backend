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
  UploadedFile,
  UseInterceptors,
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
  ValidateNested,
} from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { Actor, CrmWfControlService } from './control.service';
import { CRM_WORKFORCE_FLAG, DEPARTMENTS } from './crm-workforce.types';
import { CrmWfAssistService } from './assist.service';
import { CrmWfDirectorService } from './director.service';
import { CrmWfFactsService } from './facts.service';
import { CrmWfImportService } from './import.service';
import { CrmWfMiningService } from './mining.service';
import { CrmWfWorkItemService } from './work-item.service';
import { CrmWfIntakeService } from './intake.service';
import { CrmWfLeadControlService } from './lead-control.service';
import { CrmWfPrivacyService } from './privacy.service';
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
class ImportPreviewDto {
  @IsString() @MaxLength(64) locationId!: string;
  @IsISO8601() exportedAt!: string;
  /** JSON object: field → column header. Optional; auto-detected otherwise. */
  @IsOptional() @IsString() @MaxLength(4000) mapping?: string;
}
class ImportCommitDto {
  @IsString() @MaxLength(64) locationId!: string;
}
class ImportRollbackDto {
  @IsString() @MaxLength(64) locationId!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class LegalApprovalDto {
  @IsString() @MinLength(2) @MaxLength(200) approvedBy!: string;
  @IsString() @MinLength(4) @MaxLength(40) approvedAt!: string;
  @IsString() @MinLength(2) @MaxLength(200) documentRef!: string;
}
class PolicyDto {
  @IsString() @MaxLength(64) tenantId!: string;
  @IsObject() policy!: Record<string, unknown>;
  @IsOptional()
  @ValidateNested()
  @Type(() => LegalApprovalDto)
  legalApproval?: LegalApprovalDto;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
class PrivacyDto {
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class AssistLeadDto {
  @IsString() @MaxLength(64) locationId!: string;
  @IsIn(DEPARTMENTS as unknown as string[]) department!:
    | 'SALES'
    | 'SERVICE'
    | 'PARTS';
  @IsOptional() @IsString() @MaxLength(80) crmRecordId?: string;
  @IsOptional() @IsString() @MaxLength(40) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) assignedTo?: string;
  @IsOptional() @IsString() @MaxLength(80) leadSource?: string;
  @IsOptional() @IsString() @MaxLength(40) vehicleMake?: string;
  @IsOptional() @IsString() @MaxLength(60) vehicleModel?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1980)
  @Max(2100)
  vehicleYear?: number;
  @IsOptional() @IsString() @MaxLength(2000) customerMessage?: string;
  @IsOptional() @IsIn(['SMS', 'EMAIL']) channel?: 'SMS' | 'EMAIL';
}
class AssistMessageDto {
  @IsIn(['INBOUND', 'OUTBOUND']) direction!: 'INBOUND' | 'OUTBOUND';
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
  @IsOptional() @IsIn(['SMS', 'EMAIL']) channel?: 'SMS' | 'EMAIL';
}
class AssistDraftDto {
  @IsOptional() @IsString() @MaxLength(300) staffNote?: string;
  @IsOptional() @IsIn(['SMS', 'EMAIL']) channel?: 'SMS' | 'EMAIL';
}
class AppointmentDto {
  @IsIn(['REQUEST', 'RESCHEDULE', 'CANCEL', 'CONFIRM']) change!:
    | 'REQUEST'
    | 'RESCHEDULE'
    | 'CANCEL'
    | 'CONFIRM';
  @IsOptional()
  @IsIn(['SALES_VISIT', 'TEST_DRIVE', 'SERVICE', 'PARTS_PICKUP'])
  type?: string;
  @IsOptional() @IsISO8601() requestedAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class FollowUpDto {
  @IsISO8601() dueAt!: string;
  @IsString() @MinLength(3) @MaxLength(500) instruction!: string;
}
class CrmNoteDto {
  @IsString() @MinLength(3) @MaxLength(1000) text!: string;
}
class ResolveDto {
  @IsIn(['DONE', 'DECLINED', 'CANCELLED']) outcome!:
    | 'DONE'
    | 'DECLINED'
    | 'CANCELLED';
  @IsOptional() @IsString() @MaxLength(120) crmReference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
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
    private readonly privacy: CrmWfPrivacyService,
    private readonly importer: CrmWfImportService,
    private readonly assist: CrmWfAssistService,
    private readonly items: CrmWfWorkItemService,
    private readonly mining: CrmWfMiningService,
    private readonly director: CrmWfDirectorService,
    private readonly factsSvc: CrmWfFactsService,
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
    // Only the masked hint is returned; the hash is not useful to a browser.
    return rows.map(({ endpointHash, hint, ...r }) => {
      void endpointHash;
      return { ...r, endpoint: hint };
    });
  }

  /**
   * Group overview: counts only — no customer data. A rooftop-bound user gets their own
   * rooftop and nothing else. Other dealerships appear only through an explicit dealer-group
   * membership (or for the platform operator), never by default.
   */
  @Roles(...MANAGERS)
  @Get('group')
  async group(@CurrentUser() u: AuthUser) {
    assertStaffRole(u);
    const bound = resolveLocationScope(u);
    const pick = { id: true, name: true, slug: true } as const;
    const ownOnly = () =>
      this.prisma.tenant.findMany({ where: { id: u.tenantId }, select: pick });
    let tenants: Array<{ id: string; name: string; slug: string }>;
    if (bound) tenants = await ownOnly();
    else {
      const memberships = await this.prisma.dealerGroupMembership.findMany({
        where: { userId: u.sub },
        select: { dealerGroupId: true },
      });
      const groupIds = new Set(memberships.map((m) => m.dealerGroupId));
      if (u.role === 'SUPER_ADMIN') {
        const own = await this.prisma.tenant.findUnique({
          where: { id: u.tenantId },
          select: { dealerGroupId: true },
        });
        if (own?.dealerGroupId) groupIds.add(own.dealerGroupId);
      }
      tenants = groupIds.size
        ? await this.prisma.tenant.findMany({
            where: { dealerGroupId: { in: [...groupIds] } },
            select: pick,
          })
        : [];
      if (!tenants.some((t) => t.id === u.tenantId))
        tenants.push(...(await ownOnly()));
    }
    return Promise.all(
      tenants.map(async (t) => {
        const s = {
          tenantId: t.id,
          locationId: t.id === u.tenantId ? bound : null,
        };
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
          externalSendEnabled: loc.some((c) => c.externalSendEnabled === true),
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

  /** Counsel-approved communication policy. Platform operator only; validated and audited. */
  @Roles('SUPER_ADMIN')
  @Post('policy')
  setPolicy(@CurrentUser() u: AuthUser, @Body() dto: PolicyDto) {
    assertStaffRole(u);
    return this.controls.setPolicy(
      this.actor(u),
      dto.tenantId,
      dto.policy,
      dto.legalApproval ?? null,
      dto.reason,
    );
  }
  @Roles(...MANAGERS)
  @Get('policy')
  getPolicy(@CurrentUser() u: AuthUser, @Query('tenantId') t?: string) {
    return this.controls.policyFor(this.scope(u, t).tenantId);
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

  // ── CRM export import: preview → commit → rollback ──────────────────────
  @Roles(...MANAGERS)
  @Get('imports')
  imports(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.importer.list(this.scope(u, t, l));
  }
  @Roles(...MANAGERS)
  @Get('imports/fields')
  importFields(@CurrentUser() u: AuthUser) {
    assertStaffRole(u);
    return this.importer.fields();
  }
  /** Parse and classify an export. Writes nothing but the batch record (hash, counts). */
  @Roles(...MANAGERS)
  @Post('imports/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_000_000 } }))
  importPreview(
    @CurrentUser() u: AuthUser,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() dto: ImportPreviewDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    if (!file?.buffer?.length) throw new BadRequestException('file_required');
    let mapping: Record<string, string> | undefined;
    if (dto.mapping) {
      try {
        const m = JSON.parse(dto.mapping) as unknown;
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error();
        mapping = Object.fromEntries(
          Object.entries(m as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        );
      } catch {
        throw new BadRequestException('mapping_must_be_a_json_object');
      }
    }
    return this.importer.preview(
      this.actor(u),
      { tenantId: s.tenantId, locationId: dto.locationId },
      {
        csv: file.buffer.toString('utf8'),
        fileName: file.originalname,
        exportedAt: dto.exportedAt,
        mapping,
      },
    );
  }
  /** Apply a previewed batch. The same file must be presented again (hash check). */
  @Roles(...MANAGERS)
  @Post('imports/:id/commit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_000_000 } }))
  importCommit(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() dto: ImportCommitDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    if (!file?.buffer?.length) throw new BadRequestException('file_required');
    return this.importer.commit(
      this.actor(u),
      { tenantId: s.tenantId, locationId: dto.locationId },
      id,
      file.buffer.toString('utf8'),
    );
  }
  @Roles(...MANAGERS)
  @Post('imports/:id/rollback')
  importRollback(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ImportRollbackDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    return this.importer.rollback(
      this.actor(u),
      { tenantId: s.tenantId, locationId: dto.locationId },
      id,
      dto.reason,
    );
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

  // ── employee-assisted workspace (Mode A) ─────────────────────────────────
  @Roles(...STAFF)
  @Post('assist/leads')
  assistLead(
    @CurrentUser() u: AuthUser,
    @Body() dto: AssistLeadDto,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, dto.locationId);
    return this.assist.createLead(
      this.actor(u),
      { tenantId: s.tenantId, locationId: dto.locationId },
      {
        crmRecordId: dto.crmRecordId,
        firstName: dto.firstName,
        department: dto.department,
        assignedTo: dto.assignedTo,
        leadSource: dto.leadSource,
        vehicle: {
          year: dto.vehicleYear,
          make: dto.vehicleMake,
          model: dto.vehicleModel,
        },
        customerMessage: dto.customerMessage,
        channel: dto.channel,
      },
    );
  }
  @Roles(...STAFF)
  @Post('leads/:id/messages')
  assistMessage(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssistMessageDto,
    @Query('tenantId') t?: string,
  ) {
    return this.assist.addMessage(this.actor(u), this.scope(u, t), id, dto);
  }
  /** Write a reply for the employee to send as themselves in the CRM. */
  @Roles(...STAFF)
  @Post('leads/:id/draft')
  assistDraft(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssistDraftDto,
    @Query('tenantId') t?: string,
  ) {
    return this.assist.draft(this.actor(u), this.scope(u, t), id, dto);
  }
  @Roles(...STAFF)
  @Get('leads/:id/recommendation')
  async recommendation(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t);
    const lead = await this.prisma.crmWfLead.findFirst({
      where: {
        id,
        tenantId: s.tenantId,
        ...(s.locationId ? { locationId: s.locationId } : {}),
      },
      select: { tenantId: true, locationId: true, assignedTo: true },
    });
    if (!lead) throw new NotFoundException('lead_not_found');
    return this.items.recommendAssignee(
      lead.tenantId,
      lead.locationId,
      lead.assignedTo,
    );
  }

  // ── appointments, follow-ups, notes: requests for staff, never CRM records ─
  @Roles(...STAFF)
  @Post('leads/:id/appointment')
  appointment(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: AppointmentDto,
    @Query('tenantId') t?: string,
  ) {
    return this.items.requestAppointment(
      `user:${u.sub}`,
      this.scope(u, t),
      id,
      dto,
    );
  }
  @Roles(...STAFF)
  @Post('leads/:id/follow-up')
  followUp(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: FollowUpDto,
    @Query('tenantId') t?: string,
  ) {
    return this.items.followUp(`user:${u.sub}`, this.scope(u, t), id, dto);
  }
  @Roles(...STAFF)
  @Post('leads/:id/crm-note')
  crmNote(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: CrmNoteDto,
    @Query('tenantId') t?: string,
  ) {
    return this.items.crmNote(`user:${u.sub}`, this.scope(u, t), id, dto.text);
  }
  @Roles(...STAFF)
  @Get('work-items')
  workItems(
    @CurrentUser() u: AuthUser,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('crmLeadId') crmLeadId?: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.items.list(this.scope(u, t, l), {
      kind: kind ? kind.split(',') : undefined,
      status: status ? status.split(',') : undefined,
      crmLeadId,
    });
  }
  @Roles(...STAFF)
  @Post('work-items/:id/claim')
  claimItem(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') t?: string,
  ) {
    return this.items.claim(this.actor(u), this.scope(u, t), id);
  }
  @Roles(...STAFF)
  @Post('work-items/:id/resolve')
  resolveItem(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResolveDto,
    @Query('tenantId') t?: string,
  ) {
    return this.items.resolve(this.actor(u), this.scope(u, t), id, dto);
  }

  // ── data mining, roster, director, reports ───────────────────────────────
  @Roles(...STAFF)
  @Get('mining')
  miningSummary(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.mining.summary(this.scope(u, t, l));
  }
  @Roles(...STAFF)
  @Get('mining/:queue')
  miningRows(
    @CurrentUser() u: AuthUser,
    @Param('queue') queue: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.mining.rows(this.scope(u, t, l), queue);
  }
  @Roles(...STAFF)
  @Get('roster')
  roster(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.director.roster(this.scope(u, t, l));
  }
  @Roles(...MANAGERS)
  @Get('director')
  directorFindings(
    @CurrentUser() u: AuthUser,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.director.findings(this.scope(u, t, l));
  }
  @Roles(...MANAGERS)
  @Get('reports/:kind')
  report(
    @CurrentUser() u: AuthUser,
    @Param('kind') kind: string,
    @Query('tenantId') t?: string,
    @Query('locationId') l?: string,
  ) {
    return this.director.report(this.scope(u, t, l), kind);
  }
  /** This rooftop's own department lines and staff — never another store's. */
  @Roles(...STAFF)
  @Get('directory')
  directory(
    @CurrentUser() u: AuthUser,
    @Query('locationId') l: string,
    @Query('tenantId') t?: string,
  ) {
    const s = this.scope(u, t, l);
    if (!s.locationId) throw new BadRequestException('locationId_required');
    return this.factsSvc.directory(s.tenantId, s.locationId);
  }

  // ── customer data rights ─────────────────────────────────────────────────
  @Roles(...ADMINS)
  @Get('privacy/retention')
  retention(@CurrentUser() u: AuthUser, @Query('tenantId') t?: string) {
    return this.privacy.retention(this.scope(u, t).tenantId);
  }
  /** Authorized copy of what the workforce holds about one customer. Audited. */
  @Roles(...ADMINS)
  @Post('privacy/export')
  privacyExport(
    @CurrentUser() u: AuthUser,
    @Body() dto: PrivacyDto,
    @Query('tenantId') t?: string,
  ) {
    return this.privacy.export(
      this.actor(u),
      this.scope(u, t).tenantId,
      dto,
      dto.reason,
    );
  }
  /** Erase one customer from the mirror. Suppressions are kept. Audited. */
  @Roles(...ADMINS)
  @Post('privacy/erase')
  privacyErase(
    @CurrentUser() u: AuthUser,
    @Body() dto: PrivacyDto,
    @Query('tenantId') t?: string,
  ) {
    return this.privacy.erase(
      this.actor(u),
      this.scope(u, t).tenantId,
      dto,
      dto.reason,
    );
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
