import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  CrmWfDirectorService,
  REPORT_KINDS,
  type ReportKind,
} from './director.service';
import { CRM_WORKFORCE_FLAG } from './crm-workforce.types';

/**
 * Scheduled internal management reports and critical alerts for CRM Workforce.
 *
 * OFF until approval R14 names the recipients, channel and schedule:
 *   CRM_WORKFORCE_REPORTS_ENABLED=true
 *   CRM_WORKFORCE_REPORT_CHANNEL=webhook|email
 *   CRM_WORKFORCE_REPORT_WEBHOOK_URL=…            (webhook; an internal chat incoming webhook)
 *   CRM_WORKFORCE_REPORT_RECIPIENTS=a@x,b@y        (email; internal staff only)
 *   CRM_WORKFORCE_REPORT_FROM=reports@<verified sending domain>   (email; uses RESEND_API_KEY)
 *   CRM_WORKFORCE_REPORT_SCHEDULE=morning@07:30,midday@12:30,end_of_day@18:30,weekly@mon-08:00
 * Times are America/Chicago. No new provider: email reuses the existing Resend account, webhook
 * reuses the same pattern as OPS_ALERT_WEBHOOK_URL.
 *
 * Each report is sent at most once per kind, store and local day (recorded as an audit row
 * inside a transaction-scoped advisory lock), so API and worker processes, restarts and retries
 * never duplicate it. Reports contain counts only — no customer names, phones or messages.
 */
export type ReportSchedule = Array<{
  kind: ReportKind;
  weekday: number | null;
  minute: number;
}>;
const TZ = 'America/Chicago';
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseSchedule(raw: string | undefined): ReportSchedule {
  const def = 'morning@07:30,midday@12:30,end_of_day@18:30,weekly@mon-08:00';
  const out: ReportSchedule = [];
  for (const part of (raw?.trim() || def).split(',')) {
    const m = /^([a-z_]+)@(?:([a-z]{3})-)?(\d{2}):(\d{2})$/.exec(
      part.trim().toLowerCase(),
    );
    if (!m || !(REPORT_KINDS as readonly string[]).includes(m[1])) continue;
    const h = Number(m[3]);
    const min = Number(m[4]);
    if (h > 23 || min > 59) continue;
    const weekday = m[2] ? WD.indexOf(m[2]) : null;
    if (weekday !== null && weekday < 0) continue;
    out.push({ kind: m[1] as ReportKind, weekday, minute: h * 60 + min });
  }
  return out;
}

