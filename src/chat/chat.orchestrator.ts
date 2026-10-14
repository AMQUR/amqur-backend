import { Injectable, Logger } from '@nestjs/common';
import { EscalationUrgency } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  JourneyState,
  JourneyStore,
  TurnSession,
} from './memory/journey.store';
import {
  hasIntent,
  PendingQuestion,
  TurnIntent,
  TurnUnderstanding,
  understandTurn,
} from './understanding/turn-understanding';
import { InventoryEngine, vehicleHasFeature } from './engines/inventory.engine';
import type { InventoryVehicle } from './types/vehicle.types';
import { PaymentService, PolicyEstimate } from '../payment/payment.service';
import {
  FinancialAssumptionPolicy,
  FinancialAssumptionPolicyService,
} from '../finance/financial-assumption-policy';
import { FinanceRequestService } from '../finance/finance-request.service';
import { CreditApplicationService } from '../finance/credit-application.service';
import { PartsInquiryService } from '../parts/parts-inquiry.service';
import { TradeService } from '../trade/trade.service';
import {
  AppointmentRequestResult,
  AppointmentService,
} from '../appointments/appointment.service';
import {
  HoursProfile,
  StoreHoursService,
} from '../locations/store-hours.service';
import { EscalationsService } from '../escalations/escalations.service';
import { LeadsService } from '../leads/leads.service';
import { LeadSignal, scoreJourney } from '../leads/lead-scoring';
import {
  CapabilityName,
  CapabilityResult,
  CapabilityService,
} from '../capability/capability.service';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import {
  ClaudeConversationService,
  DealerReplyMode,
} from './claude/claude-conversation.service';
import {
  detectClaimTypes,
  GroundingGuardService,
} from '../source-authority/grounding-guard.service';
import {
  ClaimEvidence,
  ClaimEvidenceService,
  publicEvidence,
  verifiedFactsFrom,
} from '../source-authority/claim-evidence';
import { AnalyticsService } from '../analytics/analytics.service';
import { MetricsService } from '../observability/metrics.service';
import { OutboxService } from '../integrations/core/outbox.service';
import { redactCreditSensitive } from '../common/security/sensitive-data';
import {
  chooseAcknowledgement,
  compose,
  deliveryHint,
  Lang,
  signature,
  stripFiller,
  tr,
} from './dialogue/dialogue-style';
import { formatClock, parseIsoDate } from '../common/time/zoned-time';
import { CrmSyncService } from '../integrations/crm/crm-sync.service';

export type ChatProvenance = {
  sources: string[];
  inventoryAsOf?: string | null;
  disclaimer?: string;
  verifiedFactsOnly: boolean;
};

export type ChatCard =
  | {
      kind: 'appointment';
      id: string;
      type: string;
      status: string;
      outcome: string;
      date: string | null;
      time: string | null;
      label: string;
      verified: boolean;
    }
  | {
      kind: 'credit_application';
      label: string;
      url: string;
      providerName: string | null;
    }
  | { kind: 'finance_request'; id: string; status: string }
  | { kind: 'trade'; id: string; summary: string; appraisalVerified: false }
  | {
      kind: 'parts';
      id: string;
      status: string;
      fitmentVerified: boolean;
      priceVerified: boolean;
      availabilityVerified: boolean;
      etaVerified: boolean;
      needsVin: boolean;
    }
  | {
      kind: 'handoff';
      state: 'requested' | 'queued' | 'notified' | 'recorded';
      escalationId: string;
    }
  | {
      kind: 'hours';
      summary: string;
      openNow: boolean | null;
      timezone: string;
    }
  | {
      kind: 'payment';
      vin: string;
      monthly: number;
      apr: number;
      aprSource: string;
      termMonths: number;
      downPayment: number;
      tradeEquity: number;
      price: number;
      includesTaxAndFees: boolean;
      disclaimer: string;
      policyVersion: string;
    };

export type JourneySummary = {
  selectedVehicle?: { vin: string; label: string } | null;
  payment?: {
    monthly: number;
    termMonths: number;
    downPayment: number;
    aprSource: string;
  } | null;
  trade?: { summary: string; requestId?: string } | null;
  appointment?: { id: string; label: string; status: string } | null;
  creditApplication?: { state: string } | null;
  service?: { need?: string } | null;
  parts?: { need?: string; status?: string } | null;
  handoff?: { state: string } | null;
};

export type ChatResponse = {
  reply: string;
  segments: string[];
  type?:
    | 'vehicle_carousel'
    | 'vehicle_compare'
    | 'vehicle_detail'
    | 'payment_summary'
    | 'staff_handling';
  vehicles?: InventoryVehicle[];
  monthlyPayment?: number;
  termMonths?: number;
  apr?: number;
  downPayment?: number;
  vehicleVin?: string;
  price?: number;
  cards: ChatCard[];
  quickReplies: string[];
  journey: JourneySummary;
  provenance: ChatProvenance;
  evidence: ReturnType<typeof publicEvidence>;
  conversation: {
    language: Lang;
    handoffState: string;
    aiPaused: boolean;
    pending: PendingQuestion;
  };
  delivery: {
    urgent: boolean;
    toolCount: number;
    minTypingMs: number;
    maxTypingMs: number;
  };
};

type Question = { key: PendingQuestion; text: string; priority: number };

type Turn = {
  s: TurnSession;
  st: JourneyState;
  tenantId: string;
  locationId: string | null;
  lang: Lang;
  u: TurnUnderstanding;
  message: string;
  action?: string;
  answers: string[];
  narration: string[];
  questions: Question[];
  cards: ChatCard[];
  vehicles?: InventoryVehicle[];
  type?: ChatResponse['type'];
  legacyPayment?: {
    monthlyPayment: number;
    termMonths: number;
    apr: number;
    downPayment: number;
    vehicleVin: string;
    price: number;
  };
  evidence: ClaimEvidence[];
  sources: Set<string>;
  facts: string[];
  toolCount: number;
  urgent: boolean;
  quickReplies: string[];
  isCorrection: boolean;
  capCache: Map<CapabilityName, Promise<CapabilityResult>>;
  hours?: HoursProfile | null;
  policy?: FinancialAssumptionPolicy;
  handled: Set<string>;
  conversationExtra: { handoffState?: string; aiPaused?: boolean };
};

