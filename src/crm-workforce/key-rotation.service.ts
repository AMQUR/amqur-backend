import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from './control.service';
import { CrmWfVaultService } from './vault.service';

const LEAD_FIELDS = ['lastNameEnc', 'phoneEnc', 'emailEnc'] as const;
type LeadField = (typeof LEAD_FIELDS)[number];

export type KeyStatus = {
  currentKeyId: string;
  hashKeyPinned: boolean;
  previousKeysConfigured: number;
  /** Sealed values by key id ('v1' = written before key ids were recorded). */
  leads: Record<string, number>;
  messages: Record<string, number>;
  needsReseal: number;
};

/**
 * Re-seals CRM Workforce customer data under the current data key after a key change.
 *
 * Procedure (platform operator):
 *   1. Pin CRM_WORKFORCE_HASH_KEY to the key the lookup hashes were made with (usually the
 *      present CRM_WORKFORCE_DATA_KEY, or INTEGRATION_ENCRYPTION_KEY when no dedicated key was
 *      ever set). Hashes never change; suppressions of erased customers stay effective.
 *   2. Set the new CRM_WORKFORCE_DATA_KEY and put the old one in CRM_WORKFORCE_DATA_KEY_PREVIOUS,
 *      on both API and worker. New writes use the new key; old values still open.
 *   3. Run the re-seal (`POST /api/ops/crm-workforce/privacy/rotate-keys`) until `needsReseal`
 *      is 0. Each value is decrypted and re-encrypted in memory and written only if it has not
 *      changed meanwhile; plaintext is never logged or returned.
 *   4. Remove the old key from CRM_WORKFORCE_DATA_KEY_PREVIOUS.
 *
 * Platform-wide, so platform operator (SUPER_ADMIN) only. Counts carry no customer data.
 */
@Injectable()
export class CrmWfKeyRotationService {
  private readonly log = new Logger('CrmWfKeyRotation');
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CrmWfVaultService,
  ) {}

  private operator(actor: Actor) {
    if (actor.role !== 'SUPER_ADMIN' || actor.groupActing)
      throw new ForbiddenException('key_rotation_requires_platform_operator');
  }

  async status(actor: Actor): Promise<KeyStatus> {
    this.operator(actor);
    const current = this.vault.currentKeyId();
    const leads: Record<string, number> = {};
    const messages: Record<string, number> = {};
    let needsReseal = 0;
    const tally = (into: Record<string, number>, v: string | null) => {
      const k = this.vault.keyIdOf(v);
      if (!k) return;
      into[k] = (into[k] ?? 0) + 1;
      if (k !== current) needsReseal++;
    };
    for await (const rows of this.pages('lead'))
      for (const r of rows as Array<Record<LeadField, string | null>>)
        for (const f of LEAD_FIELDS) tally(leads, r[f]);
    for await (const rows of this.pages('message'))
      for (const r of rows as Array<{ bodyEnc: string }>)
        tally(messages, r.bodyEnc);
    const prev = (process.env.CRM_WORKFORCE_DATA_KEY_PREVIOUS ?? '')
      .split(',')
      .filter((k) => k.trim().length >= 32).length;
    return {
      currentKeyId: current,
      hashKeyPinned: !!process.env.CRM_WORKFORCE_HASH_KEY,
      previousKeysConfigured: prev,
      leads,
      messages,
      needsReseal,
    };
  }

  /**
   * Re-seal up to `limit` values not sealed with the current key. Refuses unless the hash key
   * is pinned or no key has changed, so a rotation cannot silently invalidate lookup hashes.
   */
  async reseal(actor: Actor, limit = 2000, dryRun = false) {
    this.operator(actor);
    const current = this.vault.currentKeyId();
    if (
      !process.env.CRM_WORKFORCE_HASH_KEY &&
      process.env.CRM_WORKFORCE_DATA_KEY_PREVIOUS
    )
      throw new ForbiddenException(
        'pin_CRM_WORKFORCE_HASH_KEY_before_rotating_the_data_key',
      );
    let resealed = 0;
    let skipped = 0;
    for await (const rows of this.pages('lead')) {
      for (const r of rows as Array<
        { id: string } & Record<LeadField, string | null>
      >) {
        const stale = LEAD_FIELDS.filter(
          (f) => r[f] && this.vault.keyIdOf(r[f]) !== current,
        );
        if (!stale.length) continue;
        if (resealed >= limit) break;
        if (dryRun) {
          resealed += stale.length;
          continue;
        }
        const data: Partial<Record<LeadField, string | null>> = {};
        for (const f of stale) data[f] = this.vault.seal(this.vault.open(r[f]));
        // Written only if no field changed since it was read (no lost update).
        const res = await this.prisma.crmWfLead.updateMany({
          where: {
            id: r.id,
            ...Object.fromEntries(stale.map((f) => [f, r[f]])),
          },
          data,
        });
        if (res.count) resealed += stale.length;
        else skipped++;
      }
      if (resealed >= limit) break;
    }
    for await (const rows of this.pages('message')) {
      if (resealed >= limit) break;
      for (const r of rows as Array<{ id: string; bodyEnc: string }>) {
        if (!r.bodyEnc || this.vault.keyIdOf(r.bodyEnc) === current) continue;
        if (resealed >= limit) break;
        if (dryRun) {
          resealed++;
          continue;
        }
        const res = await this.prisma.crmWfMessage.updateMany({
          where: { id: r.id, bodyEnc: r.bodyEnc },
          data: { bodyEnc: this.vault.seal(this.vault.open(r.bodyEnc)) ?? '' },
        });
        if (res.count) resealed++;
        else skipped++;
      }
    }
    if (!dryRun && resealed)
      await this.prisma.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'crmwf.keys.resealed',
          resource: 'CrmWfVault',
          resourceId: current,
          metadata: { resealed, skipped, currentKeyId: current },
        },
      });
    this.log.log(
      `reseal ${dryRun ? '(dry run) ' : ''}values=${resealed} skipped=${skipped} key=${current}`,
    );
    const after = dryRun ? null : await this.status(actor);
    return {
      dryRun,
      resealed,
      skippedChangedMeanwhile: skipped,
      currentKeyId: current,
      remaining: after?.needsReseal ?? null,
    };
  }

  private async *pages(kind: 'lead' | 'message', size = 500) {
    let cursor: string | undefined;
    for (;;) {
      const rows =
        kind === 'lead'
          ? await this.prisma.crmWfLead.findMany({
              select: {
                id: true,
                lastNameEnc: true,
                phoneEnc: true,
                emailEnc: true,
              },
              orderBy: { id: 'asc' },
              take: size,
              ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            })
          : await this.prisma.crmWfMessage.findMany({
              select: { id: true, bodyEnc: true },
              orderBy: { id: 'asc' },
              take: size,
              ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
      if (!rows.length) return;
      yield rows;
      cursor = rows[rows.length - 1].id;
      if (rows.length < size) return;
    }
  }
}