export function localNow(now: Date): {
  date: string;
  weekday: number;
  minute: number;
} {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WD.indexOf(p.weekday.toLowerCase()),
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Kinds due now: inside a 60-minute window after their time, on the right weekday. */
export function dueKinds(s: ReportSchedule, now: Date): ReportKind[] {
  const l = localNow(now);
  return s
    .filter((x) =>
      x.weekday === null ? x.kind !== 'weekly' : x.weekday === l.weekday,
    )
    .filter((x) => l.minute >= x.minute && l.minute < x.minute + 60)
    .map((x) => x.kind);
}

type Report = Awaited<ReturnType<CrmWfDirectorService['report']>>;

/** Plain-text report. Unknown model cost is shown as unknown, never as $0. */
export function renderReport(store: string, r: Report): string {
  const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;
  const pricesKnown =
    !!process.env.LLM_COST_INPUT_PER_MTOK &&
    !!process.env.LLM_COST_OUTPUT_PER_MTOK;
  const cost =
    r.cost.modelCalls === 0
      ? '$0.00 (no model calls)'
      : pricesKnown || r.cost.modelCostMicroUsd > 0
        ? usd(r.cost.modelCostMicroUsd)
        : 'unknown (model prices not configured)';
  const lines = [
    `${store} — ${r.kind.replace('_', ' ')} report (last ${r.periodHours} h)`,
    `Customer replies: ${r.customers.repliesReceived} · New leads: ${r.customers.newLeads} · Waiting on a reply: ${r.customers.waitingOnReply} · Appointments next 24 h: ${r.customers.appointmentsNext24h}`,
    `Drafts waiting: ${r.messages.draftsWaiting} · Sent by employees: ${r.messages.sentByEmployees} · Confirmed in CRM: ${r.messages.sentConfirmedInCrm} · Unknown result: ${r.messages.unknownResult} · Blocked: ${r.messages.blocked}`,
    `Open staff items: ${r.staffWorkItems.filter((i) => ['OPEN', 'IN_PROGRESS'].includes(i.status)).reduce((a, i) => a + i.count, 0)} · Opt-outs recorded: ${r.compliance.optOutsRecorded}`,
    `Model calls: ${r.cost.modelCalls} · Model cost: ${cost}`,
    ...(r.needsAttention as Array<{ severity: string; finding: string }>)
      .slice(0, 5)
      .map((f) => `! ${f.severity}: ${f.finding}`),
    r.note,
  ];
  return lines.join('\n');
}

export type DeliveryConfig =
  | { enabled: false; reason: string }
  | { enabled: true; channel: 'webhook'; url: string; schedule: ReportSchedule }
  | {
      enabled: true;
      channel: 'email';
      to: string[];
      from: string;
      schedule: ReportSchedule;
    };

export function deliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryConfig {
  if (env.CRM_WORKFORCE_REPORTS_ENABLED !== 'true')
    return {
      enabled: false,
      reason:
        'CRM_WORKFORCE_REPORTS_ENABLED is not true (awaiting approval R14)',
    };
  const schedule = parseSchedule(env.CRM_WORKFORCE_REPORT_SCHEDULE);
  if (env.CRM_WORKFORCE_REPORT_CHANNEL === 'webhook') {
    const url = (env.CRM_WORKFORCE_REPORT_WEBHOOK_URL ?? '').trim();
    if (!/^https:\/\//.test(url))
      return {
        enabled: false,
        reason: 'CRM_WORKFORCE_REPORT_WEBHOOK_URL must be an https URL',
      };
    return { enabled: true, channel: 'webhook', url, schedule };
  }
  if (env.CRM_WORKFORCE_REPORT_CHANNEL === 'email') {
    const to = (env.CRM_WORKFORCE_REPORT_RECIPIENTS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x));
    const from = (env.CRM_WORKFORCE_REPORT_FROM ?? '').trim();
    if (!to.length || !from || !env.RESEND_API_KEY)
      return {
        enabled: false,
        reason:
          'email needs CRM_WORKFORCE_REPORT_RECIPIENTS, CRM_WORKFORCE_REPORT_FROM and RESEND_API_KEY',
      };
    return { enabled: true, channel: 'email', to, from, schedule };
  }
  return {
    enabled: false,
    reason: 'CRM_WORKFORCE_REPORT_CHANNEL must be webhook or email',
  };
}

@Injectable()
export class CrmWfReportSchedulerService {
  private readonly log = new Logger('CrmWfReports');
  constructor(
    private readonly prisma: PrismaService,
    private readonly director: CrmWfDirectorService,
  ) {}

  status() {
    const c = deliveryConfig();
    return c.enabled
      ? {
          enabled: true,
          channel: c.channel,
          recipients: c.channel === 'email' ? c.to.length : 1,
          schedule: c.schedule,
        }
      : {
          enabled: false,
          reason: c.reason,
          schedule: parseSchedule(process.env.CRM_WORKFORCE_REPORT_SCHEDULE),
        };
  }

  /** Stores the workforce is switched on for (one location each). */
  private async stores() {
    const tenants = await this.prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        featureFlags: true,
        locations: { select: { id: true } },
      },
    });
    return tenants
      .filter(
        (t) =>
          (t.featureFlags as Record<string, unknown> | null)?.[
            CRM_WORKFORCE_FLAG
          ] === true,
      )
      .flatMap((t) =>
        t.locations.map((l) => ({
          tenantId: t.id,
          locationId: l.id,
          name: t.name,
        })),
      );
  }

  async preview(
    tenantId: string,
    locationId: string,
    kind: ReportKind,
    now = new Date(),
  ) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return {
      text: renderReport(
        t?.name ?? 'Store',
        await this.director.report({ tenantId, locationId }, kind, now),
      ),
      delivery: this.status(),
    };
  }

  /** One scheduler tick. Safe to call from every process: each send is claimed exactly once. */
  async tick(
    now = new Date(),
    send: (
      cfg: Extract<DeliveryConfig, { enabled: true }>,
      subject: string,
      text: string,
    ) => Promise<void> = this.deliver.bind(this),
  ) {
    const cfg = deliveryConfig();
    if (!cfg.enabled) return { sent: 0, reason: cfg.reason };
    const due = dueKinds(cfg.schedule, now);
    if (!due.length) return { sent: 0 };
    const day = localNow(now).date;
    let sent = 0;
    for (const s of await this.stores()) {
      for (const kind of due) {
        const key = `${kind}:${day}:${s.locationId}`;
        const claimed = await this.claim(s.tenantId, key);
        if (!claimed) continue;
        try {
          const text = renderReport(
            s.name,
            await this.director.report(
              { tenantId: s.tenantId, locationId: s.locationId },
              kind,
              now,
            ),
          );
          await send(
            cfg,
            `${s.name} — ${kind.replace('_', ' ')} report ${day}`,
            text,
          );
          sent++;
        } catch (e) {
          this.log.warn(
            `report ${kind} failed for one store: ${(e as Error).message.slice(0, 120)}`,
          );
          await this.prisma.auditLog.updateMany({
            where: { id: claimed },
            data: { action: 'crmwf.report.failed' },
          });
        }
      }
    }
    return { sent };
  }

  /**
   * Critical operational alerts, at most one per condition per hour: emergency stop on, the
   * workforce engine enabled but no worker heartbeat for 10 minutes, or repeated failed actions.
   */
  async alerts(
    now = new Date(),
    send: (
      cfg: Extract<DeliveryConfig, { enabled: true }>,
      subject: string,
      text: string,
    ) => Promise<void> = this.deliver.bind(this),
  ) {
    const cfg = deliveryConfig();
    if (!cfg.enabled) return { sent: 0 };
    const found: Array<{ code: string; text: string }> = [];
    if (process.env.CRM_WORKFORCE_EMERGENCY_STOP === 'true')
      found.push({
        code: 'emergency_stop',
        text: 'CRM Workforce emergency stop is ON for the whole deployment.',
      });
    if (process.env.CRM_WORKFORCE_ENABLED === 'true') {
      const beat = await this.prisma.crmWfHeartbeat.findFirst({
        where: { state: 'RUNNING' },
        orderBy: { lastBeatAt: 'desc' },
        select: { lastBeatAt: true },
      });
      if (!beat || now.getTime() - beat.lastBeatAt.getTime() > 10 * 60_000)
        found.push({
          code: 'worker_silent',
          text: 'No CRM Workforce worker has reported in for 10 minutes; queued work is not being processed.',
        });
    }
    const failed = await this.prisma.crmWfAction.count({
      where: {
        status: 'FAILED',
        updatedAt: { gte: new Date(now.getTime() - 3_600_000) },
      },
    });
    if (failed >= 5)
      found.push({
        code: 'actions_failing',
        text: `${failed} CRM Workforce actions failed in the last hour.`,
      });
    const hour = now.toISOString().slice(0, 13);
    let sent = 0;
    for (const a of found) {
      const id = await this.claim(null, `alert:${a.code}:${hour}`);
      if (!id) continue;
      try {
        await send(
          cfg,
          `CRM Workforce alert — ${a.code.replace('_', ' ')}`,
          a.text,
        );
        sent++;
      } catch {
        await this.prisma.auditLog.updateMany({
          where: { id },
          data: { action: 'crmwf.report.failed' },
        });
      }
    }
    return { sent };
  }

  /** Claim a report slot; null if it was already claimed (sent or in flight). */
  private async claim(
    tenantId: string | null,
    key: string,
  ): Promise<string | null> {
    const lock = BigInt.asIntN(
      64,
      BigInt(
        '0x' +
          createHash('sha256')
            .update(`crmwf-report:${key}`)
            .digest('hex')
            .slice(0, 16),
      ),
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lock})`;
      const exists = await tx.auditLog.findFirst({
        where: { action: 'crmwf.report.sent', resourceId: key },
        select: { id: true },
      });
      if (exists) return null;
      const row = await tx.auditLog.create({
        data: {
          tenantId,
          action: 'crmwf.report.sent',
          resource: 'CrmWfReport',
          resourceId: key,
        },
      });
      return row.id;
    });
  }

  private async deliver(
    cfg: Extract<DeliveryConfig, { enabled: true }>,
    subject: string,
    text: string,
  ) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res =
        cfg.channel === 'webhook'
          ? await fetch(cfg.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: `${subject}\n${text}` }),
              signal: ctl.signal,
            })
          : await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': createHash('sha256')
                  .update(subject)
                  .digest('hex')
                  .slice(0, 40),
              },
              body: JSON.stringify({
                from: cfg.from,
                to: cfg.to,
                subject,
                text,
              }),
              signal: ctl.signal,
            });
      if (!res.ok) throw new Error(`delivery_http_${res.status}`);
    } finally {
      clearTimeout(t);
    }
  }
}
