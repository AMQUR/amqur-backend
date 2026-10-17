import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IntegrationProvider,
  Prisma,
  WebhookInboxStatus,
} from '@prisma/client';
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
import { listChannelAdapterStatuses } from '../messaging/channel-adapters';

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
import { InventoryEngine } from '../chat/engines/inventory.engine';
import { assignableStaffWhere } from '../leads/round-robin';

type Scope = { tenantId: string; locationId: string | null };

const OPEN_HANDOFF = ['REQUESTED', 'QUEUED', 'ASSIGNED', 'JOINED'];
const HANDOFF_REASSIGN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER']);

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
    private readonly inventory: InventoryEngine,
  ) {}

  /** Vehicle table browse for Command Center — DB price/status only. */
  listInventory(
    scope: Scope,
    filters: {
      vin?: string;
      stock?: string;
      make?: string;
      model?: string;
      q?: string;
    },
  ) {
    return this.inventory.browseForStaff({
      tenantId: scope.tenantId,
      locationId: scope.locationId,
      ...filters,
    });
  }

  private loc(scope: Scope) {
    return scope.locationId ? { locationId: scope.locationId } : {};
  }

  /** Active STAFF/MANAGER for lead assignment dropdowns — same scope rules as round-robin. */
  listAssignableStaff(scope: Scope) {
    return this.prisma.user.findMany({
      where: assignableStaffWhere(scope.tenantId, scope.locationId),
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        locationId: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
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
            c.appointments[0]?.status ?? null,
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
    appointmentStatus: string | null,
  ): { rank: number; reason: string } {
    if (handoff === 'REQUESTED' || handoff === 'QUEUED')
      return { rank: 1, reason: 'Customer asked for a person' };
    if (
      appointmentStatus === 'REQUESTED' ||
      appointmentStatus === 'PENDING_CONFIRMATION'
    )
      return { rank: 2, reason: 'Appointment request awaiting confirmation' };
    if (stage === 'HOT') return { rank: 3, reason: 'Hot lead' };
    if (handoff === 'ASSIGNED' || handoff === 'JOINED')
      return { rank: 4, reason: 'Staff conversation in progress' };
    if (stage === 'WARM') return { rank: 5, reason: 'Warm lead' };
    if (appointmentStatus === 'CONFIRMED')
      return { rank: 6, reason: 'Confirmed appointment on file' };
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

  private syncLeadAssignee(conversationId: string, assignedUserId: string) {
    return this.prisma.lead
      .updateMany({
        where: { conversationId },
        data: { assignedUserId },
      })
      .catch(() => undefined);
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
    await this.syncLeadAssignee(id, userId);
    return { ok: true };
  }

  async transfer(
    scope: Scope,
    id: string,
    fromUserId: string,
    toUserId: string,
    actorRole?: string,
  ) {
    if (fromUserId === toUserId) {
      throw new BadRequestException('Cannot transfer to yourself');
    }
    const c = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    if (!c.aiPaused || !c.assignedUserId) {
      throw new ConflictException(
        'Take over the conversation before transferring ownership',
      );
    }
    const canReassign =
      c.assignedUserId === fromUserId ||
      (actorRole != null && HANDOFF_REASSIGN_ROLES.has(actorRole));
    if (!canReassign) {
      throw new ForbiddenException(
        'Only the current owner can transfer this conversation',
      );
    }
    const target = await this.prisma.user.findFirst({
      where: {
        id: toUserId,
        ...assignableStaffWhere(scope.tenantId, c.locationId ?? scope.locationId),
      },
    });
    if (!target) {
      throw new BadRequestException('Target user not found in this dealership');
    }
    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id },
        data: {
          assignedUserId: toUserId,
          aiPaused: true,
          handoffState: 'JOINED',
        },
      }),
      this.prisma.message.create({
        data: {
          conversationId: id,
          role: 'SYSTEM',
          content: 'Conversation ownership was transferred to another team member.',
          metadata: {
            event: 'staff_transferred',
            fromUserId,
            toUserId,
          },
        },
      }),
      this.prisma.auditLog.create({
        data: {
          tenantId: scope.tenantId,
          userId: fromUserId,
          action: 'conversation.transfer',
          resource: 'Conversation',
          resourceId: id,
          metadata: { fromUserId: c.assignedUserId, toUserId },
        },
      }),
    ]);
    await this.syncLeadAssignee(id, toUserId);
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
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: scope.tenantId,
          userId,
          action: 'conversation.staff_reply',
          resource: 'Conversation',
          resourceId: id,
          metadata: { messageId: msg.id, chars: text.length },
        },
      })
      .catch(() => undefined);
    return msg;
  }

  async note(scope: Scope, id: string, userId: string, text: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, tenantId: scope.tenantId, ...this.loc(scope) },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    const row = await this.prisma.message.create({
      data: {
        conversationId: id,
        role: 'SYSTEM',
        content: text.slice(0, 2000),
        metadata: { internalNote: true, userId },
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: scope.tenantId,
          userId,
          action: 'conversation.note',
          resource: 'Conversation',
          resourceId: id,
          metadata: { messageId: row.id },
        },
      })
      .catch(() => undefined);
    return row;
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
          status: {
            in: ['REQUESTED', 'PENDING_STAFF', 'APPRAISAL_PENDING', 'QUOTED'],
          },
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

  /**
   * Manager Daily Brief — narrative summary from real records only.
   * Never invents sold/show outcomes without DMS attribution.
   */
  async dailyBrief(scope: Scope) {
    const overview = await this.overview(scope);
    const queues = await this.queues(scope);
    const p = queues.prioritized;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const apptsToday = await this.prisma.appointment.count({
      where: {
        tenantId: scope.tenantId,
        ...this.loc(scope),
        scheduledAt: {
          gte: todayStart,
          lt: new Date(todayStart.getTime() + 86_400_000),
        },
        status: { in: ['CONFIRMED', 'REQUESTED', 'PENDING_CONFIRMATION'] },
      },
    });
    let csiDraftsOpen = 0;
    let csiFollowUpsOpen = 0;
    if (this.surveyProviderConnected() && this.prisma.customerSurvey) {
      const baseCsi = {
        tenantId: scope.tenantId,
        ...this.loc(scope),
      };
      [csiDraftsOpen, csiFollowUpsOpen] = await Promise.all([
        this.prisma.customerSurvey.count({
          where: { ...baseCsi, status: 'DRAFT' },
        }),
        this.prisma.customerSurvey.count({
          where: {
            ...baseCsi,
            followUpStatus: { in: ['PENDING', 'ACKNOWLEDGED'] },
          },
        }),
      ]);
    }
    const priorities: Array<{ key: string; count: number; href: string }> = [
      {
        key: 'unanswered_inbound',
        count: p.unansweredInbound?.length ?? 0,
        href: '#/inbox',
      },
      {
        key: 'ai_uncertain',
        count: p.aiUncertain?.length ?? 0,
        href: '#/inbox',
      },
      {
        key: 'overdue_leads',
        count: p.overdueLeads?.length ?? 0,
        href: '#/queues',
      },
      {
        key: 'missed_appointments',
        count: p.missedAppointments?.length ?? 0,
        href: '#/appointments',
      },
      {
        key: 'open_handoffs',
        count: overview.attention.openHandoffs,
        href: '#/inbox',
      },
      {
        key: 'appointments_awaiting',
        count: overview.attention.appointmentsAwaitingConfirmation,
        href: '#/appointments',
      },
      {
        key: 'parts_open',
        count: overview.attention.partsOpen,
        href: '#/queues',
      },
      {
        key: 'finance_open',
        count: overview.attention.financeOpen,
        href: '#/queues',
      },
      {
        key: 'trades_open',
        count: overview.attention.tradesOpen,
        href: '#/queues',
      },
      {
        key: 'csi_drafts_open',
        count: csiDraftsOpen,
        href: '#/surveys',
      },
      {
        key: 'csi_follow_ups_open',
        count: csiFollowUpsOpen,
        href: '#/surveys',
      },
      {
        key: 'knowledge_misses',
        count: overview.aiQuality.knowledgeMisses,
        href: '#/knowledge',
      },
      {
        key: 'inventory_misses',
        count: overview.aiQuality.inventoryMisses,
        href: '#/inventory',
      },
    ].filter((x) => x.count > 0);

    const headlines: string[] = [];
    if (priorities.length === 0)
      headlines.push('No urgent staff queues right now.');
    else
      headlines.push(
        `${priorities.reduce((a, b) => a + b.count, 0)} items need attention across ${priorities.length} queues.`,
      );
    headlines.push(
      `${overview.outcomes.leadsCaptured} leads and ${overview.outcomes.confirmedAppointments} confirmed appointments in the last 7 days.`,
    );
    if (overview.aiQuality.replyFeedback?.total)
      headlines.push(
        `Staff rated ${overview.aiQuality.replyFeedback.good}/${overview.aiQuality.replyFeedback.total} AI replies as good (${overview.aiQuality.replyFeedback.tooLong} too long).`,
      );
    headlines.push(
      `${apptsToday} appointment(s) on the book for today (confirmed or pending).`,
    );

    return {
      generatedAt: new Date().toISOString(),
      window: overview.window,
      headlines,
      priorities,
      today: { appointmentsOnBook: apptsToday },
      attention: overview.attention,
      aiQuality: overview.aiQuality.replyFeedback,
      outcomes: overview.outcomes,
      note: 'Brief uses only persisted platform records. Sold/show attribution appears only when DMS/CRM outcome sync is connected.',
    };
  }

  /**
   * Executive keyword explain — counts from overview + daily brief only; never invents metrics.
   */
  async executiveExplain(scope: Scope, q: string) {
    const query = q.trim().toLowerCase();
    const note =
      'Answers use verified platform records from overview and daily brief only; no LLM inference or invented metrics.';
    if (!query) {
      return {
        answer:
          'Ask about leads, appointments, handoffs, parts, finance, trades, CSI, inventory, or knowledge using keywords in your question.',
        metrics: {},
        links: ['#/queues', '#/inbox'],
        source: 'platform_records' as const,
        note,
      };
    }

    const [overview, brief] = await Promise.all([
      this.overview(scope),
      this.dailyBrief(scope),
    ]);
    const csiDrafts =
      brief.priorities.find((p) => p.key === 'csi_drafts_open')?.count ?? 0;
    const csiFollowUps =
      brief.priorities.find((p) => p.key === 'csi_follow_ups_open')?.count ?? 0;
    const rf = overview.aiQuality.replyFeedback;
    const freshness = overview.technical.inventory.freshness;
    const inventoryUnits = Object.values(freshness).reduce((a, b) => a + b, 0);

    const baseMetrics: Record<string, number | string> = {
      window: overview.window,
    };

    if (query.includes('lead')) {
      return {
        answer: `In the last 7 days, ${overview.outcomes.leadsCaptured} leads were captured; ${overview.attention.hotLeads} hot leads need attention now.`,
        metrics: {
          ...baseMetrics,
          leadsCaptured7d: overview.outcomes.leadsCaptured,
          hotLeads: overview.attention.hotLeads,
        },
        links: ['#/inbox', '#/queues'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('appointment') || query.includes('appt')) {
      return {
        answer: `${overview.attention.appointmentsAwaitingConfirmation} appointment(s) await confirmation; ${brief.today.appointmentsOnBook} on the book today and ${overview.outcomes.confirmedAppointments} confirmed in the last 7 days.`,
        metrics: {
          ...baseMetrics,
          awaitingConfirmation: overview.attention.appointmentsAwaitingConfirmation,
          appointmentsOnBookToday: brief.today.appointmentsOnBook,
          confirmedAppointments7d: overview.outcomes.confirmedAppointments,
        },
        links: ['#/appointments'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('handoff') || query.includes('escalat')) {
      return {
        answer: `${overview.attention.openHandoffs} open handoff escalation(s) are in the queue right now.`,
        metrics: {
          ...baseMetrics,
          openHandoffs: overview.attention.openHandoffs,
        },
        links: ['#/inbox'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('part')) {
      return {
        answer: `${overview.attention.partsOpen} parts inquiry(ies) are open and awaiting staff action.`,
        metrics: {
          ...baseMetrics,
          partsOpen: overview.attention.partsOpen,
        },
        links: ['#/queues'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('finance') || query.includes('credit')) {
      return {
        answer: `${overview.attention.financeOpen} finance request(s) are open; ${overview.outcomes.creditLinksOffered} credit links were offered in the last 7 days (${overview.outcomes.creditLinksClicked} clicked).`,
        metrics: {
          ...baseMetrics,
          financeOpen: overview.attention.financeOpen,
          creditLinksOffered7d: overview.outcomes.creditLinksOffered,
          creditLinksClicked7d: overview.outcomes.creditLinksClicked,
        },
        links: ['#/queues'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('trade')) {
      return {
        answer: `${overview.attention.tradesOpen} trade-in request(s) are open in staff queues.`,
        metrics: {
          ...baseMetrics,
          tradesOpen: overview.attention.tradesOpen,
        },
        links: ['#/queues'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('csi') || query.includes('satisfaction') || query.includes('csat')) {
      return {
        answer: `${csiDrafts} CSI draft(s) and ${csiFollowUps} manager follow-up(s) are open (internal CSI only — not OEM scores); staff rated ${rf.good}/${rf.total} AI replies good in the last 7 days.`,
        metrics: {
          ...baseMetrics,
          csiDraftsOpen: csiDrafts,
          csiFollowUpsOpen: csiFollowUps,
          replyFeedbackTotal7d: rf.total,
          replyFeedbackGood7d: rf.good,
        },
        links: ['#/surveys', '#/inbox'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('inventory') || query.includes('stock')) {
      return {
        answer: `${inventoryUnits} available/in-transit unit(s) on file; ${overview.aiQuality.inventoryMisses} inventory miss signal(s) in the last 7 days.`,
        metrics: {
          ...baseMetrics,
          inventoryUnitsListed: inventoryUnits,
          inventoryMisses7d: overview.aiQuality.inventoryMisses,
          freshness,
        },
        links: ['#/inventory'],
        source: 'platform_records' as const,
        note,
      };
    }
    if (query.includes('knowledge') || query.includes('kb')) {
      return {
        answer: `${overview.aiQuality.knowledgeMisses} knowledge miss event(s) were recorded in the last 7 days.`,
        metrics: {
          ...baseMetrics,
          knowledgeMisses7d: overview.aiQuality.knowledgeMisses,
        },
        links: ['#/knowledge'],
        source: 'platform_records' as const,
        note,
      };
    }

    return {
      answer:
        'No keyword matched. Try leads, appointments, handoffs, parts, finance, trades, CSI, inventory, or knowledge in your question.',
      metrics: baseMetrics,
      links: ['#/queues', '#/inbox'],
      source: 'platform_records' as const,
      note,
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
      tradesOpen,
      conflicts,
      outboxStats,
      inventoryRuns,
      vehicleCounts,
      events,
      replyFeedback,
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
      this.prisma.tradeRequest.count({
        where: {
          ...base,
          status: {
            in: ['REQUESTED', 'PENDING_STAFF', 'APPRAISAL_PENDING', 'QUOTED'],
          },
        },
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
      this.prisma.analyticsEvent.findMany({
        where: {
          ...base,
          eventType: 'ai.reply_feedback',
          occurredAt: { gte: since },
        },
        select: { properties: true },
        take: 500,
      }),
    ]);
    const ev = Object.fromEntries(
      events.map((e) => [e.eventType, e._count._all]),
    );
    const feedbackByLabel: Record<string, number> = {};
    for (const row of replyFeedback) {
      const label =
        (row.properties as { label?: string } | null)?.label ?? 'unknown';
      feedbackByLabel[label] = (feedbackByLabel[label] ?? 0) + 1;
    }
    const feedbackTotal = Object.values(feedbackByLabel).reduce(
      (a, b) => a + b,
      0,
    );
    const good = feedbackByLabel.good_reply ?? 0;
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
        appointmentsCompleted: ev['appointment.completed'] ?? 0,
        appointmentsNoShow: ev['appointment.no_show'] ?? 0,
        creditLinksOffered: ev.credit_link_offered ?? 0,
        creditLinksClicked: ev.credit_link_clicked ?? 0,
        note: 'Completed/no-show counts come from staff-recorded appointment transitions. Sold/show DMS attribution appears only when an authoritative CRM outcome source is connected.',
      },
      attention: {
        hotLeads,
        appointmentsAwaitingConfirmation: apptReq,
        openHandoffs,
        partsOpen,
        financeOpen,
        tradesOpen,
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
        replyFeedback: {
          total: feedbackTotal,
          good,
          tooLong: feedbackByLabel.too_long ?? 0,
          robotic: feedbackByLabel.sounds_robotic ?? 0,
          wrongFacts: feedbackByLabel.wrong_facts ?? 0,
          wrongQuestion: feedbackByLabel.wrong_question ?? 0,
          neededHuman: feedbackByLabel.needed_human ?? 0,
          unnecessaryRapport: feedbackByLabel.unnecessary_weather_sports ?? 0,
          goodRate: feedbackTotal
            ? Math.round((good / feedbackTotal) * 100) / 100
            : null,
          byLabel: feedbackByLabel,
        },
      },
      since: dayStart.toISOString(),
    };
  }

  /**
   * Manager read of staff-recorded visit outcomes from persisted Appointment rows.
   * Show rate is completed ÷ (completed + no-show) in the window when that sum > 0.
   */
  async appointmentOutcomes(scope: Scope) {
    const base = { tenantId: scope.tenantId, ...this.loc(scope) };
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [completed, noShow, confirmedOnBook, awaitingConfirmation, cancelled] =
      await Promise.all([
        this.prisma.appointment.count({
          where: {
            ...base,
            status: 'COMPLETED',
            OR: [
              { completedAt: { gte: since } },
              { completedAt: null, updatedAt: { gte: since } },
            ],
          },
        }),
        this.prisma.appointment.count({
          where: {
            ...base,
            status: 'NO_SHOW',
            updatedAt: { gte: since },
          },
        }),
        this.prisma.appointment.count({
          where: { ...base, status: 'CONFIRMED' },
        }),
        this.prisma.appointment.count({
          where: {
            ...base,
            status: { in: ['REQUESTED', 'PENDING_CONFIRMATION'] },
          },
        }),
        this.prisma.appointment.count({
          where: {
            ...base,
            status: 'CANCELLED',
            canceledAt: { gte: since },
          },
        }),
      ]);
    const recorded = completed + noShow;
    const showRate =
      recorded > 0 ? Math.round((completed / recorded) * 1000) / 1000 : null;
    return {
      window: '7d' as const,
      since: since.toISOString(),
      counts: {
        completed,
        noShow,
        confirmedOnBook,
        awaitingConfirmation,
        cancelled,
      },
      showRate,
      note: 'Counts use persisted appointment statuses staff mark Completed or No-show. Show rate is completed ÷ (completed + no-show) in the window — not sales conversion or DMS sold attribution.',
    };
  }

  private surveyProviderConnected(): boolean {
    return Prisma.dmmf.datamodel.models.some(
      (m) => m.name === 'CustomerSurvey',
    );
  }

  /**
   * CSAT / satisfaction read surface. Never invents survey scores — uses
   * RESPONDED CustomerSurvey rows when present, otherwise proxy signals only.
   */
  async satisfaction(scope: Scope) {
    const base = { tenantId: scope.tenantId, ...this.loc(scope) };
    const since = new Date(Date.now() - 7 * 86_400_000);
    const draftsOpenP =
      this.surveyProviderConnected() && this.prisma.customerSurvey
        ? this.prisma.customerSurvey.count({
            where: { ...base, status: 'DRAFT' },
          })
        : Promise.resolve(0);
    const [overview, handoffRequested7d, draftsOpen] = await Promise.all([
      this.overview(scope),
      this.prisma.analyticsEvent.count({
        where: {
          ...base,
          eventType: 'handoff_requested',
          occurredAt: { gte: since },
        },
      }),
      draftsOpenP,
    ]);

    const proxy = this.satisfactionProxySignals(overview, handoffRequested7d);

    if (this.surveyProviderConnected() && this.prisma.customerSurvey) {
      const responded = await this.prisma.customerSurvey.findMany({
        where: {
          ...base,
          status: 'RESPONDED',
          respondedAt: { gte: since },
          score: { not: null },
        },
        select: { score: true, kind: true },
        take: 2000,
      });
      const scores = responded
        .map((r) => r.score)
        .filter((s): s is number => typeof s === 'number');
      const byKind = this.satisfactionByKind(responded);
      if (scores.length > 0) {
        const average =
          Math.round(
            (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
          ) / 10;
        return {
          available: true as const,
          source: 'customer_survey_internal' as const,
          window: overview.window,
          csat: { average, count: scores.length, scale: '1-10' as const },
          byKind,
          draftsOpen,
          signals: proxy,
          note: 'Internal staff-recorded CSI only — not OEM manufacturer scores. Mass SMS send is not enabled.',
        };
      }
      return {
        available: false as const,
        reason: 'no_survey_responses' as const,
        window: overview.window,
        byKind,
        draftsOpen,
        signals: proxy,
        note: 'CustomerSurvey model is live. Record in-person/phone CSI via POST /ops/surveys — no auto-send. Not OEM CSI.',
      };
    }

    return {
      available: false as const,
      reason: 'survey_provider_not_connected' as const,
      window: overview.window,
      draftsOpen: 0,
      signals: proxy,
      note: 'Proxy signals from staff reply feedback and handoff analytics only. Connect a survey provider for CSAT scores.',
    };
  }

  private satisfactionProxySignals(
    overview: Awaited<ReturnType<OperationsService['overview']>>,
    handoffRequested7d: number,
  ) {
    const rf = overview.aiQuality.replyFeedback;
    return {
      replyFeedback: {
        total: rf.total,
        good: rf.good,
        goodRate: rf.goodRate,
        neededHuman: rf.neededHuman,
      },
      handoffs: {
        openEscalations: overview.attention.openHandoffs,
        handoffRequested7d,
      },
    };
  }

  /** Per-department CSI averages from RESPONDED rows only (never invents OEM scores). */
  private satisfactionByKind(
    rows: Array<{ score: number | null; kind: string | null }>,
  ): Record<string, { average: number; count: number }> {
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      if (typeof row.score !== 'number') continue;
      const key = row.kind ?? 'SALES';
      const list = buckets.get(key) ?? [];
      list.push(row.score);
      buckets.set(key, list);
    }
    const out: Record<string, { average: number; count: number }> = {};
    for (const [kind, scores] of buckets) {
      out[kind] = {
        average:
          Math.round(
            (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
          ) / 10,
        count: scores.length,
      };
    }
    return out;
  }

  /**
   * AI missed-opportunity rollup from real queue + analytics counts (no synthetic scores).
   */
  async missedOpportunities(scope: Scope) {
    const [overview, queues] = await Promise.all([
      this.overview(scope),
      this.queues(scope),
    ]);
    const p = queues.prioritized;
    const prioritized = {
      unansweredInbound: p.unansweredInbound.length,
      aiUncertainReplies: p.aiUncertain.length,
      overdueLeads: p.overdueLeads.length,
      missedAppointments: p.missedAppointments.length,
      partsOpen: overview.attention.partsOpen,
      financeOpen: overview.attention.financeOpen,
    };
    const aiMissSignals = {
      zeroInventoryResults: overview.aiQuality.inventoryMisses,
      knowledgeMiss: overview.aiQuality.knowledgeMisses,
      unansweredInbound: prioritized.unansweredInbound,
    };
    const prioritizedTotal = Object.values(prioritized).reduce(
      (a, b) => a + b,
      0,
    );
    const analyticsMissTotal =
      aiMissSignals.zeroInventoryResults + aiMissSignals.knowledgeMiss;

    return {
      window: overview.window,
      since: overview.since,
      prioritized,
      aiMissSignals,
      totals: {
        prioritizedQueueItems: prioritizedTotal,
        analyticsMissEvents: analyticsMissTotal,
        combinedAttention: prioritizedTotal + analyticsMissTotal,
      },
      note: 'Counts from persisted queues and analytics events only.',
    };
  }

  /**
   * Recent knowledge_miss analytics for manager triage — persisted events only (no PII).
   */
  async recentKnowledgeMisses(scope: Scope) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await this.prisma.analyticsEvent.findMany({
      where: {
        tenantId: scope.tenantId,
        ...this.loc(scope),
        eventType: 'knowledge_miss',
        occurredAt: { gte: since },
      },
      orderBy: { occurredAt: 'desc' },
      take: 20,
      select: {
        id: true,
        occurredAt: true,
        locationId: true,
        properties: true,
      },
    });
    return {
      window: '7d',
      since: since.toISOString(),
      total: rows.length,
      events: rows.map((e) => ({
        id: e.id,
        occurredAt: e.occurredAt,
        locationId: e.locationId,
        kbHits:
          typeof (e.properties as { count?: unknown } | null)?.count ===
          'number'
            ? (e.properties as { count: number }).count
            : 0,
      })),
      note: 'Analytics events only — no customer message text or contact identifiers.',
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
    const [metaInboxReceived, metaInboxFailed] = await Promise.all([
      this.prisma.webhookInbox.count({
        where: {
          tenantId: scope.tenantId,
          provider: IntegrationProvider.META,
          status: WebhookInboxStatus.RECEIVED,
        },
      }),
      this.prisma.webhookInbox.count({
        where: {
          tenantId: scope.tenantId,
          provider: IntegrationProvider.META,
          status: WebhookInboxStatus.FAILED,
        },
      }),
    ]);
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
        /** Honest omnichannel adapter status — never implies live delivery. */
        channels: listChannelAdapterStatuses(),
      },
      errorMonitoring: { sentryConfigured: !!process.env.SENTRY_DSN },
      crmWebhook: {
        configured: !!process.env.CRM_WEBHOOK_URL,
        signed: !!process.env.CRM_WEBHOOK_SIGNING_SECRET,
      },
      metaLeadAds: {
        inbox: {
          pendingMaterialization: metaInboxReceived,
          failed: metaInboxFailed,
        },
        webhookIntakeConfigured: !!(
          process.env.META_APP_SECRET?.trim() &&
          process.env.META_LEAD_WEBHOOK_TENANT_ID?.trim()
        ),
        graphAccessTokenConfigured:
          !!process.env.META_GRAPH_ACCESS_TOKEN?.trim(),
        note: 'Webhook intake stores signed leadgen events in WebhookInbox only. Materializer is fail-closed (no invented PII); META_GRAPH_ACCESS_TOKEN is required to fetch full field_data from Graph.',
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
            ? {
                maxMarketingPer24h: Math.max(
                  0,
                  Math.min(20, q.maxMarketingPer24h),
                ),
              }
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

    // Negative teaching signals → DRAFT Studio coaching playbook (never auto-publish).
    const coaching = this.coachingFromFeedback(input.label, input.note);
    let draftPlaybookId: string | null = null;
    if (coaching && c.locationId) {
      const locationScope = c.locationId;
      const key = 'staff-feedback-coaching';
      const latest = await this.prisma.conversationPlaybook.findFirst({
        where: { tenantId: scope.tenantId, locationScope, key },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const draft = await this.prisma.conversationPlaybook
        .create({
          data: {
            tenantId: scope.tenantId,
            locationId: c.locationId,
            locationScope,
            key,
            title: `Staff feedback: ${input.label}`,
            department: 'GENERAL',
            status: 'DRAFT',
            version: (latest?.version ?? 0) + 1,
            tone: coaching.tone,
            brevity: coaching.brevity,
            oneQuestion: true,
            allowRapport: false,
            coachingNotes: coaching.notes,
            examples: coaching.examples as Prisma.InputJsonValue,
            createdBy: userId,
          },
        })
        .catch(() => null);
      draftPlaybookId = draft?.id ?? null;
      if (draftPlaybookId) {
        await this.prisma.analyticsEvent
          .create({
            data: {
              tenantId: scope.tenantId,
              locationId: c.locationId,
              eventType: 'studio.feedback_draft_created',
              conversationExternalKey: c.externalKey,
              properties: {
                playbookId: draftPlaybookId,
                label: input.label,
              },
            },
          })
          .catch(() => null);
      }
    }

    return {
      ok: true as const,
      label: input.label,
      draftPlaybookId,
    };
  }

  /** Map staff feedback labels into draft coaching hints — never published automatically. */
  private coachingFromFeedback(
    label: string,
    note?: string,
  ): {
    tone: string;
    brevity: string;
    notes: string;
    examples: Array<{ good: string; bad: string; note?: string }>;
  } | null {
    const tip = note?.trim().slice(0, 400);
    const map: Record<
      string,
      {
        tone: string;
        brevity: string;
        notes: string;
        examples: Array<{ good: string; bad: string; note?: string }>;
      }
    > = {
      too_long: {
        tone: 'concise',
        brevity: 'short',
        notes: `Staff flagged a reply as too long. Keep answers to one or two useful sentences.${tip ? ` Note: ${tip}` : ''}`,
        examples: [
          {
            good: 'We have two that match. Want to see both?',
            bad: 'Thank you so much for reaching out today! I would be more than happy to walk you through every option we currently have on the lot…',
            note: 'Prefer short answers',
          },
        ],
      },
      sounds_robotic: {
        tone: 'friendly',
        brevity: 'short',
        notes: `Staff flagged a robotic tone. Sound like a helpful dealership employee, not a script.${tip ? ` Note: ${tip}` : ''}`,
        examples: [
          {
            good: 'Got it — I can check that for you.',
            bad: "Absolutely! I'd be more than happy to assist you with that request today!",
            note: 'Natural phrasing',
          },
        ],
      },
      wrong_facts: {
        tone: 'concise',
        brevity: 'short',
        notes: `Staff flagged wrong facts. Only state verified inventory/hours/policy; otherwise say you will confirm.${tip ? ` Note: ${tip}` : ''}`,
        examples: [
          {
            good: "I don't want to guess on that — let me confirm with the team.",
            bad: 'Yes, that model is definitely in stock at that price.',
            note: 'Never invent dealership facts',
          },
        ],
      },
      wrong_question: {
        tone: 'concise',
        brevity: 'short',
        notes: `Staff flagged a bad follow-up question. Prefer waiting or asking only what moves the deal forward.${tip ? ` Note: ${tip}` : ''}`,
        examples: [
          {
            good: 'If you want, I can hold a time that works for you.',
            bad: 'What is your favorite color and do you also need winter tires today?',
            note: 'No mechanical discovery after every turn',
          },
        ],
      },
      needed_human: {
        tone: 'professional',
        brevity: 'short',
        notes: `Staff said a human was needed. Escalate sooner; do not keep probing.${tip ? ` Note: ${tip}` : ''}`,
        examples: [
          {
            good: 'I am connecting you with someone on our team who can help right away.',
            bad: 'Before I get a person, can you answer a few more questions?',
            note: 'Handoff promptly',
          },
        ],
      },
      unnecessary_weather_sports: {
        tone: 'concise',
        brevity: 'short',
        notes: `Staff flagged unnecessary weather/sports rapport. Skip small talk unless the customer invites it and data is verified.${tip ? ` Note: ${tip}` : ''}`,
        examples: [
          {
            good: 'We have that trim in stock. Want details?',
            bad: 'Hope you are enjoying this sunny day and the big game tonight!',
            note: 'Rapport only when appropriate',
          },
        ],
      },
    };
    return map[label] ?? null;
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
      roundRobinAssign: f.roundRobinAssign === true,
      automatedFollowup: f.automatedFollowup === true,
    };
  }

  /**
   * Store-level emergency switch + Conversation Studio toggles.
   * `chat:false` stops the assistant for this rooftop; `llmDisabled:true` keeps the
   * deterministic concierge but makes zero language-model calls.
   * `verboseReplies` / `contextualRapport` control reply length and optional rapport.
   * `roundRobinAssign` / `automatedFollowup` are owner opt-in ops flags (default off).
   * Does not enable smsAiReply, voiceAi, or mass marketing.
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
      roundRobinAssign?: boolean;
      automatedFollowup?: boolean;
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
      ...(typeof patch.roundRobinAssign === 'boolean'
        ? { roundRobinAssign: patch.roundRobinAssign }
        : {}),
      ...(typeof patch.automatedFollowup === 'boolean'
        ? { automatedFollowup: patch.automatedFollowup }
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
            roundRobinAssign: next.roundRobinAssign ?? null,
            automatedFollowup: next.automatedFollowup ?? null,
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
      roundRobinAssign: next.roundRobinAssign === true,
      automatedFollowup: next.automatedFollowup === true,
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
