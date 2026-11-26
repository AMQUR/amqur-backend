import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ExportImportError,
  IMPORT_FIELDS,
  parseCrmExport,
} from './adapters/export-import';
import { Actor } from './control.service';
import { CRM_WORKFORCE_FLAG } from './crm-workforce.types';
import { CrmWfIntakeService, IMPORT_SNAPSHOT_KEYS } from './intake.service';
import { CrmWfPrivacyService } from './privacy.service';
import { auditSafe, fileIsSynthetic } from './vault.service';

export const REAL_IMPORTS_FLAG = 'crmWorkforceRealImports';
type Scope = { tenantId: string; locationId: string };
type Upload = {
  csv: string;
  fileName?: string;
  exportedAt: string;
  mapping?: Record<string, string>;
};

/**
 * Authorized CRM export ingestion: preview → commit → (optional) rollback.
 *
 *  - Nothing is written at preview: the file is parsed in memory, classified against the
 *    mirror, and only its hash, mapping, counts and a validation report are stored.
 *  - Commit must present the SAME file (hash match) and applies the mapping that was reviewed.
 *  - Every change a commit makes is recorded so the batch can be rolled back exactly.
 *  - A file containing real customer contacts is refused — at preview, before anything is
 *    stored — unless the rooftop has `crmWorkforceRealImports` on. Synthetic files (reserved
 *    555-01xx numbers, .invalid/.test/.example addresses) are always allowed for rehearsal.
 *  - The file itself is never stored.
 */