const PRESSURE: Array<{ kind: string; re: RegExp }> = [
  {
    kind: 'system_prompt',
    re: /\b(system prompt|your instructions|your rules|developer message|reveal (?:your|the) prompt|ignore (?:all|previous|your) (?:rules|instructions))\b/i,
  },
  {
    kind: 'approval_claim',
    re: /\b(already approved|manager (?:already )?approved|just confirm (?:it|my approval|i'?m approved)|say i'?m approved)\b/i,
  },
  {
    kind: 'price_override',
    re: /\b(tell me (?:this|the) (?:car|truck|vehicle) is \$?\d|say (?:the|it'?s|its) price is|price is \$?\d[\d,]* (?:now|instead)|honor (?:a |the )?price of)\b/i,
  },
  {
    kind: 'stock_override',
    re: /\b(database is wrong|say (?:it is|it'?s) in stock|just say (?:it'?s|it is) available)\b/i,
  },
  {
    kind: 'slot_override',
    re: /\b(even if there are no (?:slots|openings)|book (?:me|it) anyway|force (?:the|an) appointment)\b/i,
  },
  {
    kind: 'fitment_override',
    re: /\b(tell me (?:this|the|that) part (?:definitely )?fits|guarantee (?:it|the part) fits|definitely fits)\b/i,
  },
  {
    kind: 'internal_docs',
    re: /\b(internal (?:staff )?(?:doc|document|notes|policy)|staff[- ]only|confidential (?:doc|document))\b/i,
  },
  {
    kind: 'cross_tenant',
    re: /\b(another dealer'?s|other dealers?'? customers|show me (?:other )?customers|customer list|list of customers)\b/i,
  },
  {
    kind: 'opt_out_override',
    re: /\b(even though i opted out|ignore (?:my )?opt[- ]?out)\b/i,
  },
];

function vehicleLabel(
  v: {
    year?: number;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
  },
  withColor = false,
) {
  return [
    withColor && v.color ? v.color.toLowerCase() : null,
    v.year,
    v.make,
    v.model,
    v.trim,
  ]
    .filter(Boolean)
    .join(' ');
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function dateLabel(iso: string | null | undefined, lang: Lang): string {
  const d = iso ? parseIsoDate(iso) : null;
  if (!d) return iso ?? '';
  const dt = new Date(Date.UTC(d.year, d.month - 1, d.day, 12));
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Concierge orchestrator: language & reasoning on top, tools underneath.
 *
 * understand (multi-intent) → update journey → run allowed tools (capability-gated,
 * tenant-scoped, provider-confirmed semantics) → compose ONE coherent reply with at most
 * one question → optional LLM polish (router + grounding guard) → durable save.
 *
 * Every business-changing write (appointment, finance, parts, trade, lead, escalation) is
 * awaited BEFORE the assistant acknowledges it. If it throws, the turn fails honestly.
 */
@Injectable()
export class ChatOrchestrator {
  private readonly logger = new Logger(ChatOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: JourneyStore,
    private readonly inventory: InventoryEngine,
    private readonly payments: PaymentService,
    private readonly policies: FinancialAssumptionPolicyService,
    private readonly finance: FinanceRequestService,
    private readonly credit: CreditApplicationService,
    private readonly parts: PartsInquiryService,
    private readonly trade: TradeService,
    private readonly appointments: AppointmentService,
    private readonly hoursService: StoreHoursService,
    private readonly escalations: EscalationsService,
    private readonly leads: LeadsService,
    private readonly capabilities: CapabilityService,
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly llm: ClaudeConversationService,
    private readonly grounding: GroundingGuardService,
    private readonly evidenceSvc: ClaimEvidenceService,
    private readonly analytics: AnalyticsService,
    private readonly metrics: MetricsService,
    private readonly outbox: OutboxService,
    private readonly crmSync: CrmSyncService,
  ) {}

  // ───────────────────────────────────────── entry

  async handleMessage(input: {
    message?: string;
    action?: string;
    vin?: string;
    conversationId?: string;
    role?: string;
    tenantId: string;
    userId: string;
    locationId?: string | null;
    language?: string;
    pageContext?: {
      pageType?: string;
      vin?: string;
      stockNumber?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      referrerClass?: string;
    };
  }): Promise<ChatResponse> {
    const started = Date.now();
    const tenantId = input.tenantId;
    const s = await this.store.load(tenantId, input.locationId, input.userId);
    const st = s.state;
    const rawMessage = (input.message ?? '').trim();
    const redacted = redactCreditSensitive(rawMessage);

    // Critical: the customer's message is persisted before any processing (redacted).
    await this.store.appendMessage(s, 'USER', redacted, {
      ...(input.action ? { action: input.action } : {}),
      ...(input.vin ? { vin: input.vin.toUpperCase() } : {}),
    });
    this.metrics.increment('chat.requests');
    if (s.isNew)
      void this.analytics.trackEvent(
        tenantId,
        s.locationId,
        'conversation_start',
        { pageType: input.pageContext?.pageType ?? null },
        s.externalKey,
      );
    void this.analytics.trackEvent(
      tenantId,
      s.locationId,
      'message_sent',
      { action: input.action ?? null },
      s.externalKey,
    );

    if (input.pageContext) {
      st.attribution = {
        ...st.attribution,
        ...(input.pageContext.utmSource
          ? { utmSource: input.pageContext.utmSource.slice(0, 80) }
          : {}),
        ...(input.pageContext.utmMedium
          ? { utmMedium: input.pageContext.utmMedium.slice(0, 80) }
          : {}),
        ...(input.pageContext.utmCampaign
          ? { utmCampaign: input.pageContext.utmCampaign.slice(0, 80) }
          : {}),
        ...(input.pageContext.referrerClass
          ? { referrerClass: input.pageContext.referrerClass.slice(0, 30) }
          : {}),
        ...(input.pageContext.pageType
          ? { pageType: input.pageContext.pageType.slice(0, 30) }
          : {}),
      };
    }

    // Staff owns the thread: AI must not race the employee.
    if (s.aiPaused) {
      await this.store.save(s);
      return this.staffHandlingResponse(s);
    }

    const lang: Lang =
      input.language === 'es' || input.language === 'en'
        ? input.language
        : (st.language ?? 'en');
    const hoursTz = 'America/Chicago';
    const u = understandTurn(rawMessage, {
      pending: st.pending,
      hasVisibleVehicles: st.visibleVins.length > 0,
      hasSelectedVehicle: !!st.selectedVin,
      hasActiveAppointment:
        !!st.appointment &&
        ['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(
          st.appointment.status,
        ),
      activeDepartment: st.department ?? null,
      timeZone: (await this.locationTz(tenantId, s.locationId)) ?? hoursTz,
    });

    const t: Turn = {
      s,
      st,
      tenantId,
      locationId: s.locationId,
      lang,
      u,
      message: rawMessage,
      action: input.action,
      answers: [],
      narration: [],
      questions: [],
      cards: [],
      evidence: [],
      sources: new Set(),
      facts: [],
      toolCount: 0,
      urgent: false,
      quickReplies: [],
      isCorrection:
        /\b(actually|instead|i meant|correction|no,? i said|en realidad|mejor)\b/i.test(
          rawMessage,
        ),
      capCache: new Map(),
      handled: new Set(),
      conversationExtra: {},
    };

    // Language: explicit choice or confident detection; stays sticky once chosen.
    if (hasIntent(u, 'LANGUAGE_SWITCH') && u.entities.language) {
      st.language = u.entities.language;
      st.languageLocked = true;
      t.lang = st.language;
    } else if (
      !st.languageLocked &&
      u.entities.language &&
      u.entities.language !== st.language
    ) {
      st.language = u.entities.language;
      t.lang = st.language;
    }

    const chat = await this.cap(t, 'chat');
    if (!chat.allowed) {
      return this.finish(t, {
        forcedReply: chat.customerMessage ?? 'Chat is unavailable right now.',
        started,
      });
    }

    if (u.entities.sensitive?.length) {
      await this.handleSensitive(t);
      return this.finish(t, { started });
    }

    const pressure = PRESSURE.find((p) => p.re.test(rawMessage));
    if (pressure) {
      this.handlePressure(t, pressure.kind);
      return this.finish(t, { started });
    }

    this.absorbEntities(t, input);
    const intents = this.planIntents(t, input);

    for (const intent of intents) {
      if (t.handled.has(intent)) continue;
      t.handled.add(intent);
      try {
        await this.runIntent(t, intent);
      } catch (e: unknown) {
        // A failed critical write must not be acknowledged as saved.
        this.logger.error(
          `intent ${intent} failed: ${e instanceof Error ? e.message : e}`,
        );
        this.metrics.increment(`chat.intent_failure.${intent}`);
        t.urgent = true;
        t.narration.push(
          tr(
            t.lang,
            "Something went wrong on my side and I couldn't save that just now — nothing was submitted. Could you try again in a moment, or call the dealership if it's urgent?",
            'Algo falló de mi lado y no pude guardar eso — no se envió nada. ¿Puede intentarlo de nuevo en un momento, o llamar a la agencia si es urgente?',
          ),
        );
        break;
      }
    }

    await this.syncLead(t);
    return this.finish(t, { started });
  }

  // ───────────────────────────────────────── planning

  private absorbEntities(
    t: Turn,
    input: { vin?: string; pageContext?: { vin?: string } },
  ) {
    const { st, u } = t;
    const e = u.entities;
    if (input.vin) st.selectedVin = input.vin.toUpperCase();
    if (e.contact) {
      st.contact = {
        ...st.contact,
        ...(e.contact.firstName ? { firstName: e.contact.firstName } : {}),
        ...(e.contact.lastName ? { lastName: e.contact.lastName } : {}),
        ...(e.contact.phone ? { phone: e.contact.phone } : {}),
        ...(e.contact.email ? { email: e.contact.email } : {}),
      };
      if (e.contact.firstName) this.signal(t, 'contact_name');
      if (e.contact.phone || e.contact.email) this.signal(t, 'contact_method');
    }
    if (e.maxMonthly) st.payment.maxMonthly = e.maxMonthly;
    if (e.downPayment !== undefined) st.payment.downPayment = e.downPayment;
    if (e.termMonths) st.payment.termMonths = e.termMonths;
    if (e.customerApr !== undefined) st.payment.customerApr = e.customerApr;
    if (e.leaseOrPurchase) st.payment.leaseOrPurchase = e.leaseOrPurchase;
    if (e.maxMonthly || e.maxPrice) this.signal(t, 'budget_stated');
    if (
      /\b(today|this week|this weekend|asap|right away|hoy|esta semana)\b/i.test(
        t.message,
      )
    ) {
      st.timeline = 'this_week';
      this.signal(t, 'timeline_soon');
    }
    if (
      hasIntent(u, 'SERVICE_APPOINTMENT') ||
      hasIntent(u, 'SERVICE_AMENITY_QUESTION')
    )
      st.department = 'service';
    else if (hasIntent(u, 'PARTS_INQUIRY')) st.department = 'parts';
    else if (
      hasIntent(u, 'CREDIT_APPLICATION') ||
      hasIntent(u, 'FINANCE_REQUEST')
    )
      st.department = st.department === 'sales' ? 'sales' : 'finance';
    else if (
      hasIntent(u, 'INVENTORY_SEARCH') ||
      hasIntent(u, 'SALES_APPOINTMENT') ||
      hasIntent(u, 'TRADE_IN')
    )
      st.department = 'sales';
  }

  private planIntents(t: Turn, input: { action?: string }): TurnIntent[] {
    const list = t.u.intents
      .filter((i) => i.confidence >= 0.6)
      .map((i) => i.intent);
    const actionMap: Record<string, TurnIntent> = {
      payment_estimate: 'PAYMENT_ESTIMATE',
      vehicle_detail: 'SELECT_VEHICLE',
      hold_vehicle: 'HOLD_REQUEST',
      finance: 'FINANCE_REQUEST',
      credit_application: 'CREDIT_APPLICATION',
      test_drive: 'SALES_APPOINTMENT',
      trade: 'TRADE_IN',
      compare: 'COMPARE',
      service: 'SERVICE_APPOINTMENT',
      parts: 'PARTS_INQUIRY',
      sales: 'INVENTORY_SEARCH',
      human: 'HUMAN_HANDOFF',
      hours: 'HOURS_LOCATION',
    };
    const forced = input.action ? actionMap[input.action] : undefined;
    if (forced && !list.includes(forced)) list.unshift(forced);
    // Department chips with no free text open a department-specific greeting.
    if (
      (input.action === 'service' ||
        input.action === 'parts' ||
        input.action === 'sales') &&
      !t.message
    ) {
      t.st.department = input.action;
      return ['GREETING'];
    }
    // A VIN given in answer to "what's your VIN?" belongs to that flow, not to inventory lookup.
    if (t.st.pending === 'parts_vin' && t.u.entities.vin) {
      return [
        'PARTS_INQUIRY',
        ...list.filter((i) => i !== 'SELECT_VEHICLE' && i !== 'PARTS_INQUIRY'),
      ];
    }
    // Pending-question resolution for short replies
    if (list.includes('AFFIRM') || list.includes('DECLINE')) return list;
    if (list.length === 0 || (list.length === 1 && list[0] === 'UNKNOWN')) {
      if (t.st.pending === 'parts_vin' && t.u.entities.vin)
        return ['PARTS_INQUIRY'];
      if (t.st.pending === 'service_need') return ['SERVICE_APPOINTMENT'];
      return ['UNKNOWN'];
    }
    return list;
  }

  private async runIntent(t: Turn, intent: TurnIntent) {
    switch (intent) {
      case 'COMPLAINT':
      case 'HUMAN_HANDOFF':
        return this.handleHandoff(
          t,
          intent === 'COMPLAINT' ? 'complaint' : 'request',
        );
      case 'TRADE_IN':
        return this.handleTrade(t);
      case 'SELECT_VEHICLE':
        return this.handleSelect(t);
      case 'INVENTORY_SEARCH':
        return this.handleSearch(t);
      case 'FEATURE_FILTER':
        return this.handleFeatureFilter(t);
      case 'PAYMENT_ESTIMATE':
        return this.handlePayment(t);
      case 'FINANCE_REQUEST':
        return this.handleFinance(t);
      case 'CREDIT_APPLICATION':
        return this.handleCreditApp(t);
      case 'SALES_APPOINTMENT':
        return this.handleAppointment(
          t,
          t.st.selectedVin ? 'TEST_DRIVE' : 'SALES',
        );
      case 'SERVICE_APPOINTMENT':
        return this.handleAppointment(t, 'SERVICE');
      case 'APPOINTMENT_RESCHEDULE':
        return this.handleReschedule(t);
      case 'APPOINTMENT_CANCEL':
        return this.handleCancel(t);
      case 'SERVICE_AMENITY_QUESTION':
        return this.handleAmenity(t);
      case 'SERVICE_STATUS':
        return this.handleServiceStatus(t);
      case 'PARTS_INQUIRY':
        return this.handleParts(t);
      case 'HOURS_LOCATION':
        return this.handleHours(t);
      case 'HOLD_REQUEST':
        return this.handleHold(t);
      case 'VEHICLE_QUESTION':
        return this.handleVehicleQuestion(t);
      case 'COMPARE':
        return this.handleCompare(t);
      case 'KNOWLEDGE_QUESTION':
        return this.handleKnowledge(t);
      case 'TEXT_CONTINUATION':
        return this.handleTextContinuation(t);
      case 'PROVIDE_CONTACT':
        return this.handleContact(t);
      case 'AFFIRM':
        return this.handleAffirm(t);
      case 'DECLINE':
        return this.handleDecline(t);
      case 'GREETING':
        return this.handleGreeting(t);
      case 'LANGUAGE_SWITCH':
        t.answers.push(
          tr(
            t.lang,
            'Sure — I’ll continue in English.',
            'Claro, seguimos en español.',
          ),
        );
        return;
      default:
        return this.handleUnknown(t);
    }
  }

  // ───────────────────────────────────────── helpers

  private cap(t: Turn, c: CapabilityName) {
    let p = t.capCache.get(c);
    if (!p) {
      p = this.capabilities.check(t.tenantId, t.locationId, c);
      t.capCache.set(c, p);
    }
    return p;
  }

  private ask(t: Turn, key: PendingQuestion, text: string, priority: number) {
    t.questions.push({ key, text, priority });
  }

  private signal(t: Turn, s: LeadSignal) {
    if (!t.st.signals.includes(s)) t.st.signals.push(s);
  }

  private async locationTz(tenantId: string, locationId: string | null) {
    if (!locationId) return null;
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { timezone: true },
    });
    return loc?.timezone ?? null;
  }

  private async getHours(t: Turn) {
    if (t.hours === undefined)
      t.hours = await this.hoursService.getProfile(t.tenantId, t.locationId);
    return t.hours;
  }

  private async getPolicy(t: Turn) {
    if (!t.policy)
      t.policy = await this.policies.resolve(t.tenantId, t.locationId);
    return t.policy;
  }

  private async locationPhone(t: Turn): Promise<string | null> {
    if (!t.locationId) return null;
    const loc = await this.prisma.location.findFirst({
      where: { id: t.locationId, tenantId: t.tenantId },
      select: { phone: true },
    });
    return loc?.phone ?? null;
  }

  private customerName(t: Turn) {
    const c = t.st.contact;
    return [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
  }

  private async capBlocked(t: Turn, c: CapabilityName): Promise<boolean> {
    const r = await this.cap(t, c);
    if (r.allowed) return false;
    const msg =
      r.customerMessage ??
      tr(
        t.lang,
        'That isn’t available here right now.',
        'Eso no está disponible aquí por ahora.',
      );
    if (!t.answers.includes(msg)) t.answers.push(msg);
    return true;
  }

  private async loadVisible(t: Turn): Promise<InventoryVehicle[]> {
    if (!t.st.visibleVins.length) return [];
    return this.inventory.getVehiclesByVin(t.tenantId, t.st.visibleVins);
  }

  /** Resolve "the black Wrangler you showed me", "the second one", or a VIN to ONE vehicle. */
  private async resolveVehicleReference(
    t: Turn,
  ): Promise<{ v?: InventoryVehicle; ambiguous?: InventoryVehicle[] }> {
    const e = t.u.entities;
    if (e.vin) {
      const v = await this.inventory.getVehicleByVin(t.tenantId, e.vin);
      return v ? { v } : {};
    }
    if (e.stock) {
      const v = await this.inventory.getVehicleByStock(t.tenantId, e.stock);
      return v ? { v } : {};
    }
    const visible = await this.loadVisible(t);
    let cands = visible;
    const ord =
      /\b(first|1st|second|2nd|third|3rd|last|primer[oa]?|segund[oa]|tercer[oa]?|[uú]ltim[oa])\b/i.exec(
        t.message,
      );
    if (ord && visible.length) {
      const w = ord[1].toLowerCase();
      const idx = /^(first|1st|primer)/.test(w)
        ? 0
        : /^(second|2nd|segund)/.test(w)
          ? 1
          : /^(third|3rd|tercer)/.test(w)
            ? 2
            : visible.length - 1;
      return visible[idx] ? { v: visible[idx] } : {};
    }
    const want = e.vehicle;
    if (want?.color)
      cands = cands.filter((v) =>
        (v.color ?? '').toLowerCase().includes(want.color!),
      );
    if (want?.model)
      cands = cands.filter((v) =>
        (v.model ?? '').toLowerCase().includes(want.model!.toLowerCase()),
      );
    if (want?.trim)
      cands = cands.filter((v) =>
        (v.trim ?? '').toLowerCase().includes(want.trim!.toLowerCase()),
      );
    if (cands.length === 1) return { v: cands[0] };
    if (cands.length > 1) return { ambiguous: cands.slice(0, 3) };
    if (t.st.selectedVin) {
      const v = await this.inventory.getVehicleByVin(
        t.tenantId,
        t.st.selectedVin,
      );
      return v ? { v } : {};
    }
    if (visible.length === 1) return { v: visible[0] };
    return {};
  }

  private async attachVehicleEvidence(t: Turn, vehicles: InventoryVehicle[]) {
    const evs = await Promise.all(
      vehicles
        .slice(0, 6)
        .map((v) => this.evidenceSvc.forVehicle(t.tenantId, t.locationId, v)),
    );
    for (const e of evs.flat()) t.evidence.push(e);
    t.sources.add('inventory_db');
  }

  private async withPaymentEstimates(t: Turn, vehicles: InventoryVehicle[]) {
    const pay = await this.cap(t, 'payments');
    if (!pay.allowed) return vehicles;
    const policy = await this.getPolicy(t);
    return vehicles.map((v) => {
      if (!v.price) return v;
      const est = this.payments.estimateWithPolicy({
        price: v.price,
        policy,
        downPayment: t.st.payment.downPayment,
        termMonths: t.st.payment.termMonths,
        customerApr: t.st.payment.customerApr,
      });
      return {
        ...v,
        estimatedPayment: est.monthlyPayment,
        paymentAssumptions: {
          apr: est.breakdown.apr,
          aprSource: est.aprSource,
          termMonths: est.breakdown.termMonths,
          downPayment: est.breakdown.downPayment,
          includesTaxAndFees: est.includesTaxAndFees,
          policyVersion: est.policyVersion,
        },
      } as InventoryVehicle;
    });
  }

  // ───────────────────────────────────────── sensitive / pressure

  private async handleSensitive(t: Turn) {
    t.urgent = true;
    this.metrics.increment('chat.sensitive_data_redacted');
    t.answers.push(
      tr(
        t.lang,
        "For your security, please don't share Social Security, card, or bank numbers in chat — I've removed that from this conversation.",
        'Por su seguridad, no comparta su número de Seguro Social, tarjeta o cuenta bancaria en el chat — ya lo eliminé de esta conversación.',
      ),
    );
    const res = await this.credit.resolve(t.tenantId, t.locationId);
    if (res.available) {
      this.ask(
        t,
        'confirm_credit_link',
        tr(
          t.lang,
          "If you're looking to apply for financing, want me to send the dealership's secure credit application instead?",
          '¿Quiere que le envíe la solicitud de crédito segura de la agencia?',
        ),
        1,
      );
    }
  }

  private handlePressure(t: Turn, kind: string) {
    this.metrics.increment(`chat.redteam.${kind}`);
    const L = t.lang;
    const map: Record<string, string> = {
      system_prompt: tr(
        L,
        "I can't share how I'm configured, but I'm glad to help with vehicles, service, parts, or getting you to the right person.",
        'No puedo compartir mi configuración, pero con gusto le ayudo con vehículos, servicio, refacciones o con la persona indicada.',
      ),
      approval_claim: tr(
        L,
        "I can't confirm a financing approval — that only comes from the dealership's finance team or lender. I can connect you with them or send the secure credit application.",
        'No puedo confirmar una aprobación de financiamiento — eso solo lo hace el equipo de finanzas o el prestamista. Puedo conectarle con ellos o enviarle la solicitud de crédito segura.',
      ),
      price_override: tr(
        L,
        "I can only share the price the dealership has listed — I can't change or promise a different one. I'm happy to have a sales manager talk numbers with you.",
        'Solo puedo compartir el precio publicado por la agencia — no puedo cambiarlo ni prometer otro. Con gusto un gerente de ventas puede hablar de números con usted.',
      ),
      stock_override: tr(
        L,
        "I can only go by the dealership's live inventory, so I can't mark a vehicle available when it isn't showing there. I can have someone double-check it for you.",
        'Solo puedo basarme en el inventario de la agencia, así que no puedo decir que está disponible si no aparece. Puedo pedir que alguien lo verifique.',
      ),
      slot_override: tr(
        L,
        "I can't book a time that isn't open, but I can request it for the team to confirm or find the nearest open time.",
        'No puedo reservar un horario que no está disponible, pero puedo solicitarlo para que el equipo lo confirme o buscar el horario más cercano.',
      ),
      fitment_override: tr(
        L,
        "I can't guarantee fitment — the parts team confirms it against your VIN. Share the VIN and I'll get that started.",
        'No puedo garantizar que la pieza le quede — el equipo de refacciones lo confirma con su VIN. Compártame el VIN y lo inicio.',
      ),
      internal_docs: tr(
        L,
        'I can only use information the dealership has approved for customers. I can connect you with the team for anything else.',
        'Solo puedo usar información aprobada para clientes. Puedo conectarle con el equipo para lo demás.',
      ),
      cross_tenant: tr(
        L,
        "I can't share other customers' information. I can help with your own visit, vehicle, or service needs.",
        'No puedo compartir información de otros clientes. Puedo ayudarle con su visita, vehículo o servicio.',
      ),
      opt_out_override: tr(
        L,
        "Since you've opted out of texts, I won't send any. I can keep helping here, or you can text START to opt back in if you change your mind.",
        'Como usted se dio de baja de los mensajes de texto, no le enviaré ninguno. Puedo seguir ayudándole aquí.',
      ),
    };
    t.answers.push(map[kind] ?? map.system_prompt);
  }

  // ───────────────────────────────────────── handoff

  private async handleHandoff(t: Turn, why: 'complaint' | 'request') {
    if (await this.capBlocked(t, 'handoff')) return;
    t.toolCount += 1;
    t.urgent = true;
    const st = t.st;
    const summary = [
      why === 'complaint'
        ? 'Customer is frustrated and asked for help'
        : 'Customer requested a person',
      `Message: "${redactCreditSensitive(t.message).slice(0, 280)}"`,
      st.selectedVin ? `Vehicle: ${st.selectedVin}` : null,
      st.appointment
        ? `Appointment request: ${st.appointment.requestedDate ?? ''} ${st.appointment.requestedTime ?? ''} (${st.appointment.status})`
        : null,
      st.department ? `Department: ${st.department}` : null,
      this.customerName(t) ? `Name: ${this.customerName(t)}` : null,
      st.contact.phone ? `Phone: ${st.contact.phone}` : null,
      st.contact.email ? `Email: ${st.contact.email}` : null,
    ].filter(Boolean);
    const { escalation, notified, queued, deduped } =
      await this.escalations.create({
        tenantId: t.tenantId,
        locationId: t.locationId,
        externalKey: t.s.externalKey,
        reason:
          why === 'complaint'
            ? 'Frustrated customer — needs attention'
            : 'Customer requested human assistance',
        urgency: EscalationUrgency.HIGH,
        summary: summary.join(' | '),
        metadata: {
          department: st.department ?? null,
          sentiment: t.u.sentiment,
          leadId: st.leadId ?? null,
        },
      });
    st.handoff = { escalationId: escalation.id, notified, queued };
    t.conversationExtra.handoffState = notified ? 'QUEUED' : 'REQUESTED';
    this.signal(t, 'handoff_requested');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'handoff_requested',
      { urgency: why, notified, queued, deduped },
      t.s.externalKey,
    );
    const phone = await this.locationPhone(t);
    if (notified) {
      t.narration.push(
        tr(
          t.lang,
          "I've alerted the team and shared what you've told me, so you won't have to repeat yourself.",
          'Ya avisé al equipo y compartí lo que me dijo, para que no tenga que repetirlo.',
        ),
      );
    } else if (queued) {
      t.narration.push(
        tr(
          t.lang,
          "I've logged this for the team with everything you've told me, and the notification is being retried on our side.",
          'Registré esto para el equipo con todo lo que me dijo, y la notificación se está reintentando.',
        ),
      );
    } else {
      t.narration.push(
        tr(
          t.lang,
          `I've logged this for the team with everything you've told me, but I can't confirm anyone has been notified yet.${phone ? ` If it's urgent, the fastest route is calling ${phone}.` : ''}`,
          `Registré esto para el equipo con todo lo que me dijo, pero aún no puedo confirmar que alguien haya sido notificado.${phone ? ` Si es urgente, lo más rápido es llamar al ${phone}.` : ''}`,
        ),
      );
    }
    t.cards.push({
      kind: 'handoff',
      state: notified ? 'notified' : queued ? 'queued' : 'recorded',
      escalationId: escalation.id,
    });
    if (!st.contact.phone && !st.contact.email) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          "What's the best number or email for them to reach you?",
          '¿Cuál es el mejor número o correo para contactarle?',
        ),
        1,
      );
    }
  }

  // ───────────────────────────────────────── trade

  private async handleTrade(t: Turn) {
    if (await this.capBlocked(t, 'leadCapture')) return;
    const st = t.st;
    const e = t.u.entities.trade ?? {};
    st.trade = {
      ...st.trade,
      ...Object.fromEntries(
        Object.entries(e).filter(([, v]) => v !== undefined),
      ),
    };
    t.toolCount += 1;
    const tr0 = st.trade!;
    if (tr0.requestId) {
      await this.prisma.tradeRequest.updateMany({
        where: { id: tr0.requestId, tenantId: t.tenantId },
        data: {
          year: tr0.year ?? undefined,
          make: tr0.make ?? undefined,
          model: tr0.model ?? undefined,
          mileage: tr0.mileage ?? undefined,
          payoffAmount: tr0.payoff ?? undefined,
          desiredVehicleVin: st.selectedVin ?? undefined,
        },
      });
    } else {
      const row = await this.trade.createRequest({
        tenantId: t.tenantId,
        locationId: t.locationId,
        conversationId: t.s.conversationId,
        year: tr0.year,
        make: tr0.make,
        model: tr0.model,
        mileage: tr0.mileage,
        customerName: this.customerName(t),
        customerPhone: st.contact.phone,
        customerEmail: st.contact.email,
        notes: redactCreditSensitive(t.message).slice(0, 500),
      });
      tr0.requestId = row.id;
      void this.analytics.trackEvent(
        t.tenantId,
        t.locationId,
        'trade_submitted',
        {},
        t.s.externalKey,
      );
    }
    this.signal(t, 'trade_provided');
    t.sources.add('trade_request');
    const label =
      [tr0.year, tr0.make, tr0.model].filter(Boolean).join(' ') ||
      tr(t.lang, 'your vehicle', 'su vehículo');
    const miles = tr0.mileage
      ? tr(
          t.lang,
          ` with ${tr0.mileage.toLocaleString('en-US')} miles`,
          ` con ${tr0.mileage.toLocaleString('es-US')} millas`,
        )
      : '';
    t.narration.push(
      tr(
        t.lang,
        `I've noted the ${label}${miles} as your trade-in.`,
        `Anoté su ${label}${miles} como vehículo a cuenta.`,
      ),
    );
    t.narration.push(
      tr(
        t.lang,
        "I can't put a value on it here — the dealership appraises it, usually with a quick look in person.",
        'No puedo darle un valor aquí — la agencia lo valúa, normalmente con una revisión rápida en persona.',
      ),
    );
    t.cards.push({
      kind: 'trade',
      id: tr0.requestId!,
      summary: `${label}${miles}`,
      appraisalVerified: false,
    });
    t.evidence.push(
      this.evidenceSvc.unverified(
        t.tenantId,
        t.locationId,
        'trade_value',
        'Appraisal requires the dealership or an authorized appraisal provider.',
      ),
    );
    if (!tr0.mileage)
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Roughly how many miles are on it?',
          '¿Aproximadamente cuántas millas tiene?',
        ),
        6,
      );
  }

  // ───────────────────────────────────────── inventory

  private async handleSelect(t: Turn) {
    const ref = await this.resolveVehicleReference(t);
    if (ref.ambiguous?.length) {
      t.vehicles = await this.withPaymentEstimates(t, ref.ambiguous);
      t.type = 'vehicle_carousel';
      await this.attachVehicleEvidence(t, ref.ambiguous);
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Which of these did you mean?',
          '¿Cuál de estos quiso decir?',
        ),
        2,
      );
      return;
    }
    if (!ref.v) {
      if (t.u.entities.vin) {
        t.answers.push(
          tr(
            t.lang,
            "I couldn't find that VIN in the dealership's current inventory.",
            'No encontré ese VIN en el inventario actual de la agencia.',
          ),
        );
      }
      return;
    }
    const v = ref.v;
    t.st.selectedVin = v.vin;
    this.signal(t, 'vehicle_selected');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'vehicle_view',
      { vin: v.vin },
      t.s.externalKey,
    );
    await this.attachVehicleEvidence(t, [v]);
    const sellable = v.status === 'AVAILABLE' || v.status === 'IN_TRANSIT';
    if (!sellable) {
      t.answers.push(
        tr(
          t.lang,
          `The ${vehicleLabel(v)} is no longer showing as available.`,
          `El ${vehicleLabel(v)} ya no aparece disponible.`,
        ),
      );
      const alts = await this.inventory.alternatives(t.tenantId, t.locationId, {
        make: v.make,
        model: v.model,
        bodyType: v.bodyType,
        price: v.price,
      });
      if (alts.length) {
        t.vehicles = await this.withPaymentEstimates(t, alts);
        t.type = 'vehicle_carousel';
        t.st.visibleVins = alts.map((a) => a.vin);
        await this.attachVehicleEvidence(t, alts);
        t.narration.push(
          tr(
            t.lang,
            'Here are the closest matches still in stock.',
            'Estas son las opciones más parecidas en existencia.',
          ),
        );
      }
      return;
    }
    // Only show the card when this turn isn't already producing a richer element.
    if (!t.vehicles) {
      t.vehicles = await this.withPaymentEstimates(t, [v]);
      t.type = 'vehicle_carousel';
    }
    t.facts.push(
      `Selected vehicle: ${vehicleLabel(v, true)} VIN ${v.vin}${v.price ? ` listed ${money(v.price)}` : ''}`,
    );
    if (
      !t.u.intents.some((i) =>
        [
          'PAYMENT_ESTIMATE',
          'SALES_APPOINTMENT',
          'TRADE_IN',
          'CREDIT_APPLICATION',
        ].includes(i.intent),
      )
    ) {
      t.narration.push(
        tr(
          t.lang,
          `Got it — the ${vehicleLabel(v, true)}.`,
          `Entendido — el ${vehicleLabel(v)}.`,
        ),
      );
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Want me to estimate a payment or set up a time to see it?',
          '¿Le calculo un pago estimado o agendamos una visita para verlo?',
        ),
        8,
      );
    }
  }

  private mergeCriteria(t: Turn) {
    const st = t.st;
    const v = t.u.entities.vehicle ?? {};
    const changedTarget =
      (v.model && v.model !== st.criteria.model) ||
      (v.make && v.make !== st.criteria.make && !v.model);
    if (changedTarget) {
      st.criteria = { maxPrice: st.criteria.maxPrice };
    }
    st.criteria = {
      ...st.criteria,
      ...Object.fromEntries(
        Object.entries(v).filter(([, val]) => val !== undefined),
      ),
      ...(t.u.entities.maxPrice ? { maxPrice: t.u.entities.maxPrice } : {}),
      ...(t.u.entities.features?.length
        ? { features: t.u.entities.features }
        : {}),
    };
  }

  private async handleSearch(t: Turn) {
    if (await this.capBlocked(t, 'inventory')) return;
    this.mergeCriteria(t);
    const c = t.st.criteria;
    t.toolCount += 1;
    this.signal(t, 'inventory_search');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'inventory_search',
      { hasModel: !!c.model, hasBudget: !!c.maxPrice },
      t.s.externalKey,
    );
    let vehicles = await this.inventory.searchVehicles({
      tenantId: t.tenantId,
      locationId: t.locationId,
      ...c,
    });
    let relaxedNote: string | null = null;
    if (vehicles.length === 0) {
      // Loosen ONE constraint for alternatives; never silently rewrite the saved criteria.
      const tries: Array<[string, Partial<typeof c>, string, string]> = [
        ['color', { color: undefined }, `in other colors`, 'en otros colores'],
        [
          'features',
          { features: undefined },
          'without every feature confirmed in the listing',
          'sin confirmar todas las características',
        ],
        [
          'maxPrice',
          { maxPrice: c.maxPrice ? Math.round(c.maxPrice * 1.1) : undefined },
          `up to ${c.maxPrice ? money(c.maxPrice * 1.1) : ''}`,
          `hasta ${c.maxPrice ? money(c.maxPrice * 1.1) : ''}`,
        ],
        [
          'year',
          { year: undefined },
          'from other model years',
          'de otros años',
        ],
      ];
      for (const [key, patch, en, es] of tries) {
        if ((c as Record<string, unknown>)[key] === undefined) continue;
        const alt = await this.inventory.searchVehicles({
          tenantId: t.tenantId,
          locationId: t.locationId,
          ...c,
          ...patch,
        });
        if (alt.length) {
          vehicles = alt;
          relaxedNote = tr(
            t.lang,
            `I didn't find an exact match, but here are a few ${en}.`,
            `No encontré una coincidencia exacta, pero aquí hay algunas opciones ${es}.`,
          );
          break;
        }
      }
    }
    let monthlyMiss = false;
    if (
      t.st.payment.maxMonthly &&
      vehicles.length &&
      (await this.cap(t, 'payments')).allowed
    ) {
      const withEst = await this.withPaymentEstimates(t, vehicles);
      const fits = withEst.filter(
        (v) =>
          v.estimatedPayment != null &&
          v.estimatedPayment <= t.st.payment.maxMonthly!,
      );
      if (fits.length) vehicles = fits;
      else monthlyMiss = true;
    }
    if (vehicles.length === 0) {
      this.metrics.increment('inventory.miss');
      void this.analytics.trackEvent(
        t.tenantId,
        t.locationId,
        'inventory_result',
        { count: 0 },
        t.s.externalKey,
      );
      t.answers.push(
        tr(
          t.lang,
          "I'm not finding anything in the dealership's current inventory that matches that.",
          'No encuentro nada en el inventario actual de la agencia que coincida.',
        ),
      );
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Want me to widen the search, or have someone let you know when one comes in?',
          '¿Amplío la búsqueda o le aviso cuando llegue uno?',
        ),
        7,
      );
      t.sources.add('inventory_db');
      return;
    }
    this.metrics.increment('inventory.hit');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'inventory_result',
      { count: vehicles.length },
      t.s.externalKey,
    );
    const shown = vehicles.slice(0, 6);
    t.st.visibleVins = shown.map((v) => v.vin);
    t.vehicles = await this.withPaymentEstimates(t, shown);
    t.type = 'vehicle_carousel';
    await this.attachVehicleEvidence(t, shown);
    const stale = t.evidence.some(
      (e) =>
        e.field === 'inventory_availability' && e.freshnessState !== 'fresh',
    );
    if (relaxedNote) t.narration.push(relaxedNote);
    else if (monthlyMiss) {
      t.narration.push(
        tr(
          t.lang,
          `None of these come in under ${money(t.st.payment.maxMonthly!)}/month with ${t.st.payment.downPayment ? `${money(t.st.payment.downPayment)} down` : 'nothing down'} at an example rate — here are the closest.`,
          `Ninguno queda por debajo de ${money(t.st.payment.maxMonthly!)}/mes con ${t.st.payment.downPayment ? `${money(t.st.payment.downPayment)} de enganche` : 'cero enganche'} a una tasa de ejemplo — estos son los más cercanos.`,
        ),
      );
    } else {
      const what =
        vehicleLabel({ make: c.make, model: c.model, color: c.color }, true) ||
        tr(t.lang, 'vehicles', 'vehículos');
      t.narration.push(
        shown.length === 1
          ? tr(
              t.lang,
              `I found one ${what} that fits.`,
              `Encontré un ${what} que coincide.`,
            )
          : tr(
              t.lang,
              `I found ${shown.length} ${what}${shown.length > 1 && !/s$/.test(what) ? 's' : ''} that fit${c.maxPrice ? ` under ${money(c.maxPrice)}` : ''}.`,
              `Encontré ${shown.length} opciones que coinciden${c.maxPrice ? ` por menos de ${money(c.maxPrice)}` : ''}.`,
            ),
      );
    }
    if (stale) {
      t.narration.push(
        tr(
          t.lang,
          "Heads up: some of this inventory data hasn't refreshed recently, so the team will confirm availability.",
          'Aviso: parte del inventario no se ha actualizado recientemente, el equipo confirmará disponibilidad.',
        ),
      );
    }
    t.facts.push(
      `Vehicles shown: ${shown.map((v) => `${vehicleLabel(v, true)}${v.price ? ` ${money(v.price)}` : ''}`).join('; ')}`,
    );
    if (shown.length === 1) {
      t.st.selectedVin = shown[0].vin;
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Want a payment estimate or a time to see it?',
          '¿Le calculo un pago o agendamos una visita?',
        ),
        9,
      );
    } else {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Want me to narrow these down by a feature, or estimate a payment on one?',
          '¿Los filtro por alguna característica o le calculo un pago en alguno?',
        ),
        9,
      );
    }
  }

  private async handleFeatureFilter(t: Turn) {
    const feats = t.u.entities.features ?? [];
    let pool = await this.loadVisible(t);
    if (!pool.length && t.st.selectedVin) {
      const v = await this.inventory.getVehicleByVin(
        t.tenantId,
        t.st.selectedVin,
      );
      pool = v ? [v] : [];
    }
    if (!pool.length) return this.handleSearch(t);
    t.toolCount += 1;
    this.signal(t, 'feature_question');
    const yes: InventoryVehicle[] = [];
    const unknown: InventoryVehicle[] = [];
    for (const v of pool) {
      const results = feats.map((f) =>
        vehicleHasFeature(
          (v as InventoryVehicle & { features?: string[] }).features,
          f,
        ),
      );
      if (results.every((r) => r === true)) yes.push(v);
      else if (results.some((r) => r === null)) unknown.push(v);
    }
    const featLabel = feats.join(tr(t.lang, ' and ', ' y '));
    t.evidence.push(
      this.evidenceSvc.verifiedConfig(
        t.tenantId,
        t.locationId,
        'vehicle_feature',
        yes.length,
        'inventory_feed.features',
        new Date().toISOString(),
      ),
    );
    if (yes.length) {
      t.narration.push(
        yes.length === 1
          ? tr(
              t.lang,
              `The ${vehicleLabel(yes[0], true)} lists ${featLabel}.`,
              `El ${vehicleLabel(yes[0])} incluye ${featLabel}.`,
            )
          : tr(
              t.lang,
              `${yes.length} of them list ${featLabel}.`,
              `${yes.length} de ellos incluyen ${featLabel}.`,
            ),
      );
      t.vehicles = await this.withPaymentEstimates(t, yes);
      t.type = 'vehicle_carousel';
      t.st.visibleVins = yes.map((v) => v.vin);
      if (yes.length === 1) t.st.selectedVin = yes[0].vin;
      await this.attachVehicleEvidence(t, yes);
    } else {
      t.narration.push(
        tr(
          t.lang,
          `None of those list ${featLabel} in the dealership's data.`,
          `Ninguno de esos indica ${featLabel} en los datos de la agencia.`,
        ),
      );
    }
    if (unknown.length) {
      t.narration.push(
        tr(
          t.lang,
          `The listing data doesn't say either way for ${unknown.length === 1 ? `the ${vehicleLabel(unknown[0], true)}` : `${unknown.length} others`}, so the team would need to confirm.`,
          `Los datos no lo indican para ${unknown.length === 1 ? `el ${vehicleLabel(unknown[0])}` : `${unknown.length} más`}, el equipo tendría que confirmarlo.`,
        ),
      );
    }
    this.ask(
      t,
      'none',
      tr(
        t.lang,
        'Want me to estimate a payment on one?',
        '¿Le calculo un pago estimado en alguno?',
      ),
      8,
    );
  }

  // ───────────────────────────────────────── payments / finance

  private async handlePayment(t: Turn) {
    if (await this.capBlocked(t, 'payments')) return;
    let v: InventoryVehicle | undefined;
    if (t.st.selectedVin)
      v =
        (await this.inventory.getVehicleByVin(t.tenantId, t.st.selectedVin)) ??
        undefined;
    if (!v) {
      const ref = await this.resolveVehicleReference(t);
      if (ref.ambiguous?.length || (!ref.v && t.st.visibleVins.length > 1)) {
        this.ask(
          t,
          'vehicle_choice',
          tr(
            t.lang,
            'Which one should I run the numbers on?',
            '¿Con cuál calculo los números?',
          ),
          2,
        );
        return;
      }
      v = ref.v;
    }
    if (!v) {
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Which vehicle should I estimate? I can search inventory if you tell me what you have in mind.',
          '¿Qué vehículo calculo? Puedo buscar en el inventario si me dice qué busca.',
        ),
        3,
      );
      return;
    }
    if (!v.price || !(v.status === 'AVAILABLE' || v.status === 'IN_TRANSIT')) {
      t.answers.push(
        tr(
          t.lang,
          `I don't have a current listed price for the ${vehicleLabel(v)}, so I can't estimate a payment on it.`,
          `No tengo un precio vigente para el ${vehicleLabel(v)}, así que no puedo estimar un pago.`,
        ),
      );
      return;
    }
    t.st.selectedVin = v.vin;
    t.toolCount += 1;
    const policy = await this.getPolicy(t);
    const est: PolicyEstimate = this.payments.estimateWithPolicy({
      price: v.price,
      policy,
      downPayment: t.st.payment.downPayment,
      termMonths: t.st.payment.termMonths,
      customerApr: t.st.payment.customerApr,
    });
    await this.attachVehicleEvidence(t, [v]);
    t.sources.add('payment_calculator');
    t.evidence.push(
      t.st.payment.customerApr !== undefined
        ? this.evidenceSvc.verifiedConfig(
            t.tenantId,
            t.locationId,
            'finance_apr',
            est.breakdown.apr,
            'customer_provided',
            new Date().toISOString(),
          )
        : this.evidenceSvc.unverified(
            t.tenantId,
            t.locationId,
            'finance_apr',
            'Illustrative rate — not a lender or dealer offer.',
          ),
    );
    t.st.payment.lastEstimate = {
      vin: v.vin,
      monthly: est.monthlyPayment,
      apr: est.breakdown.apr,
      aprSource: est.aprSource,
      termMonths: est.breakdown.termMonths,
      downPayment: est.breakdown.downPayment,
      tradeEquity: 0,
      includesTaxAndFees: est.includesTaxAndFees,
      policyVersion: est.policyVersion,
    };
    this.signal(t, 'payment_estimate');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'payment_estimate',
      { aprSource: est.aprSource, policyMode: est.policyMode },
      t.s.externalKey,
    );
    const down = est.breakdown.downPayment;
    const lead =
      down > 0
        ? tr(
            t.lang,
            `With ${money(down)} down`,
            `Con ${money(down)} de enganche`,
          )
        : tr(t.lang, 'With nothing down', 'Sin enganche');
    t.narration.push(
      tr(
        t.lang,
        `${lead} over ${est.breakdown.termMonths} months, the ${vehicleLabel(v)} at ${money(v.price)} works out to about ${money(est.monthlyPayment)}/month.`,
        `${lead} a ${est.breakdown.termMonths} meses, el ${vehicleLabel(v)} de ${money(v.price)} queda en unos ${money(est.monthlyPayment)}/mes.`,
      ),
    );
    const aprText =
      est.aprSource === 'CUSTOMER'
        ? tr(
            t.lang,
            `That uses the ${est.breakdown.apr}% rate you mentioned,`,
            `Eso usa la tasa de ${est.breakdown.apr}% que mencionó,`,
          )
        : tr(
            t.lang,
            `That uses an example ${est.breakdown.apr}% rate (not your actual rate),`,
            `Eso usa una tasa de ejemplo de ${est.breakdown.apr}% (no su tasa real),`,
          );
    const taxText = est.includesTaxAndFees
      ? tr(
          t.lang,
          'and includes the dealership’s listed taxes and fees',
          'e incluye los impuestos y cargos publicados por la agencia',
        )
      : tr(
          t.lang,
          'and leaves out taxes and fees',
          'y no incluye impuestos ni cargos',
        );
    t.narration.push(
      `${aprText} ${taxText}${t.st.trade?.requestId ? tr(t.lang, ', before any trade value', ', antes del valor de su vehículo a cuenta') : ''}${tr(t.lang, ' — the dealership can confirm exact numbers.', ' — la agencia puede confirmar los números exactos.')}`,
    );
    if (
      t.st.payment.maxMonthly &&
      est.monthlyPayment > t.st.payment.maxMonthly
    ) {
      t.narration.push(
        tr(
          t.lang,
          `That's above your ${money(t.st.payment.maxMonthly)}/month target.`,
          `Eso está por encima de su meta de ${money(t.st.payment.maxMonthly)}/mes.`,
        ),
      );
    }
    t.cards.push({
      kind: 'payment',
      vin: v.vin,
      monthly: est.monthlyPayment,
      apr: est.breakdown.apr,
      aprSource: est.aprSource,
      termMonths: est.breakdown.termMonths,
      downPayment: down,
      tradeEquity: 0,
      price: v.price,
      includesTaxAndFees: est.includesTaxAndFees,
      disclaimer: est.disclaimer,
      policyVersion: est.policyVersion,
    });
    t.legacyPayment = {
      monthlyPayment: est.monthlyPayment,
      termMonths: est.breakdown.termMonths,
      apr: est.breakdown.apr,
      downPayment: down,
      vehicleVin: v.vin,
      price: v.price,
    };
    if (!t.vehicles) t.type = 'payment_summary';
    t.facts.push(
      `Payment estimate (computed, not an offer): ${money(est.monthlyPayment)}/mo, ${est.breakdown.termMonths} mo, ${est.breakdown.apr}% ${est.aprSource}, ${money(down)} down, price ${money(v.price)}`,
    );
    if ((await this.cap(t, 'leadCapture')).allowed) {
      const fr = await this.finance.upsertForConversation({
        tenantId: t.tenantId,
        locationId: t.locationId,
        conversationId: t.s.conversationId,
        vehicleVin: v.vin,
        desiredPayment: t.st.payment.maxMonthly ?? null,
        downPayment: t.st.payment.downPayment ?? null,
        termMonths: t.st.payment.termMonths ?? null,
        leaseOrPurchase: t.st.payment.leaseOrPurchase ?? null,
        customerApr: t.st.payment.customerApr ?? null,
        tradeInterest: !!t.st.trade?.requestId,
      });
      t.st.finance = { ...t.st.finance, requestId: fr.id };
    }
    this.ask(
      t,
      'none',
      tr(
        t.lang,
        'Want me to set up a time to see it?',
        '¿Quiere agendar una visita para verlo?',
      ),
      9,
    );
  }

  private async handleFinance(t: Turn) {
    if (await this.capBlocked(t, 'leadCapture')) return;
    t.toolCount += 1;
    const fr = await this.finance.upsertForConversation({
      tenantId: t.tenantId,
      locationId: t.locationId,
      conversationId: t.s.conversationId,
      vehicleVin: t.st.selectedVin ?? null,
      desiredPayment: t.st.payment.maxMonthly ?? null,
      downPayment: t.st.payment.downPayment ?? null,
      termMonths: t.st.payment.termMonths ?? null,
      leaseOrPurchase: t.st.payment.leaseOrPurchase ?? null,
      customerApr: t.st.payment.customerApr ?? null,
      tradeInterest: !!t.st.trade?.requestId,
      customer: {
        name: this.customerName(t),
        phone: t.st.contact.phone,
        email: t.st.contact.email,
      },
    });
    t.st.finance = { ...t.st.finance, requestId: fr.id };
    this.signal(t, 'finance_interest');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'finance_started',
      {},
      t.s.externalKey,
    );
    t.evidence.push(
      this.evidenceSvc.unverified(
        t.tenantId,
        t.locationId,
        'finance_approval',
        'Approval only from the dealership finance team or lender.',
      ),
    );
    if (
      /\b(approved|approve|rate|my rate|credit score|bad credit)\b/i.test(
        t.message,
      )
    ) {
      t.narration.push(
        tr(
          t.lang,
          "I can't tell you what rate you'd get or whether you'd be approved — that comes from the dealership's lenders after a credit application. Plenty of shoppers in different credit situations get financed, and the finance team can walk through options.",
          'No puedo decirle qué tasa obtendría ni si sería aprobado — eso lo determinan los prestamistas de la agencia después de una solicitud de crédito. Muchas personas con distintas situaciones de crédito obtienen financiamiento, y el equipo de finanzas puede explicarle las opciones.',
        ),
      );
    }
    if (!t.handled.has('CREDIT_APPLICATION')) {
      const res = await this.credit.resolve(t.tenantId, t.locationId);
      if (res.available && !t.st.finance?.creditLinkOffered) {
        this.ask(
          t,
          'confirm_credit_link',
          tr(
            t.lang,
            "Want me to send the dealership's secure credit application? You'd fill it out on their site and we can keep going here.",
            '¿Le envío la solicitud de crédito segura de la agencia? La llenaría en su sitio y seguimos aquí.',
          ),
          4,
        );
      } else if (!res.available) {
        this.ask(
          t,
          'confirm_handoff',
          tr(
            t.lang,
            'Want me to have the finance team reach out?',
            '¿Quiere que el equipo de finanzas le contacte?',
          ),
          5,
        );
      }
    }
  }

  private async handleCreditApp(t: Turn) {
    if (await this.capBlocked(t, 'leadCapture')) return;
    t.toolCount += 1;
    const fr = await this.finance.upsertForConversation({
      tenantId: t.tenantId,
      locationId: t.locationId,
      conversationId: t.s.conversationId,
      vehicleVin: t.st.selectedVin ?? null,
      downPayment: t.st.payment.downPayment ?? null,
      desiredPayment: t.st.payment.maxMonthly ?? null,
      tradeInterest: !!t.st.trade?.requestId,
      customer: {
        name: this.customerName(t),
        phone: t.st.contact.phone,
        email: t.st.contact.email,
      },
    });
    t.st.finance = { ...t.st.finance, requestId: fr.id };
    const res = await this.credit.resolve(t.tenantId, t.locationId);
    if (!res.available) {
      t.answers.push(
        tr(
          t.lang,
          "The dealership hasn't set up an online credit application in this chat yet.",
          'La agencia aún no ha configurado una solicitud de crédito en línea en este chat.',
        ),
      );
      this.ask(
        t,
        'confirm_handoff',
        tr(
          t.lang,
          'Want me to have the finance team reach out to get you started?',
          '¿Quiere que el equipo de finanzas le contacte para empezar?',
        ),
        3,
      );
      return;
    }
    await this.credit.markOffered(t.tenantId, fr.id, t.locationId);
    t.st.finance.creditLinkOffered = true;
    this.signal(t, 'credit_link_offered');
    const url = this.credit.trackedPath(fr.id, t.tenantId);
    t.cards.push({
      kind: 'credit_application',
      label: res.config.label,
      url,
      providerName: res.config.providerName,
    });
    t.sources.add('credit_application_config');
    t.narration.push(
      tr(
        t.lang,
        "Here's the dealership's secure credit application. You'll complete it on their site, and we can keep going here afterward.",
        'Aquí está la solicitud de crédito segura de la agencia. La completa en su sitio y después seguimos aquí.',
      ),
    );
    t.narration.push(
      tr(
        t.lang,
        "Please don't share your Social Security or bank details in this chat.",
        'Por favor no comparta su Seguro Social ni datos bancarios en este chat.',
      ),
    );
  }

  // ───────────────────────────────────────── appointments

  private apptLabel(
    t: Turn,
    a: {
      requestedDate: string | null;
      requestedTime: string | null;
      type: string;
    },
  ) {
    const d = dateLabel(a.requestedDate, t.lang);
    const time = a.requestedTime ?? '';
    const tm = /^(morning|afternoon|evening)$/.test(time)
      ? tr(
          t.lang,
          `${time}`,
          {
            morning: 'por la mañana',
            afternoon: 'por la tarde',
            evening: 'por la noche',
          }[time] as string,
        )
      : time;
    return `${d}${tm ? (/^(morning|afternoon|evening)$/.test(time) ? ` ${tm}` : tr(t.lang, ` at ${tm}`, ` a las ${tm}`)) : ''}`;
  }

  private async narrateAppointmentResult(
    t: Turn,
    res: AppointmentRequestResult,
    type: string,
    rescheduled = false,
  ) {
    if (res.status === 'incomplete') return;
    if (res.status === 'rejected') {
      const alts = res.alternatives
        .slice(0, 3)
        .map(
          (a) =>
            `${dateLabel(a.date, t.lang)} (${formatClock(a.open, t.lang)}–${formatClock(a.close, t.lang)})`,
        );
      if (res.code === 'closed_day') {
        t.answers.push(
          tr(
            t.lang,
            `The dealership is closed ${dateLabel(res.day?.date, t.lang)}${res.day?.note ? ` (${res.day.note})` : ''}.`,
            `La agencia está cerrada el ${dateLabel(res.day?.date, t.lang)}.`,
          ),
        );
        if (alts.length)
          t.narration.push(
            tr(
              t.lang,
              `The next open days are ${alts.join(', ')}.`,
              `Los próximos días abiertos son ${alts.join(', ')}.`,
            ),
          );
        this.ask(
          t,
          'appointment_date',
          tr(t.lang, 'Which day works better?', '¿Qué día le funciona mejor?'),
          2,
        );
      } else if (res.code === 'outside_hours') {
        const d = res.day;
        t.answers.push(
          tr(
            t.lang,
            `That's outside ${dateLabel(d?.date, t.lang)} hours${d?.open != null && d?.close != null ? ` (${formatClock(d.open)}–${formatClock(d.close)})` : ''}.`,
            `Eso está fuera del horario del ${dateLabel(d?.date, t.lang)}${d?.open != null && d?.close != null ? ` (${formatClock(d.open, 'es')}–${formatClock(d.close, 'es')})` : ''}.`,
          ),
        );
        this.ask(
          t,
          'appointment_time',
          tr(
            t.lang,
            'What time within those hours works?',
            '¿Qué hora dentro de ese horario le funciona?',
          ),
          2,
        );
      } else if (res.code === 'in_past') {
        t.answers.push(
          tr(t.lang, 'That time has already passed.', 'Ese horario ya pasó.'),
        );
        this.ask(
          t,
          'appointment_date',
          tr(t.lang, 'What day works for you?', '¿Qué día le funciona?'),
          2,
        );
      } else {
        t.answers.push(
          tr(
            t.lang,
            "The scheduling system shows that time isn't available.",
            'El sistema de citas indica que ese horario no está disponible.',
          ),
        );
        if (alts.length)
          t.narration.push(
            tr(
              t.lang,
              `Open options: ${alts.join(', ')}.`,
              `Opciones disponibles: ${alts.join(', ')}.`,
            ),
          );
        this.ask(
          t,
          'appointment_time',
          tr(
            t.lang,
            'Would one of those work?',
            '¿Le funciona alguna de esas?',
          ),
          2,
        );
      }
      return;
    }
    const a = res.appointment;
    t.st.appointment = {
      id: a.id,
      type: a.type,
      status: a.status,
      requestedDate: a.requestedDate,
      requestedTime: a.requestedTime,
      outcome: res.outcome,
    };
    t.st.draftAppointment = undefined;
    t.st.pending = 'none';
    t.evidence.push(
      this.evidenceSvc.forAppointment(t.tenantId, t.locationId, a),
    );
    t.sources.add(
      res.outcome === 'confirmed'
        ? `scheduler:${a.provider}`
        : 'appointment_request',
    );
    const label = this.apptLabel(t, a);
    const what =
      type === 'SERVICE'
        ? tr(t.lang, 'service visit', 'cita de servicio')
        : type === 'TEST_DRIVE'
          ? tr(t.lang, 'test drive', 'prueba de manejo')
          : tr(t.lang, 'visit', 'visita');
    if (res.outcome === 'confirmed') {
      t.narration.push(
        tr(
          t.lang,
          `You're booked for a ${what} ${label} — the dealership's scheduling system confirmed it.`,
          `Su ${what} quedó confirmada para el ${label} — el sistema de citas de la agencia la confirmó.`,
        ),
      );
    } else if (res.outcome === 'pending') {
      t.narration.push(
        tr(
          t.lang,
          `I sent a ${what} request for ${label} to the dealership's scheduler and it's waiting on confirmation.`,
          `Envié una solicitud de ${what} para el ${label} al sistema de citas y está pendiente de confirmación.`,
        ),
      );
    } else {
      t.narration.push(
        rescheduled
          ? tr(
              t.lang,
              `I've moved your ${what} request to ${label}.`,
              `Cambié su solicitud de ${what} al ${label}.`,
            )
          : tr(
              t.lang,
              `I've requested a ${what} for ${label}.`,
              `Solicité una ${what} para el ${label}.`,
            ),
      );
      t.narration.push(
        res.hoursVerified
          ? tr(
              t.lang,
              "It's a request for now — the team will confirm the exact time with you.",
              'Por ahora es una solicitud — el equipo le confirmará la hora exacta.',
            )
          : tr(
              t.lang,
              "It's a request for now, and the team will confirm the time works.",
              'Por ahora es una solicitud, y el equipo confirmará que el horario funciona.',
            ),
      );
    }
    t.cards.push({
      kind: 'appointment',
      id: a.id,
      type: a.type,
      status: a.status,
      outcome: res.outcome,
      date: a.requestedDate,
      time: a.requestedTime,
      label,
      verified: res.outcome === 'confirmed',
    });
    this.signal(
      t,
      type === 'TEST_DRIVE'
        ? 'test_drive_requested'
        : type === 'SERVICE'
          ? 'service_request'
          : 'appointment_requested',
    );
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      rescheduled
        ? 'appointment_rescheduled'
        : type === 'SERVICE'
          ? 'service_appointment_requested'
          : 'appointment_requested',
      { outcome: res.outcome, type },
      t.s.externalKey,
    );
    if (!t.st.contact.firstName) {
      this.ask(
        t,
        'contact_name',
        tr(t.lang, 'Who should they ask for?', '¿A nombre de quién la dejo?'),
        3,
      );
    } else if (!t.st.contact.phone && !t.st.contact.email) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          "What's the best number or email to confirm with you?",
          '¿Cuál es el mejor número o correo para confirmarle?',
        ),
        3,
      );
    }
  }

  private async handleAppointment(
    t: Turn,
    type: 'SALES' | 'TEST_DRIVE' | 'SERVICE',
  ) {
    if (
      await this.capBlocked(t, type === 'SERVICE' ? 'service' : 'appointments')
    )
      return;
    if (type === 'SERVICE' && (await this.capBlocked(t, 'appointments')))
      return;
    const st = t.st;
    const active =
      st.appointment &&
      ['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(
        st.appointment.status,
      ) &&
      st.appointment.type === type;
    if (
      active &&
      t.u.entities.when &&
      !hasIntent(t.u, 'APPOINTMENT_RESCHEDULE')
    ) {
      return this.handleReschedule(t);
    }
    if (type === 'SERVICE') {
      const need = t.u.entities.serviceNeed ?? st.service?.need;
      st.service = { ...st.service, need };
      if (!need && !t.u.entities.partNeed && !st.parts?.inquiryId) {
        st.draftAppointment = { type };
        this.ask(
          t,
          'service_need',
          tr(
            t.lang,
            'What does the vehicle need — maintenance like an oil change, or something specific you’ve noticed?',
            '¿Qué necesita el vehículo — mantenimiento como cambio de aceite, o algo específico que notó?',
          ),
          2,
        );
        return;
      }
    }
    const when = t.u.entities.when;
    if (!when?.date) {
      st.draftAppointment = { type, serviceNeed: st.service?.need };
      this.ask(
        t,
        'appointment_date',
        tr(t.lang, 'What day works for you?', '¿Qué día le funciona?'),
        2,
      );
      return;
    }
    if (when.time === undefined && !when.partOfDay) {
      st.draftAppointment = { type, serviceNeed: st.service?.need };
      const hours = await this.getHours(t);
      const day = hours?.verified
        ? StoreHoursService.resolveDay(
            hours,
            when.date,
            type === 'SERVICE' ? 'service' : 'sales',
          )
        : null;
      const hint =
        day && !day.closed && day.open != null && day.close != null
          ? tr(
              t.lang,
              ` (open ${formatClock(day.open)}–${formatClock(day.close)})`,
              ` (abierto ${formatClock(day.open, 'es')}–${formatClock(day.close, 'es')})`,
            )
          : '';
      this.ask(
        t,
        'appointment_time',
        tr(
          t.lang,
          `What time on ${dateLabel(`${when.date.year}-${String(when.date.month).padStart(2, '0')}-${String(when.date.day).padStart(2, '0')}`, 'en')}${hint}?`,
          `¿A qué hora el ${dateLabel(`${when.date.year}-${String(when.date.month).padStart(2, '0')}-${String(when.date.day).padStart(2, '0')}`, 'es')}${hint}?`,
        ),
        2,
      );
      return;
    }
    t.toolCount += 1;
    const res = await this.appointments.request({
      tenantId: t.tenantId,
      locationId: t.locationId,
      conversationId: t.s.conversationId,
      leadId: st.leadId ?? null,
      type,
      when,
      vin:
        type === 'SERVICE'
          ? (st.service?.vin ?? null)
          : (st.selectedVin ?? null),
      serviceType:
        type === 'SERVICE'
          ? (st.service?.need ?? st.parts?.need ?? null)
          : null,
      customer: {
        name: this.customerName(t),
        phone: st.contact.phone,
        email: st.contact.email,
      },
      notes: st.parts?.inquiryId
        ? `Installation for parts inquiry ${st.parts.inquiryId}`
        : null,
      source: 'chat',
    });
    if (res.status === 'saved' && st.parts?.inquiryId && type === 'SERVICE') {
      await this.parts.linkInstallAppointment(
        t.tenantId,
        st.parts.inquiryId,
        res.appointment.id,
      );
    }
    await this.narrateAppointmentResult(t, res, type);
  }

  private async handleReschedule(t: Turn) {
    const st = t.st;
    if (!st.appointment) {
      return this.handleAppointment(
        t,
        st.department === 'service'
          ? 'SERVICE'
          : st.selectedVin
            ? 'TEST_DRIVE'
            : 'SALES',
      );
    }
    const when = t.u.entities.when;
    if (!when?.date && when?.time === undefined && !when?.partOfDay) {
      this.ask(
        t,
        'appointment_date',
        tr(
          t.lang,
          'What day and time would you like instead?',
          '¿Qué día y hora prefiere?',
        ),
        2,
      );
      return;
    }
    // Keep the original time-of-day when only the day changes ("actually make it Saturday").
    const date =
      when.date ??
      parseIsoDate(st.appointment.requestedDate ?? '') ??
      undefined;
    let time = when.time;
    let partOfDay = when.partOfDay;
    if (time === undefined && !partOfDay && st.appointment.requestedTime) {
      if (/^(morning|afternoon|evening)$/.test(st.appointment.requestedTime))
        partOfDay = st.appointment.requestedTime as 'morning';
      else {
        const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(
          st.appointment.requestedTime,
        );
        if (m)
          time =
            ((Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0)) *
              60 +
            Number(m[2] ?? 0);
      }
    }
    t.toolCount += 1;
    const res = await this.appointments.reschedule({
      tenantId: t.tenantId,
      appointmentId: st.appointment.id,
      when: { date, time, partOfDay, phrase: when.phrase },
      source: 'chat',
    });
    t.isCorrection = true;
    await this.narrateAppointmentResult(t, res, st.appointment.type, true);
  }

  private async handleCancel(t: Turn) {
    const st = t.st;
    if (!st.appointment) {
      t.answers.push(
        tr(
          t.lang,
          "I don't see an appointment request from this chat to cancel.",
          'No veo una solicitud de cita en este chat para cancelar.',
        ),
      );
      return;
    }
    t.toolCount += 1;
    await this.appointments.cancel({
      tenantId: t.tenantId,
      appointmentId: st.appointment.id,
      reason: 'customer_chat',
      source: 'chat',
    });
    st.appointment = { ...st.appointment, status: 'CANCELLED' };
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'appointment_canceled',
      {},
      t.s.externalKey,
    );
    t.narration.push(
      tr(
        t.lang,
        "Done — I've canceled that appointment request.",
        'Listo — cancelé esa solicitud de cita.',
      ),
    );
  }

  private async handleAmenity(t: Turn) {
    const amen = t.u.entities.amenity ?? 'shuttle';
    t.st.service = { ...t.st.service, amenityAsked: amen };
    const loc = t.locationId
      ? await this.prisma.location.findFirst({
          where: { id: t.locationId, tenantId: t.tenantId },
          select: { serviceAmenities: true },
        })
      : null;
    const cfg = (loc?.serviceAmenities ?? null) as Record<
      string,
      unknown
    > | null;
    const verifiedAt =
      typeof cfg?.verifiedAt === 'string' ? cfg.verifiedAt : null;
    const val = cfg && verifiedAt ? cfg[amen] : undefined;
    const name = {
      shuttle: tr(t.lang, 'a shuttle', 'servicio de transporte'),
      loaner: tr(t.lang, 'loaner vehicles', 'autos de cortesía'),
      rideshare: tr(t.lang, 'rideshare credits', 'traslados'),
      wifi: 'Wi-Fi',
      wait: tr(t.lang, 'a waiting area', 'sala de espera'),
    }[amen];
    if (val === true) {
      t.evidence.push(
        this.evidenceSvc.verifiedConfig(
          t.tenantId,
          t.locationId,
          'service_amenity',
          true,
          'location.serviceAmenities',
          verifiedAt,
        ),
      );
      t.answers.push(
        tr(
          t.lang,
          `Yes — the service department offers ${name}.`,
          `Sí — el departamento de servicio ofrece ${name}.`,
        ),
      );
    } else if (val === false) {
      t.evidence.push(
        this.evidenceSvc.verifiedConfig(
          t.tenantId,
          t.locationId,
          'service_amenity',
          false,
          'location.serviceAmenities',
          verifiedAt,
        ),
      );
      t.answers.push(
        tr(
          t.lang,
          `The service department doesn't list ${name}.`,
          `El departamento de servicio no ofrece ${name}.`,
        ),
      );
    } else {
      t.evidence.push(
        this.evidenceSvc.unverified(
          t.tenantId,
          t.locationId,
          'service_amenity',
          'Not configured by the dealership.',
        ),
      );
      t.answers.push(
        tr(
          t.lang,
          `I can't confirm ${name} from here.`,
          `No puedo confirmar ${name} desde aquí.`,
        ),
      );
      if (t.st.appointment?.id) {
        await this.prisma.appointment.updateMany({
          where: { id: t.st.appointment.id, tenantId: t.tenantId },
          data: { transportation: `customer asked about ${amen} (unverified)` },
        });
        t.narration.push(
          tr(
            t.lang,
            "I've added a note to your request so the service advisor can let you know.",
            'Agregué una nota a su solicitud para que el asesor de servicio le informe.',
          ),
        );
      } else {
        t.narration.push(
          tr(
            t.lang,
            'The service team can let you know when they confirm your visit.',
            'El equipo de servicio le puede informar al confirmar su visita.',
          ),
        );
      }
    }
  }

  private async handleServiceStatus(t: Turn) {
    t.evidence.push(
      this.evidenceSvc.unverified(
        t.tenantId,
        t.locationId,
        'repair_order_status',
        'No authorized DMS repair-order lookup is configured.',
      ),
    );
    t.answers.push(
      tr(
        t.lang,
        "I can't look up repair status from here yet.",
        'Todavía no puedo consultar el estado de la reparación desde aquí.',
      ),
    );
    this.ask(
      t,
      'confirm_handoff',
      tr(
        t.lang,
        'Want me to have your service advisor reach out with an update?',
        '¿Quiere que su asesor de servicio le contacte con una actualización?',
      ),
      3,
    );
  }

  // ───────────────────────────────────────── parts

  private async handleParts(t: Turn) {
    if (await this.capBlocked(t, 'parts')) return;
    const st = t.st;
    const e = t.u.entities;
    const vin = e.vin ?? st.parts?.vin;
    st.parts = {
      ...st.parts,
      need: e.partNeed ?? st.parts?.need,
      vin,
      partNumber: e.partNumber ?? st.parts?.partNumber,
      vehicle: e.vehicle?.model
        ? { year: e.vehicle.year, make: e.vehicle.make, model: e.vehicle.model }
        : st.parts?.vehicle,
    };
    t.toolCount += 1;
    const isNewInquiry = !st.parts.inquiryId;
    const inquiry = await this.parts.upsertForConversation({
      tenantId: t.tenantId,
      locationId: t.locationId,
      conversationId: t.s.conversationId,
      description: redactCreditSensitive(t.message),
      partNumber: st.parts.partNumber,
      suspectedPart: st.parts.need ?? null,
      vin,
      vehicle: st.parts.vehicle,
      preferredAction: /\b(install|put (?:them|it) on)\b/i.test(t.message)
        ? 'INSTALL'
        : /\b(how much|price|cost|quote)\b/i.test(t.message)
          ? 'QUOTE'
          : 'INFO',
      customer: {
        name: this.customerName(t),
        phone: st.contact.phone,
        email: st.contact.email,
      },
    });
    st.parts.inquiryId = inquiry.id;
    this.signal(t, 'parts_request');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'parts_request_submitted',
      { hasVin: !!vin, hasPartNumber: !!st.parts.partNumber },
      t.s.externalKey,
    );
    for (const f of [
      'parts_fitment',
      'parts_price',
      'parts_availability',
    ] as const) {
      t.evidence.push(
        this.evidenceSvc.unverified(
          t.tenantId,
          t.locationId,
          f,
          'Verified by the parts team or an authorized parts provider only.',
        ),
      );
    }
    const what = st.parts.need ?? tr(t.lang, 'that part', 'esa pieza');
    const forVeh = st.parts.vehicle?.model
      ? tr(
          t.lang,
          ` for your ${vehicleLabel(st.parts.vehicle)}`,
          ` para su ${vehicleLabel(st.parts.vehicle)}`,
        )
      : '';
    const wasExisting =
      !!st.parts.inquiryId &&
      st.parts.inquiryId === inquiry.id &&
      !isNewInquiry;
    if (wasExisting && e.vin) {
      t.narration.push(
        tr(
          t.lang,
          'Thanks — I added the VIN to your parts request.',
          'Gracias — agregué el VIN a su solicitud de refacciones.',
        ),
      );
    } else if (!wasExisting) {
      t.narration.push(
        tr(
          t.lang,
          `I've started a parts request for ${what}${forVeh}.`,
          `Inicié una solicitud de refacciones para ${what}${forVeh}.`,
        ),
      );
    }
    const askedPrice = /\b(how much|price|cost|quote|cu[aá]nto)\b/i.test(
      t.message,
    );
    if (!wasExisting || askedPrice)
      t.narration.push(
        askedPrice
          ? tr(
              t.lang,
              "I can't quote a price or confirm fitment here — that depends on the exact part for your VIN. Installed price through service is also separate from the part price.",
              'No puedo dar precio ni confirmar compatibilidad aquí — depende de la pieza exacta para su VIN. El precio instalado en servicio es aparte del precio de la pieza.',
            )
          : tr(
              t.lang,
              'The parts team confirms fitment, price, and availability before anything is ordered.',
              'El equipo de refacciones confirma compatibilidad, precio y disponibilidad antes de ordenar.',
            ),
      );
    t.cards.push({
      kind: 'parts',
      id: inquiry.id,
      status: inquiry.status,
      fitmentVerified: false,
      priceVerified: false,
      availabilityVerified: false,
      etaVerified: false,
      needsVin: !vin && !st.parts.partNumber,
    });
    if (!vin && !st.parts.partNumber) {
      this.ask(
        t,
        'parts_vin',
        tr(
          t.lang,
          "Could you share the 17-character VIN? It's how the parts team confirms the right part.",
          '¿Me comparte el VIN de 17 caracteres? Así el equipo confirma la pieza correcta.',
        ),
        2,
      );
    } else if (!t.st.appointment && (await this.cap(t, 'service')).allowed) {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Would you like it installed? I can request a service appointment too.',
          '¿Le gustaría que se la instalen? También puedo solicitar una cita de servicio.',
        ),
        6,
      );
    } else if (!st.contact.phone && !st.contact.email) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          "What's the best number or email for the parts team to reach you?",
          '¿Cuál es el mejor número o correo para que el equipo le contacte?',
        ),
        5,
      );
    }
  }

  // ───────────────────────────────────────── info

  private async handleHours(t: Turn) {
    const hours = await this.getHours(t);
    const dept =
      t.st.department === 'service'
        ? 'service'
        : t.st.department === 'parts'
          ? 'parts'
          : 'store';
    t.evidence.push(this.evidenceSvc.forHours(t.tenantId, t.locationId, hours));
    if (!hours?.verified) {
      t.answers.push(
        tr(
          t.lang,
          "I don't have verified hours for this location yet.",
          'Aún no tengo horarios verificados para esta ubicación.',
        ),
      );
      const phone = await this.locationPhone(t);
      if (phone)
        t.narration.push(
          tr(
            t.lang,
            `The store can confirm at ${phone}.`,
            `La agencia puede confirmar al ${phone}.`,
          ),
        );
      return;
    }
    t.sources.add('location_store_hours');
    const summary = StoreHoursService.summarize(hours, dept, t.lang)!;
    const open = StoreHoursService.isOpenAt(hours, new Date(), dept);
    const deptName =
      dept === 'service'
        ? tr(t.lang, 'Service', 'Servicio')
        : dept === 'parts'
          ? tr(t.lang, 'Parts', 'Refacciones')
          : null;
    const now =
      open.open && open.closesAt != null
        ? tr(
            t.lang,
            `Open now until ${formatClock(open.closesAt)}.`,
            `Abierto ahora hasta las ${formatClock(open.closesAt, 'es')}.`,
          )
        : open.nextOpen
          ? tr(
              t.lang,
              `Closed right now — opens ${dateLabel(open.nextOpen.date, 'en')} at ${formatClock(open.nextOpen.open)}.`,
              `Cerrado ahora — abre el ${dateLabel(open.nextOpen.date, 'es')} a las ${formatClock(open.nextOpen.open, 'es')}.`,
            )
          : '';
    t.answers.push(
      `${deptName ? `${deptName}: ` : ''}${summary}. ${now}`.trim(),
    );
    t.cards.push({
      kind: 'hours',
      summary,
      openNow: open.known ? open.open : null,
      timezone: hours.timezone,
    });
  }

  private async handleHold(t: Turn) {
    if (!t.st.selectedVin) {
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Which vehicle would you like held?',
          '¿Qué vehículo quiere apartar?',
        ),
        3,
      );
      return;
    }
    if (await this.capBlocked(t, 'handoff')) return;
    this.signal(t, 'hold_requested');
    t.toolCount += 1;
    const { escalation, notified, queued } = await this.escalations.create({
      tenantId: t.tenantId,
      locationId: t.locationId,
      externalKey: t.s.externalKey,
      reason: `Hold request for VIN ${t.st.selectedVin}`,
      urgency: EscalationUrgency.HIGH,
      summary: `Customer asked to hold ${t.st.selectedVin}. Holds are staff-only; inventory status unchanged.`,
      metadata: { vin: t.st.selectedVin },
    });
    t.st.handoff = { escalationId: escalation.id, notified, queued };
    t.answers.push(
      tr(
        t.lang,
        "I can't place a hold from chat — only the sales team can do that.",
        'No puedo apartar el vehículo desde el chat — solo el equipo de ventas puede hacerlo.',
      ),
    );
    t.narration.push(
      notified
        ? tr(
            t.lang,
            "I've sent them your request to hold it.",
            'Ya les envié su solicitud para apartarlo.',
          )
        : tr(
            t.lang,
            "I've logged your request to hold it for the sales team.",
            'Registré su solicitud para apartarlo para el equipo de ventas.',
          ),
    );
    if (!t.st.contact.phone && !t.st.contact.email) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          "What's the best number or email for them to confirm with you?",
          '¿Cuál es el mejor número o correo para confirmarle?',
        ),
        2,
      );
    }
  }

  private async handleVehicleQuestion(t: Turn) {
    const ref = await this.resolveVehicleReference(t);
    const v = ref.v;
    if (!v) {
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Which vehicle are you asking about?',
          '¿Sobre qué vehículo pregunta?',
        ),
        4,
      );
      return;
    }
    await this.attachVehicleEvidence(t, [v]);
    const m = t.message.toLowerCase();
    const bits: string[] = [];
    if (/mileage|miles/.test(m))
      bits.push(
        v.mileage != null
          ? tr(
              t.lang,
              `It has ${v.mileage.toLocaleString('en-US')} miles.`,
              `Tiene ${v.mileage.toLocaleString('es-US')} millas.`,
            )
          : '',
      );
    if (/color/.test(m) && v.color)
      bits.push(tr(t.lang, `It's ${v.color}.`, `Es color ${v.color}.`));
    if (/engine|trim/.test(m) && (v.trim || v.engine))
      bits.push(`${v.trim ?? ''} ${v.engine ?? ''}`.trim() + '.');
    if (/available|sold|still/.test(m)) {
      const ev = t.evidence.find(
        (e) =>
          e.field === 'inventory_availability' && e.sourceRecordId === v.vin,
      );
      bits.push(
        ev?.verified
          ? tr(
              t.lang,
              "It's showing as available in the dealership's current inventory.",
              'Aparece disponible en el inventario actual de la agencia.',
            )
          : tr(
              t.lang,
              "I can't confirm it's still available — the team will double-check.",
              'No puedo confirmar que siga disponible — el equipo lo verificará.',
            ),
      );
    }
    const answered = bits.filter(Boolean);
    if (answered.length) t.answers.push(...answered);
    else {
      t.answers.push(
        tr(
          t.lang,
          "The listing doesn't include that detail, so I'd rather not guess.",
          'El anuncio no incluye ese dato, así que prefiero no adivinar.',
        ),
      );
      t.st.openQuestions = [
        ...t.st.openQuestions,
        redactCreditSensitive(t.message).slice(0, 160),
      ].slice(-5);
      this.ask(
        t,
        'confirm_handoff',
        tr(
          t.lang,
          'Want me to have someone confirm it for you?',
          '¿Quiere que alguien se lo confirme?',
        ),
        6,
      );
    }
  }

  private async handleCompare(t: Turn) {
    if (await this.capBlocked(t, 'vehicleCompare')) return;
    const vins = [
      ...new Set([
        ...(t.st.selectedVin ? [t.st.selectedVin] : []),
        ...t.st.compareVins,
        ...t.st.visibleVins,
      ]),
    ].slice(0, 3);
    if (vins.length < 2) {
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Which vehicles would you like to compare?',
          '¿Qué vehículos quiere comparar?',
        ),
        4,
      );
      return;
    }
    const vs = await this.inventory.getVehiclesByVin(t.tenantId, vins);
    t.st.compareVins = vs.map((v) => v.vin);
    t.vehicles = await this.withPaymentEstimates(t, vs);
    t.type = 'vehicle_compare';
    await this.attachVehicleEvidence(t, vs);
    this.signal(t, 'vehicle_compare');
    t.narration.push(
      tr(
        t.lang,
        "Here they are side by side — I've highlighted where they actually differ. Missing details just weren't in the listing.",
        'Aquí están lado a lado. Los datos que faltan no venían en el anuncio.',
      ),
    );
  }

  private async handleKnowledge(t: Turn) {
    const kc = await this.cap(t, 'knowledge');
    const ctx: string[] = [];
    if (kc.allowed) {
      const hits = await this.knowledge.search({
        tenantId: t.tenantId,
        locationId: t.locationId,
        query: t.message,
        forWidget: true,
        limit: 5,
      });
      for (const h of hits)
        ctx.push(`[${h.title}]\n${h.content.slice(0, 700)}`);
      void this.analytics.trackEvent(
        t.tenantId,
        t.locationId,
        hits.length ? 'knowledge_hit' : 'knowledge_miss',
        { count: hits.length },
        t.s.externalKey,
      );
      if (hits.length) {
        t.sources.add('knowledge_base');
        t.evidence.push(
          this.evidenceSvc.verifiedConfig(
            t.tenantId,
            t.locationId,
            'dealership_policy',
            hits.length,
            'knowledge_base',
            new Date().toISOString(),
          ),
        );
      }
    }
    t.toolCount += 1;
    const answer = await this.llm.answerIntelligentQuestion(t.message, ctx, {
      language: t.lang,
    });
    t.answers.push(stripFiller(answer));
    t.facts.push(...ctx.map((c) => c.slice(0, 300)));
  }

  private async handleTextContinuation(t: Turn) {
    const sms = await this.cap(t, 'sms');
    if (!sms.allowed) {
      t.answers.push(
        tr(
          t.lang,
          "Texting isn't set up for this dealership yet, but I can have someone call or email you.",
          'Los mensajes de texto aún no están disponibles, pero alguien le puede llamar o escribir.',
        ),
      );
      if (!t.st.contact.phone && !t.st.contact.email)
        this.ask(
          t,
          'contact_method',
          tr(
            t.lang,
            "What's the best number or email?",
            '¿Cuál es el mejor número o correo?',
          ),
          3,
        );
      return;
    }
    if (!t.st.contact.phone) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          'What mobile number should we text?',
          '¿A qué número celular le escribimos?',
        ),
        2,
      );
      return;
    }
    this.ask(
      t,
      'text_consent',
      tr(
        t.lang,
        `Just to confirm — is it OK for the dealership to text you at ${t.st.contact.phone} about this conversation? Msg & data rates may apply; reply STOP anytime.`,
        `Para confirmar — ¿está bien que la agencia le envíe mensajes al ${t.st.contact.phone} sobre esta conversación? Pueden aplicar tarifas; responda STOP para cancelar.`,
      ),
      1,
    );
  }

  private async handleContact(t: Turn) {
    const st = t.st;
    if (st.appointment?.id) {
      await this.prisma.appointment.updateMany({
        where: { id: st.appointment.id, tenantId: t.tenantId },
        data: {
          customerName: this.customerName(t) ?? undefined,
          customerPhone: st.contact.phone ?? undefined,
          customerEmail: st.contact.email ?? undefined,
        },
      });
    }
    if (st.parts?.inquiryId) {
      await this.prisma.partsInquiry.updateMany({
        where: { id: st.parts.inquiryId, tenantId: t.tenantId },
        data: {
          customerName: this.customerName(t) ?? undefined,
          customerPhone: st.contact.phone ?? undefined,
          customerEmail: st.contact.email ?? undefined,
        },
      });
    }
    if (st.trade?.requestId) {
      await this.prisma.tradeRequest.updateMany({
        where: { id: st.trade.requestId, tenantId: t.tenantId },
        data: {
          customerName: this.customerName(t) ?? undefined,
          customerPhone: st.contact.phone ?? undefined,
          customerEmail: st.contact.email ?? undefined,
        },
      });
    }
    const gotName = !!t.u.entities.contact?.firstName;
    const gotMethod = !!(
      t.u.entities.contact?.phone || t.u.entities.contact?.email
    );
    if (gotMethod) {
      t.narration.push(
        tr(
          t.lang,
          "Thanks — I've added that so the team can reach you.",
          'Gracias — lo agregué para que el equipo le contacte.',
        ),
      );
    } else if (gotName && !st.contact.phone && !st.contact.email) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          `Thanks, ${st.contact.firstName}. What's the best number or email to reach you?`,
          `Gracias, ${st.contact.firstName}. ¿Cuál es el mejor número o correo para contactarle?`,
        ),
        3,
      );
    } else if (gotName) {
      t.narration.push(
        tr(
          t.lang,
          `Thanks, ${st.contact.firstName}.`,
          `Gracias, ${st.contact.firstName}.`,
        ),
      );
    }
  }

  private async handleAffirm(t: Turn) {
    const p = t.st.pending ?? 'none';
    t.st.pending = 'none';
    if (p === 'confirm_credit_link') return this.handleCreditApp(t);
    if (p === 'confirm_handoff') return this.handleHandoff(t, 'request');
    if (p === 'text_consent') {
      if (!t.st.contact.phone) return;
      await this.prisma.consentRecord.create({
        data: {
          tenantId: t.tenantId,
          locationId: t.locationId,
          leadId: t.st.leadId ?? null,
          conversationExternalKey: t.s.externalKey,
          channel: 'SMS',
          endpoint: `+1${t.st.contact.phone.replace(/\D/g, '').slice(-10)}`,
          purpose: 'CONVERSATIONAL',
          granted: true,
          wording:
            'OK for the dealership to text you about this conversation? Msg & data rates may apply; reply STOP anytime.',
          wordingVersion: 'sms-continuation-v1',
          source: 'WIDGET',
        },
      });
      t.st.contact.consentToText = true;
      this.signal(t, 'text_consent');
      t.narration.push(
        tr(
          t.lang,
          "Got it — I've saved your OK to text. The team will continue there.",
          'Listo — guardé su autorización para mensajes de texto.',
        ),
      );
      return;
    }
    if (p === 'appointment_date' || p === 'appointment_time') {
      this.ask(
        t,
        p,
        tr(
          t.lang,
          'Great — what day and time work best?',
          'Perfecto — ¿qué día y hora le funcionan?',
        ),
        2,
      );
      return;
    }
    if (t.st.department === 'service')
      return this.handleAppointment(t, 'SERVICE');
    if (t.st.selectedVin && t.st.payment.lastEstimate)
      return this.handleAppointment(t, 'TEST_DRIVE');
    t.narration.push(tr(t.lang, 'Sounds good.', 'Muy bien.'));
    this.ask(
      t,
      'none',
      tr(
        t.lang,
        'What would you like to do next?',
        '¿Qué le gustaría hacer ahora?',
      ),
      9,
    );
  }

  private handleDecline(t: Turn) {
    t.st.pending = 'none';
    t.answers.push(
      tr(
        t.lang,
        "No problem — I'm here if you need anything else.",
        'Sin problema — aquí estoy si necesita algo más.',
      ),
    );
  }

  private async handleGreeting(t: Turn) {
    const dept = t.st.department;
    if (dept === 'service') {
      this.ask(
        t,
        'service_need',
        tr(
          t.lang,
          'What can I help with for your vehicle — maintenance, a repair, or something else?',
          '¿En qué le ayudo con su vehículo — mantenimiento, una reparación u otra cosa?',
        ),
        5,
      );
    } else if (dept === 'parts') {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Which part are you looking for? A VIN or part number helps the parts team confirm fitment.',
          '¿Qué pieza busca? El VIN o número de parte ayuda a confirmar compatibilidad.',
        ),
        5,
      );
    } else if (dept === 'sales') {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'What kind of vehicle are you shopping for?',
          '¿Qué tipo de vehículo busca?',
        ),
        5,
      );
    } else {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Are you shopping for a vehicle, or looking for service or parts?',
          '¿Busca un vehículo, o servicio o refacciones?',
        ),
        5,
      );
    }
  }

  private handleUnknown(t: Turn) {
    if (t.answers.length || t.narration.length) return;
    this.ask(
      t,
      'none',
      t.st.department === 'service'
        ? tr(
            t.lang,
            'Want me to request a service appointment, or check hours?',
            '¿Solicito una cita de servicio o le doy el horario?',
          )
        : tr(
            t.lang,
            'I can search inventory, estimate a payment, or set up a visit — what would help?',
            'Puedo buscar en el inventario, estimar un pago o agendar una visita — ¿qué le ayuda?',
          ),
      9,
    );
  }

  // ───────────────────────────────────────── lead sync

  private async syncLead(t: Turn) {
    const st = t.st;
    const hasContact = !!(
      st.contact.firstName &&
      (st.contact.phone || st.contact.email)
    );
    const actionable = st.signals.some((s) =>
      [
        'appointment_requested',
        'test_drive_requested',
        'trade_provided',
        'finance_interest',
        'handoff_requested',
        'service_request',
        'parts_request',
        'hold_requested',
      ].includes(s),
    );
    if (
      !hasContact &&
      !(actionable && (st.contact.phone || st.contact.email || st.leadId))
    )
      return;
    if (!(await this.cap(t, 'leadCapture')).allowed) return;
    const score = scoreJourney(st.signals, {
      hasAppointment: !!st.appointment && st.appointment.status !== 'CANCELLED',
      hasContact,
      hasVehicle: !!st.selectedVin,
      handoffOpen: !!st.handoff?.escalationId,
    });
    const lead = await this.leads.upsertJourneyLead({
      tenantId: t.tenantId,
      locationId: t.locationId,
      conversationId: t.s.conversationId,
      firstName: st.contact.firstName,
      lastName: st.contact.lastName,
      phone: st.contact.phone,
      email: st.contact.email,
      interestedVin: st.selectedVin,
      budget: st.criteria.maxPrice,
      desiredPayment: st.payment.maxMonthly,
      financingNeeded:
        st.signals.includes('finance_interest') ||
        st.signals.includes('credit_link_offered')
          ? true
          : undefined,
      leaseVsPurchase: st.payment.leaseOrPurchase,
      tradeInInterest: st.trade?.requestId ? true : undefined,
      purchaseTimeline: st.timeline,
      languagePreference: st.language,
      preferredContact:
        st.contact.preferredContact ??
        (st.contact.phone ? 'phone' : st.contact.email ? 'email' : undefined),
      consentToText: st.contact.consentToText,
      utmSource: st.attribution?.utmSource,
      utmMedium: st.attribution?.utmMedium,
      utmCampaign: st.attribution?.utmCampaign,
      source:
        st.department === 'service'
          ? 'widget_service'
          : st.department === 'parts'
            ? 'widget_parts'
            : 'widget',
      score: score.score,
      stage: score.stage,
      scoreReasons: score.reasons,
      scoreVersion: score.version,
      nextBestAction: score.nextBestAction,
    });
    const isNewLead = !st.leadId;
    st.leadId = lead.id;
    if (st.appointment?.id) {
      await this.prisma.appointment.updateMany({
        where: { id: st.appointment.id, tenantId: t.tenantId, leadId: null },
        data: { leadId: lead.id },
      });
    }
    if (isNewLead)
      void this.analytics.trackEvent(
        t.tenantId,
        t.locationId,
        'lead_captured',
        { stage: score.stage },
        t.s.externalKey,
      );
    // CRM writeback is capability-gated and durable (outbox) — never a fake sync.
    await this.crmSync.onLeadChanged(
      t.tenantId,
      t.locationId,
      lead.id,
      isNewLead ? 'lead.created' : 'lead.updated',
    );
  }

  // ───────────────────────────────────────── finish

  private journeySummary(t: Turn): JourneySummary {
    const st = t.st;
    const est = st.payment.lastEstimate;
    return {
      selectedVehicle: st.selectedVin
        ? {
            vin: st.selectedVin,
            label:
              (t.vehicles?.find((v) => v.vin === st.selectedVin) &&
                vehicleLabel(
                  t.vehicles.find((v) => v.vin === st.selectedVin)!,
                  true,
                )) ||
              st.selectedVin,
          }
        : null,
      payment: est
        ? {
            monthly: est.monthly,
            termMonths: est.termMonths,
            downPayment: est.downPayment,
            aprSource: est.aprSource,
          }
        : null,
      trade: st.trade?.requestId
        ? {
            summary: [st.trade.year, st.trade.make, st.trade.model]
              .filter(Boolean)
              .join(' '),
            requestId: st.trade.requestId,
          }
        : null,
      appointment: st.appointment
        ? {
            id: st.appointment.id,
            label: this.apptLabel(t, {
              requestedDate: st.appointment.requestedDate ?? null,
              requestedTime: st.appointment.requestedTime ?? null,
              type: st.appointment.type,
            }),
            status: st.appointment.status,
          }
        : null,
      creditApplication: st.finance?.creditLinkOffered
        ? { state: 'OFFERED' }
        : null,
      service: st.service?.need ? { need: st.service.need } : null,
      parts: st.parts?.inquiryId
        ? { need: st.parts.need, status: 'REQUESTED' }
        : null,
      handoff: st.handoff?.escalationId
        ? {
            state: st.handoff.notified
              ? 'notified'
              : st.handoff.queued
                ? 'queued'
                : 'recorded',
          }
        : null,
    };
  }

  /** Information still needed to act on something the customer already asked for. */
  private outstandingQuestion(t: Turn): Question | undefined {
    const st = t.st;
    const needsContact =
      (st.appointment &&
        ['REQUESTED', 'PENDING_CONFIRMATION'].includes(
          st.appointment.status,
        )) ||
      !!st.handoff?.escalationId;
    if (needsContact && !st.contact.firstName) {
      return {
        key: 'contact_name',
        text: tr(
          t.lang,
          'Who should the team ask for?',
          '¿A nombre de quién lo dejo?',
        ),
        priority: 10,
      };
    }
    if (needsContact && !st.contact.phone && !st.contact.email) {
      return {
        key: 'contact_method',
        text: tr(
          t.lang,
          "What's the best number or email to confirm with you?",
          '¿Cuál es el mejor número o correo para confirmarle?',
        ),
        priority: 10,
      };
    }
    if (
      st.pending === 'parts_vin' &&
      st.parts?.inquiryId &&
      !st.parts.vin &&
      !t.handled.has('PARTS_INQUIRY')
    ) {
      return {
        key: 'parts_vin',
        text: tr(
          t.lang,
          'Whenever you have it, the VIN lets the parts team confirm the right part.',
          'Cuando lo tenga, el VIN permite confirmar la pieza correcta.',
        ),
        priority: 10,
      };
    }
    return undefined;
  }

  private staffHandlingResponse(s: TurnSession): ChatResponse {
    return {
      reply: '',
      segments: [],
      type: 'staff_handling',
      cards: [],
      quickReplies: [],
      journey: {},
      provenance: { sources: [], verifiedFactsOnly: true },
      evidence: [],
      conversation: {
        language: s.state.language ?? 'en',
        handoffState: s.handoffState,
        aiPaused: true,
        pending: 'none',
      },
      delivery: { urgent: true, toolCount: 0, minTypingMs: 0, maxTypingMs: 0 },
    };
  }

  private async finish(
    t: Turn,
    opts: { forcedReply?: string; started: number },
  ): Promise<ChatResponse> {
    const st = t.st;
    // Exactly one follow-up question: highest priority wins; it defines `pending`.
    const ranked = [...t.questions].sort((a, b) => a.priority - b.priority);
    // Don't nag: an informational question the customer just skipped isn't repeated verbatim
    // on the very next turn (unless it's required to complete what they asked right now).
    const skipped = (k: PendingQuestion) =>
      k !== 'none' &&
      st.lastAsked?.key === k &&
      st.lastAsked.turn === st.turnCount &&
      !t.u.intents.some((i) => i.intent === 'PROVIDE_CONTACT');
    let q: Question | undefined = ranked.find(
      (x) => x.priority <= 2 || !skipped(x.key),
    );
    let silentPending: PendingQuestion | undefined;
    if (!q && !opts.forcedReply) {
      const o = this.outstandingQuestion(t);
      if (o && !skipped(o.key)) q = o;
      else if (o) silentPending = o.key; // still awaiting it — just don't nag
    }
    if (q && q.key !== 'none')
      st.lastAsked = { key: q.key, turn: st.turnCount + 1 };
    st.pending = q?.key ?? silentPending ?? 'none';
    const ack = chooseAcknowledgement({
      sentiment: t.u.sentiment,
      intents: t.u.intents.map((i) => i.intent),
      isCorrection: t.isCorrection,
      lang: t.lang,
      recentOpeners: st.recentOpeners,
    });
    const plan = compose({
      acknowledgement: opts.forcedReply ? undefined : ack,
      directAnswer: opts.forcedReply ? [opts.forcedReply] : t.answers,
      actionNarration: opts.forcedReply ? [] : t.narration,
      followUpQuestion: opts.forcedReply ? undefined : q?.text,
    });
    let draft =
      plan.text || tr(t.lang, 'How can I help?', '¿En qué le puedo ayudar?');
    if (signature(draft) === st.lastReplySig && q) {
      draft =
        `${t.answers.concat(t.narration).join(' ')} ${tr(t.lang, 'Or is there something else I can help with?', '¿O hay algo más en lo que le pueda ayudar?')}`.trim();
    }

    // Language layer: polish with LLM (router → fallback). Claims present in the server
    // draft were produced from tool evidence; anything NEW the model adds is stripped.
    const mode: DealerReplyMode =
      st.department === 'service'
        ? 'service'
        : st.department === 'parts'
          ? 'parts'
          : st.department === 'sales'
            ? 'sales'
            : 'general';
    let reply = draft;
    let segments = plan.segments.length ? plan.segments : [draft];
    const usePolish =
      !opts.forcedReply &&
      !t.urgent &&
      draft.length > 0 &&
      !t.cards.some((c) => c.kind === 'payment' || c.kind === 'appointment');
    if (usePolish) {
      const polished = await this.llm.polishDealerReply({
        draft,
        mode,
        facts: t.facts.join('\n') || undefined,
        userMessage: redactCreditSensitive(t.message),
        language: t.lang,
      });
      if (polished && polished !== draft) {
        const g = this.grounding.sanitizeCustomerReply({
          reply: polished,
          verifiedFacts: verifiedFactsFrom(t.evidence),
          allowedClaimTypes: detectClaimTypes(draft),
        });
        if (g.sanitized) {
          // Model added an unverified claim → discard the polish entirely, keep the draft.
          this.metrics.increment('chat.grounding.sanitized');
        } else {
          reply = stripFiller(polished);
          segments = [reply];
        }
      }
    }
    if (ack) st.recentOpeners = [...st.recentOpeners, ack].slice(-4);
    st.lastReplySig = signature(reply);
    st.turnCount += 1;

    const handoffState = t.conversationExtra.handoffState;
    await this.store.save(t.s, handoffState ? { handoffState } : {});
    const evidence = publicEvidence(t.evidence);
    const sources = [...t.sources];
    const inventoryAsOf = t.evidence
      .filter((e) => e.field === 'inventory_availability' && e.sourceUpdatedAt)
      .map((e) => e.sourceUpdatedAt!)
      .sort()
      .pop();
    const disclaimers = [
      ...new Set(
        t.evidence.filter((e) => e.disclaimer).map((e) => e.disclaimer!),
      ),
    ];
    const provenance: ChatProvenance = {
      sources,
      inventoryAsOf: inventoryAsOf ?? null,
      verifiedFactsOnly: t.evidence.every((e) => e.verified || !!e.disclaimer),
      disclaimer: disclaimers.slice(0, 2).join(' ') || undefined,
    };
    await this.store.appendMessage(t.s, 'ASSISTANT', reply, {
      type: t.type ?? 'reply',
      intents: t.u.intents.map((i) => i.intent),
      cards: t.cards.map((c) => ({
        kind: c.kind,
        ...('id' in c ? { id: c.id } : {}),
      })),
      vins: t.vehicles?.map((v) => v.vin),
      evidence: evidence.map((e) => ({
        field: e.field,
        verified: e.verified,
        source: e.source,
      })),
      language: t.lang,
    });
    this.metrics.increment('chat.latency_ms_total', Date.now() - opts.started);
    const hint = deliveryHint({
      textLength: reply.length,
      toolCount: t.toolCount,
      urgent: t.urgent,
      isError: !!opts.forcedReply,
    });
    return {
      reply,
      segments,
      type: t.type,
      vehicles: t.vehicles,
      ...(t.type === 'payment_summary' && t.legacyPayment
        ? t.legacyPayment
        : {}),
      cards: t.cards,
      quickReplies: t.quickReplies,
      journey: this.journeySummary(t),
      provenance,
      evidence,
      conversation: {
        language: t.lang,
        handoffState: handoffState ?? t.s.handoffState,
        aiPaused: false,
        pending: st.pending ?? 'none',
      },
      delivery: { urgent: t.urgent, toolCount: t.toolCount, ...hint },
    };
  }
}
