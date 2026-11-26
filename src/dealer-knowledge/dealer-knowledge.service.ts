import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEALER_DIRECTORY_AS_OF,
  DEALER_DIRECTORY_SOURCE,
  dealerDirectoryFor,
} from '../dealer-directory/dealer-directory';
import { StoreHoursService } from '../locations/store-hours.service';

export const KNOWLEDGE_KINDS = [
  'STAFF_MEMBER',
  'DEPARTMENT_MANAGER',
  'ESCALATION_CONTACT',
  'POLICY',
  'AGENT_INSTRUCTION',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
const DEPARTMENTS = ['SALES', 'SERVICE', 'PARTS'] as const;
type Dept = (typeof DEPARTMENTS)[number];

export type Actor = {
  userId: string;
  role: string;
  tenantId: string;
  locationId?: string | null;
};

export type HealthStatus =
  | 'OK'
  | 'MISSING'
  | 'STALE'
  | 'EXPIRED'
  | 'CONFLICT'
  | 'PENDING'
  | 'BLOCKED';
export type HealthItem = {
  item: string;
  department: Dept | null;
  status: HealthStatus;
  source: string | null;
  verifiedAt: string | null;
  detail: string;
  /** Where a manager fixes it in the Command Center. */
  fixAt: string;
};

const HOURS_MAX_AGE_DAYS = 180;
const DAY = 86_400_000;
/** US holidays a dealership commonly changes hours for, next twelve months from a date. */
export function upcomingHolidays(
  now: Date,
  withinDays: number,
): Array<{ date: string; name: string }> {
  const out: Array<{ date: string; name: string }> = [];
  const nth = (y: number, m: number, wd: number, n: number) => {
    const d = new Date(Date.UTC(y, m, 1));
    const shift = (wd - d.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(y, m, 1 + shift + (n - 1) * 7));
  };
  const last = (y: number, m: number, wd: number) => {
    const d = new Date(Date.UTC(y, m + 1, 0));
    return new Date(
      Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7)),
    );
  };
  for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const list: Array<[Date, string]> = [
      [new Date(Date.UTC(y, 0, 1)), "New Year's Day"],
      [last(y, 4, 1), 'Memorial Day'],
      [new Date(Date.UTC(y, 6, 4)), 'Independence Day'],
      [nth(y, 8, 1, 1), 'Labor Day'],
      [nth(y, 10, 4, 4), 'Thanksgiving'],
      [new Date(Date.UTC(y, 11, 24)), 'Christmas Eve'],
      [new Date(Date.UTC(y, 11, 25)), 'Christmas Day'],
      [new Date(Date.UTC(y, 11, 31)), "New Year's Eve"],
    ];
    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    for (const [d, name] of list)
      if (d.getTime() >= today && d.getTime() <= today + withinDays * DAY)
        out.push({ date: d.toISOString().slice(0, 10), name });
  }
  return out;
}

type Entry = Prisma.DealerKnowledgeEntryGetPayload<object>;