@Injectable()
export class CrmWfImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly intake: CrmWfIntakeService,
    private readonly privacy: CrmWfPrivacyService,
  ) {}

  fields() {
    return IMPORT_FIELDS;
  }

  private async gate(scope: Scope) {
    const loc = await this.prisma.location.findFirst({
      where: { id: scope.locationId, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!loc) throw new ForbiddenException('Location access denied');
    const flags = await this.flags.resolve(scope.tenantId, scope.locationId);
    if (!flags[CRM_WORKFORCE_FLAG])
      throw new ForbiddenException(
        'crm_workforce_not_enabled_for_this_rooftop',
      );
    const connector = await this.prisma.crmWfConnector.findUnique({
      where: {
        tenantId_locationId_adapterKey: {
          tenantId: scope.tenantId,
          locationId: scope.locationId,
          adapterKey: 'export_import',
        },
      },
    });
    if (!connector?.enabled || !connector.authorizedAt)
      throw new ForbiddenException(
        'export_import_connector_not_authorized_for_this_rooftop',
      );
    return { realAllowed: !!flags[REAL_IMPORTS_FLAG], connector };
  }

  private parse(u: Upload, mapping?: Record<string, string>) {
    const exportedAt = new Date(u.exportedAt);
    if (!Number.isFinite(exportedAt.getTime()))
      throw new BadRequestException('exportedAt_invalid');
    if (exportedAt.getTime() > Date.now() + 60_000)
      throw new BadRequestException('exportedAt_in_the_future');
    try {
      return {
        exportedAt,
        parsed: parseCrmExport(u.csv, {
          exportedAt,
          mapping: mapping ?? u.mapping,
        }),
      };
    } catch (e) {
      if (e instanceof ExportImportError)
        throw new BadRequestException(e.message);
      throw e;
    }
  }

  async preview(actor: Actor, scope: Scope, u: Upload) {
    const { realAllowed, connector } = await this.gate(scope);
    const { exportedAt, parsed } = this.parse(u);
    const synthetic = fileIsSynthetic(u.csv, parsed.records);
    if (!synthetic && !realAllowed)
      // Refused before anything about the file is stored.
      throw new ForbiddenException(
        'real_customer_data_import_not_authorized_for_this_rooftop',
      );
    const counts = await this.intake.ingest(
      scope,
      'export_import',
      parsed.records,
      new Date(),
      { dryRun: true },
    );
    const warnings: string[] = [];
    const missing = (f: string) => parsed.unmappedFields.includes(f);
    if (missing('doNotContact'))
      warnings.push(
        'No do-not-contact column: communication preference will be unknown for every row.',
      );
    if (missing('phone') && missing('email'))
      warnings.push(
        'No phone or email column: no row can be matched, de-duplicated or contacted.',
      );
    if (missing('lastInboundAt') && missing('lastOutboundAt'))
      warnings.push(
        'No last-contact columns: every lead will look never-contacted.',
      );
    if (missing('nextFollowUpAt'))
      warnings.push(
        'No follow-up date column: leads cannot be recognised as already scheduled.',
      );
    if (missing('assignedTo'))
      warnings.push('No salesperson column: ownership will be unknown.');
    const ageH = (Date.now() - exportedAt.getTime()) / 3_600_000;
    if (ageH > 24)
      warnings.push(
        `This export is ${Math.floor(ageH / 24)} day(s) old; the CRM may have changed since.`,
      );

    const batch = await this.prisma.crmWfImportBatch.create({
      data: {
        tenantId: scope.tenantId,
        locationId: scope.locationId,
        status: 'PREVIEWED',
        fileName: u.fileName?.slice(0, 200) ?? null,
        fileSha256: createHash('sha256').update(u.csv).digest('hex'),
        exportedAt,
        synthetic,
        mapping: parsed.mapping,
        counts: {
          rows: parsed.records.length + parsed.rejectedRows.length,
          rejected: parsed.rejectedRows.length,
          ...counts,
        },
        validation: {
          rejectedRows: parsed.rejectedRows.slice(0, 200),
          ignoredColumns: parsed.ignoredColumns,
          unmappedFields: parsed.unmappedFields,
          warnings,
        },
        authorizationRef: connector.authorizationRef,
        createdByUserId: actor.userId,
      },
    });
    return {
      batch,
      headers: parsed.headers,
      fields: IMPORT_FIELDS,
      // A few rows so the reviewer can check the mapping — operational fields only.
      sample: parsed.records.slice(0, 5).map((r) => ({
        crmRecordId: r.sourceRecordId,
        firstNameInitial: r.firstName ? `${r.firstName.slice(0, 1)}.` : null,
        hasPhone: !!r.phone,
        hasEmail: !!r.email,
        status: r.crmStatus ?? null,
        salesperson: r.assignedTo ?? null,
        vehicle: r.vehicleInterest
          ? [
              r.vehicleInterest.year,
              r.vehicleInterest.make,
              r.vehicleInterest.model,
            ]
              .filter(Boolean)
              .join(' ')
          : null,
        department: r.department,
        appointment: r.appointmentState ?? 'NONE',
        futureFollowUp: !!r.hasFutureFollowUp,
        doNotContact: r.doNotContact ?? null,
      })),
    };
  }

  async commit(actor: Actor, scope: Scope, batchId: string, csv: string) {
    const { realAllowed } = await this.gate(scope);
    const batch = await this.prisma.crmWfImportBatch.findFirst({
      where: {
        id: batchId,
        tenantId: scope.tenantId,
        locationId: scope.locationId,
      },
    });
    if (!batch) throw new NotFoundException('import_batch_not_found');
    if (batch.status !== 'PREVIEWED')
      throw new ConflictException(`batch_is_${batch.status.toLowerCase()}`);
    if (createHash('sha256').update(csv).digest('hex') !== batch.fileSha256)
      throw new BadRequestException('file_does_not_match_the_previewed_file');
    // Re-decided from the file itself at commit: the stored flag is not trusted on its own.
    if (
      !realAllowed &&
      !fileIsSynthetic(
        csv,
        this.parse(
          { csv, exportedAt: batch.exportedAt.toISOString() },
          batch.mapping as Record<string, string>,
        ).parsed.records,
      )
    )
      throw new ForbiddenException(
        'real_customer_data_import_not_authorized_for_this_rooftop',
      );
    if (!batch.synthetic && !realAllowed)
      throw new ForbiddenException(
        'real_customer_data_import_not_authorized_for_this_rooftop',
      );
    // Single winner: two commits of one batch cannot both proceed.
    const claimed = await this.prisma.crmWfImportBatch.updateMany({
      where: { id: batch.id, status: 'PREVIEWED' },
      data: { status: 'COMMITTING' },
    });
    if (claimed.count !== 1)
      throw new ConflictException('batch_already_being_committed');
    try {
      const { parsed } = this.parse(
        { csv, exportedAt: batch.exportedAt.toISOString() },
        batch.mapping as Record<string, string>,
      );
      const counts = await this.intake.ingest(
        scope,
        'export_import',
        parsed.records,
        new Date(),
        { importBatchId: batch.id },
      );
      const out = await this.prisma.crmWfImportBatch.update({
        where: { id: batch.id },
        data: {
          status: 'COMMITTED',
          committedAt: new Date(),
          counts: { ...(batch.counts as object), committed: counts },
        },
      });
      await this.prisma.crmWfConnector.updateMany({
        where: {
          tenantId: scope.tenantId,
          locationId: scope.locationId,
          adapterKey: 'export_import',
        },
        data: { lastSyncAt: new Date(), status: 'READY', lastError: null },
      });
      await this.audit(actor, scope, 'crmwf.import.committed', batch.id, {
        ...counts,
        synthetic: batch.synthetic,
        authorizationRef: batch.authorizationRef,
      });
      return out;
    } catch (e) {
      await this.prisma.crmWfImportBatch.updateMany({
        where: { id: batch.id, status: 'COMMITTING' },
        data: { status: 'PREVIEWED' },
      });
      throw e;
    }
  }

  /**
   * Undo a committed batch: rows it created are removed, rows it updated are restored to
   * their previous values, messages it added are removed, and open work is cancelled.
   * Only the most recent committed batch of a rooftop can be rolled back (older ones may
   * have been built on). A lead that has since been messaged is kept and reported —
   * a sent message cannot be unsent, and its record must stay.
   */
  async rollback(actor: Actor, scope: Scope, batchId: string, reason: string) {
    if (!['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(actor.role))
      throw new ForbiddenException('rollback_requires_manager');
    const batch = await this.prisma.crmWfImportBatch.findFirst({
      where: {
        id: batchId,
        tenantId: scope.tenantId,
        locationId: scope.locationId,
      },
    });
    if (!batch) throw new NotFoundException('import_batch_not_found');
    if (batch.status !== 'COMMITTED')
      throw new ConflictException(`batch_is_${batch.status.toLowerCase()}`);
    const newer = await this.prisma.crmWfImportBatch.count({
      where: {
        tenantId: scope.tenantId,
        locationId: scope.locationId,
        status: 'COMMITTED',
        committedAt: { gt: batch.committedAt! },
      },
    });
    if (newer)
      throw new ConflictException('a_newer_import_exists_roll_that_back_first');

    const changes = await this.prisma.crmWfImportChange.findMany({
      where: { batchId: batch.id, tenantId: scope.tenantId },
    });
    const contacted = new Set(
      (
        await this.prisma.crmWfAction.findMany({
          where: {
            tenantId: scope.tenantId,
            crmLeadId: { in: changes.map((c) => c.crmLeadId) },
            status: {
              in: [
                'VERIFIED',
                'STAFF_CONFIRMED',
                'SENT_UNVERIFIED',
                'UNCERTAIN',
                'EXECUTING',
              ],
            },
            updatedAt: { gte: batch.committedAt! },
          },
          select: { crmLeadId: true },
        })
      ).map((a) => a.crmLeadId),
    );
    const created = changes
      .filter((c) => c.kind === 'CREATED' && !contacted.has(c.crmLeadId))
      .map((c) => c.crmLeadId);
    const updated = changes.filter(
      (c) => c.kind === 'UPDATED' && !contacted.has(c.crmLeadId),
    );
    const removed = await this.privacy.eraseLeads(scope.tenantId, created);
    let restored = 0;
    for (const c of updated) {
      const before = (c.before ?? {}) as Record<string, unknown>;
      const data: Record<string, unknown> = {};
      for (const k of IMPORT_SNAPSHOT_KEYS) {
        if (!(k in before)) continue;
        const v = before[k];
        data[k] =
          /At$|^asOf$|Until$/.test(k) && typeof v === 'string'
            ? new Date(v)
            : k === 'vehicleInterest' && v === null
              ? Prisma.JsonNull
              : v;
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.crmWfMessage.deleteMany({
          where: {
            tenantId: scope.tenantId,
            crmLeadId: c.crmLeadId,
            importBatchId: batch.id,
          },
        });
        await tx.crmWfTask.updateMany({
          where: {
            tenantId: scope.tenantId,
            crmLeadId: c.crmLeadId,
            status: { in: ['PENDING', 'CLAIMED', 'AWAITING_APPROVAL'] },
          },
          data: {
            status: 'CANCELLED',
            statusReason: 'import_rolled_back',
            leaseExpiresAt: null,
          },
        });
        await tx.crmWfAction.updateMany({
          where: {
            tenantId: scope.tenantId,
            crmLeadId: c.crmLeadId,
            status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED'] },
          },
          data: { status: 'CANCELLED', statusReason: 'import_rolled_back' },
        });
        await tx.crmWfLead.updateMany({
          where: { id: c.crmLeadId, tenantId: scope.tenantId },
          data: data as Prisma.CrmWfLeadUncheckedUpdateManyInput,
        });
      });
      restored += 1;
    }
    const result = {
      removed: removed.leads,
      restored,
      keptBecauseContacted: contacted.size,
    };
    const out = await this.prisma.crmWfImportBatch.update({
      where: { id: batch.id },
      data: {
        status: 'ROLLED_BACK',
        rolledBackAt: new Date(),
        rolledBackByUserId: actor.userId,
        counts: { ...(batch.counts as object), rollback: result },
      },
    });
    await this.audit(actor, scope, 'crmwf.import.rolled_back', batch.id, {
      ...result,
      reason,
    });
    return { batch: out, ...result };
  }

  list(scope: { tenantId: string; locationId: string | null }) {
    return this.prisma.crmWfImportBatch.findMany({
      where: {
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private audit(
    actor: Actor,
    scope: Scope,
    action: string,
    batchId: string,
    metadata: object,
  ) {
    return this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId: actor.userId,
        action,
        resource: 'CrmWfImportBatch',
        resourceId: batchId,
        metadata: auditSafe({ locationId: scope.locationId, ...metadata }),
      },
    });
  }
}
