import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { upgradeState } from '../chat/memory/journey.store';
import { OutboxService } from '../integrations/core/outbox.service';
import { CrmSyncService } from '../integrations/crm/crm-sync.service';
import { LlmRouterService } from '../ai/llm-router.service';
import { TekionProvider } from '../integrations/tekion/tekion.provider';
import {
  StoreHoursService,
  parseWeekly,
} from '../locations/store-hours.service';
import {
  CreditApplicationService,
  CreditLinkResolution,
  validateCreditConfig,
} from '../finance/credit-application.service';
import { urlLooksSensitive } from '../finance/credit-destination';

/** Staff-safe view of the customer-facing credit-link state (never the URL/token). */
function publicCreditView(r: CreditLinkResolution) {
  return r.available
    ? {
        available: true,
        preview: r.preview,
        providerName: r.config.providerName,
        host: r.config.host ?? null,
        linkType: r.config.linkType ?? null,
      }
    : { available: false, reason: r.reason };
}

/** Raw location JSON with any URL reduced to its origin + path (no query/fragment). */
function maskCreditJson(raw: unknown) {
  if (!raw || typeof raw !== 'object') return raw ?? null;
  const r = { ...(raw as Record<string, unknown>) };
  if (typeof r.url === 'string') {
    try {
      const u = new URL(r.url);
      r.url = `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      r.url = '[invalid]';
    }
  }
  return r;
}
import { mergePolicy } from '../finance/financial-assumption-policy';
import { isValidTimeZone, parseIsoDate } from '../common/time/zoned-time';
import { redactCreditSensitive } from '../common/security/sensitive-data';

type Scope = { tenantId: string; locationId: string | null };

const OPEN_HANDOFF = ['REQUESTED', 'QUEUED', 'ASSIGNED', 'JOINED'];

/**
 * Staff-facing operational reads/writes for the AMQUR Command Center. Every query is tenant
 * scoped and (for location-bound staff) location scoped by the controller. Lists are cursor
 * paginated and use bounded `select`s/aggregates to avoid N+1 dashboard queries.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly crm: CrmSyncService,
    private readonly llm: LlmRouterService,
    private readonly tekion: TekionProvider,
    private readonly credit: CreditApplicationService,
  ) {}

  private loc(scope: Scope) {
    return scope.locationId ? { locationId: scope.locationId } : {};
  }

  // ───────────── inbox

  async inbox(
    scope: Scope,
    f: {
      q?: string;
      handoff?: 'open' | 'all';
      assignedTo?: string;
      channel?: string;
      cursor?: string;
      take?: number;
    },
  ) {
    const take = Math.min(f.take ?? 40, 100);
    const where: Prisma.ConversationWhereInput = {
      tenantId: scope.tenantId,
      ...this.loc(scope),
      ...(f.handoff === 'open' ? { handoffState: { in: OPEN_HANDOFF } } : {}),
      ...(f.assignedTo ? { assignedUserId: f.assignedTo } : {}),
      ...(f.channel ? { channel: f.channel as never } : {}),
      ...(f.q
        ? {
            messages: {
              some: { content: { contains: f.q, mode: 'insensitive' } },
            },
          }
        : {}),
    };
    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        channel: true,
        locationId: true,
        handoffState: true,
        aiPaused: true,
        assignedUserId: true,
        language: true,
        lastActivityAt: true,
        state: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { role: true, content: true, createdAt: true },
        },
        leads: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            stage: true,
            score: true,
            nextBestAction: true,
          },
        },
        appointments: {
          where: {
            status: { in: ['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'] },
          },
          take: 1,
          select: {
            id: true,
            type: true,
            status: true,
            requestedDate: true,
            requestedTime: true,
          },
        },
      },
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((c) => {
        const st = upgradeState(c.state);
        const lead = c.leads[0];
        return {
          id: c.id,
          channel: c.channel,
          locationId: c.locationId,
          handoffState: c.handoffState,
          aiPaused: c.aiPaused,
          assignedUserId: c.assignedUserId,
          language: c.language ?? st.language ?? 'en',
          lastActivityAt: c.lastActivityAt,
          department: st.department ?? null,
          customerName: lead
            ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null
            : (st.contact.firstName ?? null),
          stage: lead?.stage ?? null,
          score: lead?.score ?? null,
          nextBestAction: lead?.nextBestAction ?? null,
          selectedVin: st.selectedVin ?? null,
          appointment: c.appointments[0] ?? null,
          lastMessage: c.messages[0]
            ? {
                role: c.messages[0].role,
                preview: c.messages[0].content.slice(0, 140),
                at: c.messages[0].createdAt,
              }
            : null,
          priority: this.priority(
            c.handoffState,
            lead?.stage ?? null,
            !!c.appointments[0],
          ),
        };
      }),
      nextCursor: rows.length > take ? page[page.length - 1].id : null,
    };
  }

  /** Work is prioritized by reason, not recency. */
  private priority(
    handoff: string,
    stage: string | null,
    hasAppt: boolean,
  ): { rank: number; reason: string } {
    if (handoff === 'REQUESTED' || handoff === 'QUEUED')
      return { rank: 1, reason: 'Customer asked for a person' };
    if (hasAppt)
      return { rank: 2, reason: 'Appointment request awaiting confirmation' };
    if (stage === 'HOT') return { rank: 3, reason: 'Hot lead' };
    if (handoff === 'ASSIGNED' || handoff === 'JOINED')
      return { rank: 4, reason: 'Staff conversation in progress' };
    if (stage === 'WARM') return { rank: 5, reason: 'Warm lead' };
    return { rank: 9, reason: 'Browsing' };
  }

  async conversation(scope: Scope, id: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 300,
          select: {
            id: true,
            role: true,
            content: true,
            metadata: true,
            createdAt: true,
          },
        },
        leads: { orderBy: { createdAt: 'desc' }, take: 1 },
        appointments: { orderBy: { createdAt: 'desc' }, take: 10 },
        escalations: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    const st = upgradeState(c.state);
    const [trade, finance, parts] = await Promise.all([
      this.prisma.tradeRequest.findMany({
        where: { tenantId: scope.tenantId, conversationId: c.id },
        take: 5,
      }),
      this.prisma.financeRequest.findMany({
        where: { tenantId: scope.tenantId, conversationId: c.id },
        take: 5,
      }),
      this.prisma.partsInquiry.findMany({
        where: { tenantId: scope.tenantId, conversationId: c.id },
        take: 5,
      }),
    ]);
    return {
      id: c.id,
      channel: c.channel,
      locationId: c.locationId,
      handoffState: c.handoffState,
      aiPaused: c.aiPaused,
      assignedUserId: c.assignedUserId,
      language: c.language ?? st.language ?? 'en',
      journey: {
        department: st.department ?? null,
        criteria: st.criteria,
        selectedVin: st.selectedVin ?? null,
        visibleVins: st.visibleVins,
        payment: st.payment,
        trade: st.trade ?? null,
        openQuestions: st.openQuestions,
        signals: st.signals,
        attribution: st.attribution ?? null,
      },
      summary: this.operationalSummary(st, c.leads[0] ?? null),
      messages: c.messages,
      lead: c.leads[0] ?? null,
      appointments: c.appointments,
      escalations: c.escalations,
      tradeRequests: trade,
      financeRequests: finance,
      partsInquiries: parts,
    };
  }

  /** Deterministic operational summary (no model chain-of-thought). */
  private operationalSummary(
    st: ReturnType<typeof upgradeState>,
    lead: {
      stage: string;
      score: number;
      nextBestAction: string | null;
    } | null,
  ) {
    const bits: string[] = [];
    const c = st.criteria;
    const want = [c.color, c.year, c.make, c.model].filter(Boolean).join(' ');
    if (want)
      bits.push(
        `Shopping: ${want}${c.maxPrice ? ` under $${c.maxPrice.toLocaleString('en-US')}` : ''}`,
      );
    if (st.selectedVin) bits.push(`Selected VIN ${st.selectedVin}`);
    if (st.payment.lastEstimate)
      bits.push(
        `Estimate ~$${Math.round(st.payment.lastEstimate.monthly)}/mo (${st.payment.lastEstimate.aprSource.toLowerCase()} APR)`,
      );
    if (st.payment.maxMonthly)
      bits.push(`Payment target $${st.payment.maxMonthly}/mo`);
    if (st.trade?.requestId)
      bits.push(
        `Trade: ${[st.trade.year, st.trade.make, st.trade.model].filter(Boolean).join(' ')}${st.trade.mileage ? `, ${st.trade.mileage.toLocaleString('en-US')} mi` : ''}`,
      );
    if (st.appointment)
      bits.push(
        `Appointment ${st.appointment.status.toLowerCase()}: ${st.appointment.requestedDate ?? ''} ${st.appointment.requestedTime ?? ''}`.trim(),
      );
    if (st.service?.need) bits.push(`Service need: ${st.service.need}`);
    if (st.parts?.need)
      bits.push(
        `Parts: ${st.parts.need}${st.parts.vin ? ` (VIN on file)` : ' (needs VIN)'}`,
      );
    if (st.finance?.creditLinkOffered)
      bits.push('Credit application link offered');
    if (st.openQuestions.length)
      bits.push(`Unanswered: ${st.openQuestions.slice(-2).join(' / ')}`);
    return {
      text: bits.join(' · ') || 'No actionable context yet',
      stage: lead?.stage ?? null,
      score: lead?.score ?? null,
      nextBestAction: lead?.nextBestAction ?? null,
    };
  }

  // ───────────── takeover lifecycle

  async takeover(scope: Scope, id: string, userId: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    if (c.assignedUserId && c.assignedUserId !== userId && c.aiPaused) {
      throw new ConflictException(
        'Another team member owns this conversation — transfer it first',
      );
    }
    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id },
        data: {
          aiPaused: true,
          handoffState: 'JOINED',
          assignedUserId: userId,
        },
      }),
      this.prisma.message.create({
        data: {
          conversationId: id,
          role: 'SYSTEM',
          content: 'A team member joined the conversation.',
          metadata: { event: 'staff_joined', userId },
        },
      }),
      this.prisma.escalation.updateMany({
        where: {
          tenantId: scope.tenantId,
          conversationId: id,
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        },
        data: { status: 'IN_PROGRESS' },
      }),
      this.prisma.auditLog.create({
        data: {
          tenantId: scope.tenantId,
          userId,
          action: 'conversation.takeover',
          resource: 'Conversation',
          resourceId: id,
        },
      }),
    ]);
    return { ok: true };
  }

  async transfer(
    scope: Scope,
    id: string,
    fromUserId: string,
    toUserId: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id: toUserId, tenantId: scope.tenantId, isActive: true },
    });
    if (!target)
      throw new BadRequestException('Target user not found in this dealership');
    const res = await this.prisma.conversation.updateMany({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
      data: { assignedUserId: toUserId, handoffState: 'ASSIGNED' },
    });
    if (!res.count) throw new NotFoundException('Conversation not found');
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId: fromUserId,
        action: 'conversation.transfer',
        resource: 'Conversation',
        resourceId: id,
        metadata: { toUserId },
      },
    });
    return { ok: true };
  }

  async release(scope: Scope, id: string, userId: string) {
    const res = await this.prisma.conversation.updateMany({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
      data: { aiPaused: false, handoffState: 'RELEASED' },
    });
    if (!res.count) throw new NotFoundException('Conversation not found');
    await this.prisma.message.create({
      data: {
        conversationId: id,
        role: 'SYSTEM',
        content: 'The virtual concierge is back to help.',
        metadata: { event: 'ai_resumed', userId },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId,
        action: 'conversation.release',
        resource: 'Conversation',
        resourceId: id,
      },
    });
    return { ok: true };
  }

  /** Staff reply is stored as a staff-authored message; the widget fetches it. Never sent by AI. */
  async staffReply(scope: Scope, id: string, userId: string, text: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    if (!c.aiPaused || c.assignedUserId !== userId) {
      throw new ConflictException('Take over the conversation before replying');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true },
    });
    const msg = await this.prisma.message.create({
      data: {
        conversationId: id,
        role: 'ASSISTANT',
        content: redactCreditSensitive(text).slice(0, 4000),
        metadata: {
          author: 'staff',
          userId,
          displayName: user?.firstName ?? 'Team member',
        },
      },
    });
    await this.prisma.conversation.update({
      where: { id },
      data: { lastActivityAt: new Date() },
    });
    return msg;
  }

  async note(scope: Scope, id: string, userId: string, text: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    return this.prisma.message.create({
      data: {
        conversationId: id,
        role: 'SYSTEM',
        content: text.slice(0, 2000),
        metadata: { internalNote: true, userId },
      },
    });
  }

  // ───────────── queues / overview

  async queues(scope: Scope) {
    const base = { tenantId: scope.tenantId, ...this.loc(scope) };
    const staleBefore = new Date(Date.now() - 2 * 3600_000);
    const agedBefore = new Date(Date.now() - 7 * 86_400_000);
    const [
      appointments,
      finance,
      parts,
      trades,
      escalations,
      quotes,
      unansweredInbound,
      aiFeedbackFlags,
      overdueLeads,
      missedAppointments,
    ] = await Promise.all([
        this.prisma.appointment.findMany({
          where: {
            ...base,
            status: { in: ['REQUESTED', 'PENDING_CONFIRMATION'] },
          },
          orderBy: [{ requestedAt: 'asc' }],
          take: 100,
        }),
        this.prisma.financeRequest.findMany({
          where: { ...base, status: { in: ['REQUESTED', 'PENDING_STAFF'] } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.partsInquiry.findMany({
          where: {
            ...base,
            status: {
              in: ['REQUESTED', 'FITMENT_PENDING', 'PENDING_STAFF', 'QUOTED'],
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.tradeRequest.findMany({
          where: {
            ...base,
            status: { in: ['REQUESTED', 'PENDING_STAFF', 'APPRAISAL_PENDING'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.escalation.findMany({
          where: {
            ...base,
            status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
        this.prisma.priceQuoteRequest.findMany({
          where: { ...base, status: { in: ['REQUESTED', 'IN_PROGRESS'] } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        // Customer last messaged; AI not paused; waiting >2h without staff reply.
        this.prisma.conversation.findMany({
          where: {
            ...base,
            aiPaused: false,
            handoffState: { in: ['NONE', 'REQUESTED', 'QUEUED'] },
            lastActivityAt: { lte: staleBefore },
            messages: { some: { role: 'USER' } },
          },
          orderBy: { lastActivityAt: 'asc' },
          take: 50,
          select: {
            id: true,
            channel: true,
            handoffState: true,
            lastActivityAt: true,
            locationId: true,
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { role: true, content: true, createdAt: true },
            },
          },
        }),
        this.prisma.analyticsEvent.findMany({
          where: {
            ...base,
            eventType: 'ai.reply_feedback',
            occurredAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
          },
          orderBy: { occurredAt: 'desc' },
          take: 50,
          select: {
            id: true,
            occurredAt: true,
            properties: true,
            conversationExternalKey: true,
            locationId: true,
          },
        }),
        this.prisma.lead.findMany({
          where: {
            ...base,
            status: { in: ['OPEN', 'CONTACTED'] },
            stage: { in: ['HOT', 'WARM'] },
            updatedAt: { lte: agedBefore },
          },
          orderBy: { updatedAt: 'asc' },
          take: 50,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            stage: true,
            status: true,
            updatedAt: true,
            phone: true,
            conversationId: true,
          },
        }),
        this.prisma.appointment.findMany({
          where: {
            ...base,
            status: 'NO_SHOW',
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
      ]);

    const unanswered = unansweredInbound
      .filter((c) => c.messages[0]?.role === 'USER')
      .map((c) => ({
        id: c.id,
        channel: c.channel,
        handoffState: c.handoffState,
        lastActivityAt: c.lastActivityAt,
        preview: c.messages[0]?.content?.slice(0, 140) ?? '',
        reason: 'Unanswered inbound message',
        priority: 1,
      }));

    const aiUncertain = aiFeedbackFlags
      .filter((e) => {
        const label = (e.properties as { label?: string } | null)?.label;
        return (
          label === 'wrong_facts' ||
          label === 'needed_human' ||
          label === 'wrong_question' ||
          label === 'sounds_robotic'
        );
      })
      .map((e) => ({
        id: e.id,
        conversationExternalKey: e.conversationExternalKey,
        occurredAt: e.occurredAt,
        label: (e.properties as { label?: string })?.label ?? 'feedback',
        reason: 'AI reply flagged by staff',
        priority: 2,
      }));

    return {
      appointments,
      finance,
      parts,
      trades,
      escalations,
      quotes,
      prioritized: {
        unansweredInbound: unanswered,
        aiUncertain,
        overdueLeads,
        missedAppointments,
      },
    };
  }

  async overview(scope: Scope) {
    const base = { tenantId: scope.tenantId, ...this.loc(scope) };
    const since = new Date(Date.now() - 7 * 86_400_000);
    const dayStart = new Date(Date.now() - 24 * 3600_000);
    const [
      convos7d,
      leads7d,
      hotLeads,
      apptReq,
      apptConfirmed,
      openHandoffs,
      partsOpen,
      financeOpen,
      conflicts,
      outboxStats,
      inventoryRuns,
      vehicleCounts,
      events,
    ] = await Promise.all([
      this.prisma.conversation.count({
        where: { ...base, createdAt: { gte: since } },
      }),
      this.prisma.lead.count({ where: { ...base, createdAt: { gte: since } } }),
      this.prisma.lead.count({
        where: { ...base, stage: 'HOT', status: { in: ['OPEN', 'CONTACTED'] } },
      }),
      this.prisma.appointment.count({
        where: {
          ...base,
          status: { in: ['REQUESTED', 'PENDING_CONFIRMATION'] },
        },
      }),
      this.prisma.appointment.count({
        where: { ...base, status: 'CONFIRMED', createdAt: { gte: since } },
      }),
      this.prisma.escalation.count({
        where: { ...base, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      }),
      this.prisma.partsInquiry.count({
        where: {
          ...base,
          status: { in: ['REQUESTED', 'FITMENT_PENDING', 'PENDING_STAFF'] },
        },
      }),
      this.prisma.financeRequest.count({
        where: { ...base, status: { in: ['REQUESTED', 'PENDING_STAFF'] } },
      }),
      this.prisma.sourceConflict.count({
        where: { tenantId: scope.tenantId, status: 'OPEN' },
      }),
      this.outbox.stats(scope.tenantId),
      this.prisma.inventoryImportRun.findMany({
        where: base,
        orderBy: { startedAt: 'desc' },
        take: 5,
      }),
      this.prisma.vehicle.groupBy({
        by: ['freshnessState'],
        where: { ...base, status: { in: ['AVAILABLE', 'IN_TRANSIT'] } },
        _count: { _all: true },
      }),
      this.prisma.analyticsEvent.groupBy({
        by: ['eventType'],
        where: { ...base, occurredAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    const ev = Object.fromEntries(
      events.map((e) => [e.eventType, e._count._all]),
    );
    return {
      window: '7d',
      engagement: {
        conversations: convos7d,
        conversationStarts: ev.conversation_start ?? 0,
        messages: ev.message_sent ?? 0,
      },
      outcomes: {
        leadsCaptured: leads7d,
        appointmentRequests: ev.appointment_requested ?? 0,
        serviceRequests: ev.service_appointment_requested ?? 0,
        confirmedAppointments: apptConfirmed,
        creditLinksOffered: ev.credit_link_offered ?? 0,
        creditLinksClicked: ev.credit_link_clicked ?? 0,
        note: 'Sold/show outcomes appear only when an authoritative DMS/CRM outcome source is connected.',
      },
      attention: {
        hotLeads,
        appointmentsAwaitingConfirmation: apptReq,
        openHandoffs,
        partsOpen,
        financeOpen,
        sourceConflicts: conflicts,
      },
      technical: {
        outbox: outboxStats,
        inventory: {
          freshness: Object.fromEntries(
            vehicleCounts.map((v) => [v.freshnessState, v._count._all]),
          ),
          recentImports: inventoryRuns.map((r) => ({
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            records: r.recordCount,
            valid: r.validCount,
            rejected: r.rejectedCount,
            anomalies: r.anomalyFlags,
          })),
        },
        llm: await this.llm.health(),
      },
      aiQuality: {
        inventoryMisses: ev.zero_inventory_results ?? ev.inventory_result ?? 0,
        knowledgeMisses: ev.knowledge_miss ?? 0,
      },
      since: dayStart.toISOString(),
    };
  }

  async integrations(scope: Scope) {
    const conns = await this.prisma.integrationConnection.findMany({
      where: { tenantId: scope.tenantId },
      select: {
        id: true,
        provider: true,
        capability: true,
        enabled: true,
        liveReady: true,
        healthStatus: true,
        lastSuccessAt: true,
        lastError: true,
        lastHealthAt: true,
        syncCursor: true,
        circuitOpenUntil: true,
        locationId: true,
        config: true,
        secrets: { select: { id: true } },
      },
    });
    const tekionHealth = await this.tekion.healthCheck();
    const tekionGate = await this.crm.tekionGate(
      scope.tenantId,
      scope.locationId,
    );
    return {
      tekion: {
        status: tekionHealth.status,
        detail: tekionHealth.detail,
        capabilities: this.tekion.capabilities(),
        writebackGate: tekionGate,
        connections: conns
          .filter((c) => c.provider === 'TEKION')
          .map((c) => ({
            ...c,
            config: {
              environment:
                (c.config as Record<string, unknown>)?.environment ?? null,
              dealerId: (c.config as Record<string, unknown>)?.dealerId ?? null,
            },
            secrets: undefined,
            credentialConfigured: c.secrets.length > 0,
          })),
      },
      llm: await this.llm.health(),
      connections: conns.map((c) => ({
        id: c.id,
        provider: c.provider,
        capability: c.capability,
        enabled: c.enabled,
        liveReady: c.liveReady,
        healthStatus: c.healthStatus,
        lastSuccessAt: c.lastSuccessAt,
        lastError: c.lastError,
        lastHealthAt: c.lastHealthAt,
        circuitOpenUntil: c.circuitOpenUntil,
        locationId: c.locationId,
        credentialConfigured: c.secrets.length > 0,
      })),
      messaging: {
        sms: 'awaiting_provider_configuration',
        email: 'awaiting_provider_configuration',
        voice: 'awaiting_provider_configuration',
      },
      errorMonitoring: { sentryConfigured: !!process.env.SENTRY_DSN },
      crmWebhook: {
        configured: !!process.env.CRM_WEBHOOK_URL,
        signed: !!process.env.CRM_WEBHOOK_SIGNING_SECRET,
      },
    };
  }

  async deadLetters(scope: Scope) {
    return this.prisma.outboxEvent.findMany({
      where: { tenantId: scope.tenantId, status: 'DEAD' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        topic: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async replay(scope: Scope, ids: string[], userId: string) {
    const res = await this.outbox.replay(scope.tenantId, ids.slice(0, 100));
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId,
        action: 'outbox.replay',
        metadata: { count: res.count },
      },
    });
    return res;
  }

  /** Universal staff search — tenant/location scoped, exact-ish matching only. */
  async search(scope: Scope, q: string) {
    const term = q.trim();
    if (term.length < 2) return { leads: [], vehicles: [], appointments: [] };
    const digits = term.replace(/\D/g, '');
    const base = { tenantId: scope.tenantId, ...this.loc(scope) };
    const [leads, vehicles, appointments] = await Promise.all([
      this.prisma.lead.findMany({
        where: {
          ...base,
          OR: [
            { email: { equals: term.toLowerCase() } },
            ...(digits.length >= 7
              ? [{ phone: { contains: digits.slice(-10) } }]
              : []),
            { firstName: { contains: term, mode: 'insensitive' as const } },
            { lastName: { contains: term, mode: 'insensitive' as const } },
            { interestedVin: { equals: term.toUpperCase() } },
          ],
        },
        take: 20,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          stage: true,
          conversationId: true,
          interestedVin: true,
        },
      }),
      this.prisma.vehicle.findMany({
        where: {
          tenantId: scope.tenantId,
          OR: [
            { vin: { equals: term.toUpperCase() } },
            { stock: { equals: term, mode: 'insensitive' } },
          ],
        },
        take: 10,
        select: {
          id: true,
          vin: true,
          stock: true,
          year: true,
          make: true,
          model: true,
          trim: true,
          status: true,
          price: true,
        },
      }),
      this.prisma.appointment.findMany({
        where: {
          ...base,
          OR: [
            { id: term },
            { customerEmail: term.toLowerCase() },
            ...(digits.length >= 7
              ? [{ customerPhone: { contains: digits.slice(-10) } }]
              : []),
            { vehicleVin: term.toUpperCase() },
          ],
        },
        take: 20,
      }),
    ]);
    return { leads, vehicles, appointments };
  }

  // ───────────── location operations settings (admin)

  async locationSettings(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: {
        id: true,
        name: true,
        timezone: true,
        phone: true,
        address: true,
        storeHours: true,
        departmentHours: true,
        holidayHours: true,
        storeHoursVerifiedAt: true,
        storeHoursVerifiedBy: true,
        financialPolicy: true,
        creditApplication: true,
        serviceAmenities: true,
        messagingPolicy: true,
      },
    });
    if (!loc) throw new NotFoundException('Location not found');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { financialPolicy: true, creditApplication: true },
    });
    const mp =
      loc.messagingPolicy && typeof loc.messagingPolicy === 'object'
        ? (loc.messagingPolicy as {
            quietStart?: string;
            quietEnd?: string;
          })
        : {};
    return {
      ...loc,
      effective: {
        hours: StoreHoursService.buildProfile(loc),
        financialPolicy: mergePolicy(
          tenant?.financialPolicy,
          loc.financialPolicy,
        ),
        creditApplication: publicCreditView(
          await this.credit.resolve(tenantId, locationId),
        ),
        messaging: {
          quietStart: mp.quietStart ?? '21:00',
          quietEnd: mp.quietEnd ?? '08:00',
          timezone: loc.timezone,
        },
      },
      creditApplication: maskCreditJson(loc.creditApplication),
    };
  }

  async updateLocationSettings(
    tenantId: string,
    locationId: string,
    userId: string,
    patch: {
      timezone?: string;
      storeHours?: unknown;
      departmentHours?: unknown;
      holidayHours?: unknown;
      verifyHours?: boolean;
      financialPolicy?: unknown;
      creditApplication?: unknown;
      serviceAmenities?: Record<string, unknown> | null;
      messagingPolicy?: Record<string, unknown> | null;
    },
  ) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    const data: Prisma.LocationUpdateInput = {};
    if (patch.timezone !== undefined) {
      if (!isValidTimeZone(patch.timezone))
        throw new BadRequestException('Invalid IANA timezone');
      data.timezone = patch.timezone;
    }
    if (patch.storeHours !== undefined) {
      if (patch.storeHours !== null && !parseWeekly(patch.storeHours))
        throw new BadRequestException(
          'storeHours must be { mon: { open: "09:00", close: "19:00" }, … }',
        );
      data.storeHours = patch.storeHours as Prisma.InputJsonValue;
      data.storeHoursVerifiedAt = null; // hours changed → must be re-verified
    }
    if (patch.departmentHours !== undefined)
      data.departmentHours = patch.departmentHours as Prisma.InputJsonValue;
    if (patch.holidayHours !== undefined) {
      if (
        !Array.isArray(patch.holidayHours) ||
        patch.holidayHours.some(
          (h) =>
            !h ||
            typeof h !== 'object' ||
            !parseIsoDate(String((h as { date?: unknown }).date)),
        )
      ) {
        throw new BadRequestException(
          'holidayHours must be [{ date: "YYYY-MM-DD", closed?: true, open?, close? }]',
        );
      }
      data.holidayHours = patch.holidayHours as Prisma.InputJsonValue;
    }
    if (patch.verifyHours === true) {
      data.storeHoursVerifiedAt = new Date();
      data.storeHoursVerifiedBy = userId;
    }
    if (patch.financialPolicy !== undefined) {
      const p = { ...(patch.financialPolicy as object), verifiedBy: userId };
      mergePolicy(p); // validates shape
      data.financialPolicy = p as Prisma.InputJsonValue;
    }
    if (patch.creditApplication !== undefined) {
      const incoming = patch.creditApplication as Record<string, unknown>;
      if (typeof incoming.url === 'string' && urlLooksSensitive(incoming.url))
        throw new BadRequestException(
          'This URL contains a credential-like parameter. Use PUT /api/ops/locations/:id/credit-application/destination so it is stored encrypted.',
        );
      const current = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId },
        select: { creditApplication: true },
      });
      const cur = (current?.creditApplication ?? {}) as Record<string, unknown>;
      if (cur.destination === 'vault' && !incoming.url) {
        // Vault-backed destination: only label/enabled may change here.
        data.creditApplication = {
          ...cur,
          ...(typeof incoming.enabled === 'boolean'
            ? { enabled: incoming.enabled }
            : {}),
          ...(typeof incoming.label === 'string'
            ? { label: incoming.label.slice(0, 60) }
            : {}),
        } as Prisma.InputJsonValue;
        patch = { ...patch, creditApplication: undefined };
      }
    }
    if (patch.creditApplication !== undefined) {
      const c = { ...(patch.creditApplication as object), verifiedBy: userId };
      const v = validateCreditConfig(c);
      if (!v.available && (c as { enabled?: boolean }).enabled === true) {
        throw new BadRequestException(
          `Credit application config rejected: ${v.reason}`,
        );
      }
      data.creditApplication = c as Prisma.InputJsonValue;
    }
    if (patch.serviceAmenities !== undefined) {
      data.serviceAmenities =
        patch.serviceAmenities === null
          ? Prisma.DbNull
          : ({
              ...patch.serviceAmenities,
              verifiedAt: new Date().toISOString(),
              verifiedBy: userId,
            } as Prisma.InputJsonValue);
    }
    if (patch.messagingPolicy !== undefined) {
      if (patch.messagingPolicy === null) {
        data.messagingPolicy = Prisma.DbNull;
      } else {
        const q = patch.messagingPolicy;
        const hhmm = (v: unknown) =>
          typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
        if (q.quietStart !== undefined && !hhmm(q.quietStart))
          throw new BadRequestException('quietStart must be HH:MM');
        if (q.quietEnd !== undefined && !hhmm(q.quietEnd))
          throw new BadRequestException('quietEnd must be HH:MM');
        data.messagingPolicy = {
          ...(typeof q.quietStart === 'string'
            ? { quietStart: q.quietStart }
            : {}),
          ...(typeof q.quietEnd === 'string' ? { quietEnd: q.quietEnd } : {}),
          ...(typeof q.maxMarketingPer24h === 'number'
            ? { maxMarketingPer24h: Math.max(0, Math.min(20, q.maxMarketingPer24h)) }
            : {}),
        } as Prisma.InputJsonValue;
      }
    }
    await this.prisma.location.update({ where: { id: locationId }, data });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'location.operations.update',
        resource: 'Location',
        resourceId: locationId,
        metadata: { fields: Object.keys(patch) },
      },
    });
    return this.locationSettings(tenantId, locationId);
  }

  /** AI provider status for admins: configured/missing, models, circuits, spend — never keys. */
  async aiStatus(tenantId?: string | null) {
    const status = await this.llm.status();
    return {
      ...status,
      tenantSpend: tenantId ? await this.llm.tenantSpendToday(tenantId) : null,
    };
  }

  // ───────────── unified customer view (read-only, exact-match linking)

  /**
   * One customer's timeline inside ONE tenant (and the caller's location scope), linked only
   * by an exact normalized phone (last 10 digits) or exact lowercase email. Nothing is merged:
   * records stay separate and every linked record states which key linked it. Different
   * leads sharing a key are surfaced as `possibleDuplicates` for staff review.
   */
  async customerProfile(scope: Scope, q: { phone?: string; email?: string }) {
    const digits = (q.phone ?? '').replace(/\D/g, '').slice(-10);
    const email = (q.email ?? '').trim().toLowerCase();
    if (digits.length !== 10 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new BadRequestException('Provide a 10-digit phone or a full email');
    const base = { tenantId: scope.tenantId, ...this.loc(scope) };
    const leadOr = [
      ...(digits.length === 10 ? [{ phone: { endsWith: digits } }] : []),
      ...(email ? [{ email: { equals: email } }] : []),
    ];
    const contactOr = [
      ...(digits.length === 10
        ? [{ customerPhone: { endsWith: digits } }]
        : []),
      ...(email ? [{ customerEmail: { equals: email } }] : []),
    ];
    const [leads, appointments, quotes, trades, finance, parts] =
      await Promise.all([
        this.prisma.lead.findMany({
          where: { ...base, OR: leadOr },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            stage: true,
            status: true,
            conversationId: true,
            interestedVin: true,
            createdAt: true,
          },
        }),
        this.prisma.appointment.findMany({
          where: { ...base, OR: contactOr },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prisma.priceQuoteRequest.findMany({
          where: { ...base, OR: contactOr },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prisma.tradeRequest.findMany({
          where: { ...base, OR: contactOr },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prisma.financeRequest.findMany({
          where: { ...base, OR: contactOr },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prisma.partsInquiry.findMany({
          where: { ...base, OR: contactOr },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);
    const names = new Set(
      leads
        .map((l) =>
          `${l.firstName ?? ''} ${l.lastName ?? ''}`.trim().toLowerCase(),
        )
        .filter(Boolean),
    );
    const timeline = [
      ...leads.map((x) => ({
        at: x.createdAt,
        kind: 'lead',
        id: x.id,
        summary: `${x.stage} lead${x.interestedVin ? ` · ${x.interestedVin}` : ''}`,
      })),
      ...appointments.map((x) => ({
        at: x.createdAt,
        kind: 'appointment',
        id: x.id,
        summary: `${x.type} ${x.status}`,
      })),
      ...quotes.map((x) => ({
        at: x.createdAt,
        kind: 'otd_quote',
        id: x.id,
        summary: `${x.vehicleLabel ?? x.vehicleVin} · ${x.paymentMethod} · ${x.status}`,
      })),
      ...trades.map((x) => ({
        at: x.createdAt,
        kind: 'trade',
        id: x.id,
        summary: `${[x.year, x.make, x.model].filter(Boolean).join(' ')} · ${x.status}`,
      })),
      ...finance.map((x) => ({
        at: x.createdAt,
        kind: 'finance',
        id: x.id,
        summary: `credit ${x.creditLinkState.toLowerCase()}`,
      })),
      ...parts.map((x) => ({
        at: x.createdAt,
        kind: 'parts',
        id: x.id,
        summary: `${x.suspectedPart ?? x.partNumber ?? 'parts'} · ${x.status}`,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return {
      linkedBy: {
        phoneLast10: digits.length === 10 ? digits : null,
        email: email || null,
      },
      leads,
      timeline,
      // Same contact key under different names: staff decide; the system never auto-merges.
      possibleDuplicates: names.size > 1 ? leads.map((l) => l.id) : [],
      mergePolicy:
        'No automatic merges. Records are linked for viewing only by exact phone/email within this store.',
    };
  }

  // ───────────── emergency AI controls (no redeploy)

  /**
   * Staff teaching signal on an AI reply. Aggregated for Conversation Studio —
   * never auto-publishes new behavior.
   */
  async recordReplyFeedback(
    scope: Scope,
    userId: string,
    input: {
      conversationId: string;
      messageId?: string;
      label: string;
      note?: string;
    },
  ) {
    const c = await this.prisma.conversation.findFirst({
      where: {
        id: input.conversationId,
        tenantId: scope.tenantId,
        ...this.loc(scope),
      },
      select: { id: true, locationId: true, externalKey: true },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    if (input.messageId) {
      const m = await this.prisma.message.findFirst({
        where: {
          id: input.messageId,
          conversationId: c.id,
          role: 'ASSISTANT',
        },
        select: { id: true },
      });
      if (!m) throw new NotFoundException('Assistant message not found');
    }
    await this.prisma.$transaction([
      this.prisma.analyticsEvent.create({
        data: {
          tenantId: scope.tenantId,
          locationId: c.locationId,
          eventType: 'ai.reply_feedback',
          conversationExternalKey: c.externalKey,
          properties: {
            label: input.label,
            messageId: input.messageId ?? null,
            hasNote: !!input.note,
          } as Prisma.InputJsonValue,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          tenantId: scope.tenantId,
          userId,
          action: 'ai.reply_feedback',
          resource: 'Conversation',
          resourceId: c.id,
          metadata: {
            label: input.label,
            messageId: input.messageId ?? null,
            note: input.note?.slice(0, 500) ?? null,
          } as Prisma.InputJsonValue,
        },
      }),
    ]);
    return { ok: true as const, label: input.label };
  }

  /**
   * Conversation Studio read model for a rooftop (effective location flags + policy version).
   */
  async getAiControl(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true, name: true, featureFlags: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    const f = (loc.featureFlags ?? {}) as Record<string, unknown>;
    return {
      locationId: loc.id,
      name: loc.name,
      policyVersion: 'conv-policy-v1-2026-10',
      composePromptVersion: 'compose-v2-2026-10-short',
      chat: f.chat !== false,
      llmDisabled: f.llmDisabled === true,
      verboseReplies: f.verboseReplies === true,
      contextualRapport: f.contextualRapport === true,
      conciseDefault: f.verboseReplies !== true,
    };
  }

  /**
   * Store-level emergency switch + Conversation Studio toggles.
   * `chat:false` stops the assistant for this rooftop; `llmDisabled:true` keeps the
   * deterministic concierge but makes zero language-model calls.
   * `verboseReplies` / `contextualRapport` control reply length and optional rapport.
   * Effective on the next message; audited.
   */
  async setAiControl(
    tenantId: string,
    locationId: string,
    userId: string,
    patch: {
      chat?: boolean;
      llmDisabled?: boolean;
      verboseReplies?: boolean;
      contextualRapport?: boolean;
      reason: string;
    },
  ) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true, featureFlags: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    const cur = (loc.featureFlags ?? {}) as Record<string, unknown>;
    const next = {
      ...cur,
      ...(typeof patch.chat === 'boolean' ? { chat: patch.chat } : {}),
      ...(typeof patch.llmDisabled === 'boolean'
        ? { llmDisabled: patch.llmDisabled }
        : {}),
      ...(typeof patch.verboseReplies === 'boolean'
        ? { verboseReplies: patch.verboseReplies }
        : {}),
      ...(typeof patch.contextualRapport === 'boolean'
        ? { contextualRapport: patch.contextualRapport }
        : {}),
    };
    await this.prisma.$transaction([
      this.prisma.location.update({
        where: { id: loc.id },
        data: { featureFlags: next as Prisma.InputJsonValue },
      }),
      // Bust widget-config caches so the change reaches every replica immediately.
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: { configVersion: { increment: 1 } },
      }),
      this.prisma.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'ai.control.changed',
          resource: 'Location',
          resourceId: loc.id,
          metadata: {
            chat: next.chat ?? null,
            llmDisabled: next.llmDisabled ?? null,
            verboseReplies: next.verboseReplies ?? null,
            contextualRapport: next.contextualRapport ?? null,
            reason: patch.reason.slice(0, 300),
          } as Prisma.InputJsonValue,
        },
      }),
    ]);
    return {
      locationId: loc.id,
      chat: next.chat !== false,
      llmDisabled: next.llmDisabled === true,
      verboseReplies: next.verboseReplies === true,
      contextualRapport: next.contextualRapport === true,
      conciseDefault: next.verboseReplies !== true,
    };
  }

  // ───────────── widget: messages since (staff replies)

  async widgetMessagesSince(
    tenantId: string,
    externalKey: string,
    afterIso?: string,
  ) {
    const conv = await this.prisma.conversation.findUnique({
      where: { tenantId_externalKey: { tenantId, externalKey } },
      select: { id: true, aiPaused: true, handoffState: true },
    });
    if (!conv) return { messages: [], aiPaused: false, handoffState: 'AI' };
    const after =
      afterIso && !Number.isNaN(Date.parse(afterIso))
        ? new Date(afterIso)
        : new Date(Date.now() - 60_000);
    const msgs = await this.prisma.message.findMany({
      where: {
        conversationId: conv.id,
        createdAt: { gt: after },
        OR: [
          {
            role: 'ASSISTANT',
            metadata: { path: ['author'], equals: 'staff' },
          },
          {
            role: 'SYSTEM',
            metadata: { path: ['internalNote'], equals: Prisma.AnyNull },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true,
        role: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    });
    return {
      aiPaused: conv.aiPaused,
      handoffState: conv.handoffState,
      messages: msgs
        .filter(
          (m) => !(m.metadata as Record<string, unknown> | null)?.internalNote,
        )
        .map((m) => ({
          id: m.id,
          kind: m.role === 'SYSTEM' ? 'system' : 'staff',
          text: m.content,
          displayName:
            (m.metadata as Record<string, unknown> | null)?.displayName ?? null,
          at: m.createdAt,
        })),
    };
  }
}