/** Is an approved entry usable right now (not expired, not past its review date)? */
export function entryState(
  e: Pick<Entry, 'status' | 'verifiedAt' | 'reviewByDays' | 'expiresAt'>,
  now = new Date(),
): 'ACTIVE' | 'STALE' | 'EXPIRED' | 'NOT_APPROVED' {
  if (e.status !== 'APPROVED') return 'NOT_APPROVED';
  if (e.expiresAt && e.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (now.getTime() - e.verifiedAt.getTime() > e.reviewByDays * DAY)
    return 'STALE';
  return 'ACTIVE';
}

const digits = (s: string | null | undefined) =>
  (s ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * The one dealership-knowledge layer read by both the Dial Concierge and CRM Workforce.
 *
 * It does not copy facts into a second database. Each kind keeps its existing home:
 *   identity, address, phones, website and handoff links → verified dealer directory
 *     (transcribed from dial-auto-group-platform/src/stores/config.ts, owner-approved)
 *   weekly, department and holiday hours → Location (Rooftop settings; verified there)
 *   offers and specials → Spotlight (approval + start/end dates)
 *   inventory → Vehicle (feed lifecycle + freshness)
 *   staff, managers, escalation contacts, policies, agent guidance → DealerKnowledgeEntry
 *     (new; source, verification date, approval and expiry on every row)
 *
 * `health()` reports, per store, what is missing, stale, expired, pending or conflicting, so a
 * gap is visible instead of silently guessed around.
 */
@Injectable()
export class DealerKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hours: StoreHoursService,
  ) {}

  private async store(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        timezone: true,
        holidayHours: true,
        departmentHours: true,
        escalationRecipients: true,
        inventoryFreshnessHours: true,
        inventoryFeedType: true,
        inventoryFeedUrl: true,
        tenant: { select: { slug: true, name: true } },
      },
    });
    if (!loc) throw new NotFoundException('location_not_found');
    return loc;
  }

  /** Approved, current entries a system may use (expired, stale or unapproved never). */
  async activeEntries(
    tenantId: string,
    locationId: string,
    kinds?: KnowledgeKind[],
    now = new Date(),
  ) {
    const rows = await this.prisma.dealerKnowledgeEntry.findMany({
      where: {
        tenantId,
        locationId,
        status: 'APPROVED',
        ...(kinds ? { kind: { in: kinds } } : {}),
      },
      orderBy: [{ kind: 'asc' }, { title: 'asc' }],
    });
    return rows.filter((r) => entryState(r, now) === 'ACTIVE');
  }

  async list(tenantId: string, locationId: string, now = new Date()) {
    const rows = await this.prisma.dealerKnowledgeEntry.findMany({
      where: { tenantId, locationId, status: { not: 'RETIRED' } },
      orderBy: [{ status: 'asc' }, { kind: 'asc' }, { updatedAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => ({ ...r, state: entryState(r, now) }));
  }

  private canManage(actor: Actor, locationId: string) {
    if (!['ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(actor.role))
      throw new ForbiddenException('knowledge_changes_require_manager');
    if (
      actor.role === 'MANAGER' &&
      actor.locationId &&
      actor.locationId !== locationId
    )
      throw new ForbiddenException('Location access denied');
  }

  private validate(
    kind: string,
    department: string | null,
    data: Record<string, unknown> | null,
  ) {
    if (!(KNOWLEDGE_KINDS as readonly string[]).includes(kind))
      throw new BadRequestException('unknown_kind');
    if (department && !(DEPARTMENTS as readonly string[]).includes(department))
      throw new BadRequestException('unknown_department');
    const d = data ?? {};
    if (
      ['STAFF_MEMBER', 'DEPARTMENT_MANAGER', 'ESCALATION_CONTACT'].includes(
        kind,
      )
    ) {
      if (typeof d.name !== 'string' || d.name.trim().length < 2)
        throw new BadRequestException('name_required');
      if (
        d.email !== undefined &&
        d.email !== null &&
        d.email !== '' &&
        !EMAIL.test(String(d.email))
      )
        throw new BadRequestException('invalid_email');
      if (d.phone && digits(String(d.phone)).length !== 10)
        throw new BadRequestException('invalid_phone');
      if (kind === 'ESCALATION_CONTACT' && !d.email && !d.phone)
        throw new BadRequestException(
          'escalation_contact_needs_email_or_phone',
        );
    }
  }

  async propose(
    actor: Actor,
    tenantId: string,
    p: {
      locationId: string;
      department?: string | null;
      kind: string;
      title: string;
      body: string;
      data?: Record<string, unknown> | null;
      source: string;
      expiresAt?: string | null;
      reviewByDays?: number;
      supersedesId?: string | null;
    },
  ) {
    this.canManage(actor, p.locationId);
    await this.store(tenantId, p.locationId);
    this.validate(p.kind, p.department ?? null, p.data ?? null);
    if (!p.source?.trim() || p.source.trim().length < 3)
      throw new BadRequestException('source_required');
    if (p.kind === 'AGENT_INSTRUCTION' && p.body.length > 600)
      throw new BadRequestException('agent_instruction_max_600_characters');
    const expiresAt = p.expiresAt ? new Date(p.expiresAt) : null;
    if (
      expiresAt &&
      (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
    )
      throw new BadRequestException('expiry_must_be_in_the_future');
    if (p.supersedesId) {
      const old = await this.prisma.dealerKnowledgeEntry.findFirst({
        where: { id: p.supersedesId, tenantId, locationId: p.locationId },
      });
      if (!old) throw new NotFoundException('superseded_entry_not_found');
    }
    const row = await this.prisma.dealerKnowledgeEntry.create({
      data: {
        tenantId,
        locationId: p.locationId,
        department: p.department ?? null,
        kind: p.kind,
        title: p.title.trim().slice(0, 160),
        body: p.body.trim().slice(0, 4000),
        data: (p.data ?? undefined) as Prisma.InputJsonValue | undefined,
        source: p.source.trim().slice(0, 300),
        expiresAt,
        reviewByDays: Math.min(Math.max(p.reviewByDays ?? 90, 7), 365),
        proposedById: actor.userId,
        supersedesId: p.supersedesId ?? null,
      },
    });
    await this.audit(tenantId, actor, 'knowledge.proposed', row.id, {
      kind: row.kind,
      department: row.department,
    });
    return row;
  }

  /**
   * Approve or reject a proposal. A manager cannot approve their own proposal; an administrator
   * may (recorded as self-approved). Approving an entry that supersedes another retires the old.
   */
  async review(
    actor: Actor,
    tenantId: string,
    id: string,
    approve: boolean,
    note?: string,
  ) {
    const row = await this.prisma.dealerKnowledgeEntry.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException('entry_not_found');
    this.canManage(actor, row.locationId);
    if (row.status !== 'PROPOSED')
      throw new BadRequestException('only_proposed_entries_can_be_reviewed');
    const self = row.proposedById === actor.userId;
    if (self && actor.role === 'MANAGER')
      throw new ForbiddenException(
        'a_manager_cannot_approve_their_own_proposal',
      );
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.dealerKnowledgeEntry.updateMany({
        where: { id, status: 'PROPOSED' },
        data: approve
          ? {
              status: 'APPROVED',
              approvedById: actor.userId,
              approvedAt: now,
              verifiedAt: now,
              reviewNote: note ?? null,
            }
          : {
              status: 'REJECTED',
              approvedById: actor.userId,
              approvedAt: now,
              reviewNote: note ?? null,
            },
      });
      if (!r.count) throw new BadRequestException('entry_changed_meanwhile');
      if (approve && row.supersedesId)
        await tx.dealerKnowledgeEntry.updateMany({
          where: { id: row.supersedesId, tenantId, status: 'APPROVED' },
          data: { status: 'RETIRED' },
        });
    });
    await this.audit(
      tenantId,
      actor,
      approve ? 'knowledge.approved' : 'knowledge.rejected',
      id,
      {
        kind: row.kind,
        selfApproved: approve && self,
      },
    );
    return { ok: true };
  }

  /** Re-confirm an approved entry is still true (resets its review clock). */
  async reverify(actor: Actor, tenantId: string, id: string) {
    const row = await this.prisma.dealerKnowledgeEntry.findFirst({
      where: { id, tenantId, status: 'APPROVED' },
    });
    if (!row) throw new NotFoundException('entry_not_found');
    this.canManage(actor, row.locationId);
    await this.prisma.dealerKnowledgeEntry.update({
      where: { id },
      data: { verifiedAt: new Date() },
    });
    await this.audit(tenantId, actor, 'knowledge.reverified', id, {
      kind: row.kind,
    });
    return { ok: true };
  }

  async retire(actor: Actor, tenantId: string, id: string) {
    const row = await this.prisma.dealerKnowledgeEntry.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException('entry_not_found');
    this.canManage(actor, row.locationId);
    await this.prisma.dealerKnowledgeEntry.update({
      where: { id },
      data: { status: 'RETIRED' },
    });
    await this.audit(tenantId, actor, 'knowledge.retired', id, {
      kind: row.kind,
    });
    return { ok: true };
  }

  /**
   * Make the approved escalation e-mails the Concierge's escalation recipients for this store.
   * Explicit administrator action: never overwritten silently.
   */
  async applyEscalationRecipients(
    actor: Actor,
    tenantId: string,
    locationId: string,
  ) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
      throw new ForbiddenException('administrator_required');
    const contacts = await this.activeEntries(tenantId, locationId, [
      'ESCALATION_CONTACT',
    ]);
    const emails = [
      ...new Set(
        contacts
          .map((c) =>
            String((c.data as { email?: string } | null)?.email ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter((e) => EMAIL.test(e)),
      ),
    ];
    if (!emails.length)
      throw new BadRequestException('no_approved_escalation_email');
    await this.prisma.location.update({
      where: { id: locationId },
      data: { escalationRecipients: emails.join(',') },
    });
    await this.audit(
      tenantId,
      actor,
      'knowledge.escalation_recipients_applied',
      locationId,
      { count: emails.length },
    );
    return { recipients: emails.length };
  }

  /** Missing, stale, expired, pending and conflicting knowledge for one store. */
  async health(
    tenantId: string,
    locationId: string,
    now = new Date(),
  ): Promise<{ store: string; items: HealthItem[] }> {
    const loc = await this.store(tenantId, locationId);
    const items: HealthItem[] = [];
    const add = (i: HealthItem) => items.push(i);
    const dir = dealerDirectoryFor(loc.tenant.slug)?.self ?? null;
    const dirSrc = `${DEALER_DIRECTORY_SOURCE} (owner-approved ${DEALER_DIRECTORY_AS_OF})`;

    // Identity, address, phones, links — verified dealer directory.
    if (!dir) {
      add({
        item: 'Dealership identity, address, phones and links',
        department: null,
        status: 'MISSING',
        source: null,
        verifiedAt: null,
        detail: 'This store is not in the verified dealer directory.',
        fixAt: 'Platform operator',
      });
    } else {
      add({
        item: 'Dealership identity and website',
        department: null,
        status: 'OK',
        source: dirSrc,
        verifiedAt: DEALER_DIRECTORY_AS_OF,
        detail: `${dir.name} · ${dir.links.home ?? 'no website link'}`,
        fixAt: '—',
      });
      const addrConflict =
        loc.address &&
        digits(loc.address.split(',')[0]) !== digits(dir.address.split(',')[0]);
      add({
        item: 'Address',
        department: null,
        status: addrConflict ? 'CONFLICT' : 'OK',
        source: dirSrc,
        verifiedAt: DEALER_DIRECTORY_AS_OF,
        detail: addrConflict
          ? `Store record says "${loc.address}", directory says "${dir.address}".`
          : dir.address,
        fixAt: addrConflict ? 'Rooftop settings' : '—',
      });
      for (const d of DEPARTMENTS) {
        const ph = dir.phones[d.toLowerCase() as 'sales' | 'service' | 'parts'];
        add({
          item: `${d[0] + d.slice(1).toLowerCase()} phone`,
          department: d,
          status: ph ? 'OK' : 'MISSING',
          source: dirSrc,
          verifiedAt: DEALER_DIRECTORY_AS_OF,
          detail: ph
            ? `${ph} (owner-approved; not live-tested)`
            : 'No approved number.',
          fixAt: 'Platform operator',
        });
      }
      if (loc.phone && digits(loc.phone) !== digits(dir.phones.sales))
        add({
          item: 'Main phone on store record',
          department: null,
          status: 'CONFLICT',
          source: 'Location.phone',
          verifiedAt: null,
          detail: `Store record ${loc.phone} differs from the approved sales line ${dir.phones.sales}.`,
          fixAt: 'Rooftop settings',
        });
      for (const [k, label] of [
        ['scheduleService', 'Service scheduling link'],
        ['parts', 'Parts link'],
        ['tradeValue', 'Trade-in link'],
        ['finance', 'Credit application link'],
        ['specials', 'Specials page'],
      ] as const)
        add({
          item: label,
          department:
            k === 'scheduleService'
              ? 'SERVICE'
              : k === 'parts'
                ? 'PARTS'
                : 'SALES',
          status: dir.links[k] ? 'OK' : 'MISSING',
          source: dirSrc,
          verifiedAt: DEALER_DIRECTORY_AS_OF,
          detail: dir.links[k] ?? 'No confirmed link.',
          fixAt: 'Platform operator',
        });
    }

    // Hours — Location, verified in Rooftop settings.
    const profile = await this.hours.getProfile(tenantId, locationId);
    if (!profile || !profile.weekly?.store) {
      add({
        item: 'Store hours',
        department: null,
        status: 'MISSING',
        source: null,
        verifiedAt: null,
        detail: 'No hours on file. Agents cannot state opening times.',
        fixAt: 'Rooftop settings → Hours',
      });
    } else if (!profile.verified || !profile.verifiedAt) {
      add({
        item: 'Store hours',
        department: null,
        status: 'PENDING',
        source: 'Rooftop settings',
        verifiedAt: null,
        detail: 'Hours entered but not verified.',
        fixAt: 'Rooftop settings → Verify hours',
      });
    } else {
      const old =
        now.getTime() - Date.parse(profile.verifiedAt) >
        HOURS_MAX_AGE_DAYS * DAY;
      add({
        item: 'Store hours',
        department: null,
        status: old ? 'STALE' : 'OK',
        source: 'Rooftop settings',
        verifiedAt: profile.verifiedAt,
        detail: old
          ? `Verified over ${HOURS_MAX_AGE_DAYS} days ago.`
          : 'Verified.',
        fixAt: old ? 'Rooftop settings → Verify hours' : '—',
      });
    }
    for (const d of DEPARTMENTS) {
      const has = !!(loc.departmentHours as Record<string, unknown> | null)?.[
        d.toLowerCase()
      ];
      add({
        item: `${d[0] + d.slice(1).toLowerCase()} hours`,
        department: d,
        status: has ? 'OK' : 'MISSING',
        source: has ? 'Rooftop settings' : null,
        verifiedAt: profile?.verifiedAt ?? null,
        detail: has
          ? 'On file.'
          : 'No department hours; the store hours are used if verified.',
        fixAt: 'Rooftop settings → Department hours',
      });
    }
    const holidays = Array.isArray(loc.holidayHours)
      ? (loc.holidayHours as Array<{ date?: string }>).map((h) => h.date)
      : [];
    for (const h of upcomingHolidays(now, 60))
      if (!holidays.includes(h.date))
        add({
          item: `Holiday hours — ${h.name} ${h.date}`,
          department: null,
          status: 'MISSING',
          source: null,
          verifiedAt: null,
          detail:
            'Not on file: agents will not say whether the store is open that day.',
          fixAt: 'Rooftop settings → Holiday hours',
        });

    // Offers — Spotlight.
    const offers = await this.prisma.spotlight.findMany({
      where: {
        tenantId,
        locationId,
        kind: 'OFFER',
        status: { in: ['APPROVED', 'PENDING_APPROVAL'] },
      },
      select: {
        title: true,
        status: true,
        endsAt: true,
        startsAt: true,
        source: true,
        approvedAt: true,
      },
    });
    const live = offers.filter(
      (o) => o.status === 'APPROVED' && o.startsAt <= now && o.endsAt > now,
    );
    const pending = offers.filter((o) => o.status === 'PENDING_APPROVAL');
    const expired = offers.filter(
      (o) => o.status === 'APPROVED' && o.endsAt <= now,
    );
    add({
      item: 'Approved offers and specials',
      department: 'SALES',
      status: live.length ? 'OK' : 'MISSING',
      source: live.length ? 'Spotlights (approved)' : null,
      verifiedAt: live[0]?.approvedAt?.toISOString() ?? null,
      detail: live.length
        ? `${live.length} live; ${live.filter((o) => o.endsAt.getTime() - now.getTime() < 7 * DAY).length} end within 7 days.`
        : 'No approved offer. Agents state no offer or incentive.',
      fixAt: 'Spotlights',
    });
    if (pending.length)
      add({
        item: 'Offers awaiting approval',
        department: 'SALES',
        status: 'PENDING',
        source: 'Spotlights',
        verifiedAt: null,
        detail: `${pending.length} waiting.`,
        fixAt: 'Spotlights',
      });
    if (expired.length)
      add({
        item: 'Expired offers',
        department: 'SALES',
        status: 'EXPIRED',
        source: 'Spotlights',
        verifiedAt: null,
        detail: `${expired.length} past their end date (not used).`,
        fixAt: 'Spotlights → archive',
      });
    add({
      item: 'Manufacturer incentives',
      department: 'SALES',
      status: 'MISSING',
      source: null,
      verifiedAt: null,
      detail:
        'No authorized OEM incentive source is connected. Enter approved programs as offers with their end date.',
      fixAt: 'Spotlights',
    });

    // Inventory — Vehicle.
    const [avail, newest] = await Promise.all([
      this.prisma.vehicle.count({
        where: {
          tenantId,
          locationId,
          status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
          NOT: { source: 'synthetic_demo' },
        },
      }),
      this.prisma.vehicle.findFirst({
        where: { tenantId, locationId, NOT: { source: 'synthetic_demo' } },
        orderBy: { lastSeenAt: 'desc' },
        select: { lastSeenAt: true, source: true },
      }),
    ]);
    if (!avail) {
      add({
        item: 'Vehicle inventory',
        department: 'SALES',
        status: 'BLOCKED',
        source: null,
        verifiedAt: null,
        detail:
          loc.inventoryFeedType || loc.inventoryFeedUrl
            ? 'Feed configured but no vehicles have arrived.'
            : 'No inventory feed is connected for this store (vAuto SFTP disabled; Dial feed host requires credentials). Agents state no availability or price.',
        fixAt: 'Platform operator — inventory feed',
      });
    } else {
      const age = newest?.lastSeenAt
        ? (now.getTime() - newest.lastSeenAt.getTime()) / 3_600_000
        : Infinity;
      add({
        item: 'Vehicle inventory',
        department: 'SALES',
        status: age > loc.inventoryFreshnessHours ? 'STALE' : 'OK',
        source: newest?.source ?? 'feed',
        verifiedAt: newest?.lastSeenAt?.toISOString() ?? null,
        detail: `${avail} available; last seen ${Number.isFinite(age) ? Math.round(age) : '?'} h ago (limit ${loc.inventoryFreshnessHours} h).`,
        fixAt: '—',
      });
    }

    // Entries — staff, managers, escalation, policies, guidance.
    const entries = await this.prisma.dealerKnowledgeEntry.findMany({
      where: { tenantId, locationId, status: { in: ['APPROVED', 'PROPOSED'] } },
    });
    const by = (kind: KnowledgeKind, dept: Dept | null) =>
      entries.filter(
        (e) =>
          e.kind === kind &&
          (dept === null || e.department === dept || e.department === null),
      );
    for (const d of DEPARTMENTS) {
      for (const [kind, label] of [
        ['DEPARTMENT_MANAGER', 'manager'],
        ['ESCALATION_CONTACT', 'escalation contact'],
      ] as const) {
        const rows = by(kind, d);
        const states = rows.map((r) => entryState(r, now));
        const status: HealthStatus = states.includes('ACTIVE')
          ? 'OK'
          : states.includes('STALE')
            ? 'STALE'
            : states.includes('EXPIRED')
              ? 'EXPIRED'
              : rows.some((r) => r.status === 'PROPOSED')
                ? 'PENDING'
                : 'MISSING';
        add({
          item: `${d[0] + d.slice(1).toLowerCase()} ${label}`,
          department: d,
          status,
          source: rows.find((r) => r.status === 'APPROVED')?.source ?? null,
          verifiedAt:
            rows
              .find((r) => r.status === 'APPROVED')
              ?.verifiedAt.toISOString() ?? null,
          detail:
            status === 'OK'
              ? `${states.filter((s) => s === 'ACTIVE').length} approved.`
              : status === 'MISSING'
                ? 'None on file. Escalations go to the store’s main line only.'
                : status.toLowerCase(),
          fixAt: 'CRM Workforce → Knowledge',
        });
      }
    }
    const staff = entries.filter(
      (e) => e.kind === 'STAFF_MEMBER' && entryState(e, now) === 'ACTIVE',
    ).length;
    add({
      item: 'Staff directory',
      department: null,
      status: staff ? 'OK' : 'MISSING',
      source: null,
      verifiedAt: null,
      detail: staff
        ? `${staff} approved.`
        : 'No salespeople or advisors on file.',
      fixAt: 'CRM Workforce → Knowledge',
    });
    const policies = entries.filter(
      (e) => e.kind === 'POLICY' && entryState(e, now) === 'ACTIVE',
    ).length;
    add({
      item: 'Customer policies',
      department: null,
      status: policies ? 'OK' : 'MISSING',
      source: null,
      verifiedAt: null,
      detail: policies
        ? `${policies} approved.`
        : 'No approved policy (privacy and terms on the group site are still drafts pending legal review).',
      fixAt: 'CRM Workforce → Knowledge',
    });
    const approvedEsc = by('ESCALATION_CONTACT', null).filter(
      (e) => entryState(e, now) === 'ACTIVE',
    );
    if (approvedEsc.length && !loc.escalationRecipients)
      add({
        item: 'Concierge escalation recipients',
        department: null,
        status: 'CONFLICT',
        source: 'Location.escalationRecipients',
        verifiedAt: null,
        detail:
          'Approved escalation contacts exist but the Concierge has no escalation recipients.',
        fixAt: 'CRM Workforce → Knowledge → Apply to Concierge',
      });
    for (const e of entries.filter(
      (x) => x.status === 'APPROVED' && entryState(x, now) !== 'ACTIVE',
    ))
      add({
        item: `${e.kind.replace(/_/g, ' ').toLowerCase()}: ${e.title}`,
        department: (e.department as Dept) ?? null,
        status: entryState(e, now) === 'EXPIRED' ? 'EXPIRED' : 'STALE',
        source: e.source,
        verifiedAt: e.verifiedAt.toISOString(),
        detail: 'Not given to agents until re-verified or replaced.',
        fixAt: 'CRM Workforce → Knowledge',
      });

    return { store: dir?.name ?? loc.tenant.name, items };
  }

  /** Health for every store a person may see (one tenant, or a group). */
  async groupHealth(tenantIds: string[], now = new Date()) {
    const locs = await this.prisma.location.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { id: true, tenantId: true },
    });
    const out = [] as Array<{
      tenantId: string;
      locationId: string;
      store: string;
      counts: Record<HealthStatus, number>;
    }>;
    for (const l of locs) {
      const h = await this.health(l.tenantId, l.id, now);
      const counts = {
        OK: 0,
        MISSING: 0,
        STALE: 0,
        EXPIRED: 0,
        CONFLICT: 0,
        PENDING: 0,
        BLOCKED: 0,
      } as Record<HealthStatus, number>;
      for (const i of h.items) counts[i.status]++;
      out.push({
        tenantId: l.tenantId,
        locationId: l.id,
        store: h.store,
        counts,
      });
    }
    return out;
  }

  private audit(
    tenantId: string,
    actor: Actor,
    action: string,
    resourceId: string,
    metadata: object,
  ) {
    return this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actor.userId,
        action,
        resource: 'DealerKnowledgeEntry',
        resourceId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
