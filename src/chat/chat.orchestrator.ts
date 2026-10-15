import { Injectable, Logger } from '@nestjs/common';
import { EscalationUrgency } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  JourneyState,
  OfferKind,
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
import { AppraisalService } from '../trade/appraisal.service';
import { ExperimentsService } from '../experiments/experiments.service';
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
import { ConversationComposerService } from './compose/conversation-composer.service';
import { LiveInfoService } from '../live-info/live-info.service';
import { mergePublicBranding } from '../common/types/public-branding';
import { generalAnswer } from './dialogue/general-knowledge';
import {
  needsModelUnderstanding,
  mergeInterpretation,
} from './understanding/model-interpretation';
import { ClaudeConversationService } from './claude/claude-conversation.service';
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
import {
  addDays as addDaysLocal,
  formatClock,
  parseIsoDate,
} from '../common/time/zoned-time';
import { CrmSyncService } from '../integrations/crm/crm-sync.service';
import { PriceQuoteService } from '../finance/price-quote.service';
import { estimateOutTheDoor, OtdLine } from '../finance/otd-quote';
import { answerDealershipFact } from './dialogue/dealership-facts';
import { incidentRank } from './safety/customer-incident';
import { seedOf, socialLine, vary } from './dialogue/social';
import { CampaignEngine } from '../messaging/campaign.engine';
import { ConsentService } from '../messaging/consent.service';

export type ChatProvenance = {
  sources: string[];
  inventoryAsOf?: string | null;
  disclaimer?: string;
  verifiedFactsOnly: boolean;
  /**
   * Whether a language model shaped this reply: `polished` (model rewrite of the server draft
   * passed the grounding guard), `answered` (model answered a knowledge question from verified
   * data), `discarded` (model output rejected by the grounding guard; draft sent), `none`.
   * Lets operators and the live-model evaluation prove genuine model replies.
   */
  languageModel?:
    | 'composed'
    | 'repaired'
    | 'polished'
    | 'answered'
    | 'discarded'
    | 'none';
  /** Why the model's reply was not used (validator reasons), when it wasn't. */
  fallbackReason?: string;
  /** True when a language model helped understand this turn (proposal validated + merged). */
  modelInterpreted?: boolean;
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
      /** Customer-facing CTA, e.g. "Apply for Financing". */
      cta: string;
      /** Short reassurance shown under the CTA. */
      note: string;
      /** Non-production demo preview — card is labeled; click never reaches the vendor. */
      preview: boolean;
    }
  | {
      kind: 'otd_quote';
      id: string;
      vin: string;
      vehicleLabel: string;
      status: 'estimate' | 'requested';
      paymentMethod: 'CASH' | 'FINANCE' | 'LEASE' | 'UNDECIDED';
      lines: OtdLine[];
      total: number | null;
      assumptions: string[];
      missingInputs: string[];
      /** Always true: a preliminary figure, never a written dealer offer. */
      preliminary: true;
    }
  | { kind: 'finance_request'; id: string; status: string }
  | {
      kind: 'trade';
      id: string;
      summary: string;
      /** true only when a staff appraisal/offer (or licensed provider value) is shown */
      appraisalVerified: boolean;
      value?: {
        kind:
          | 'MARKET_ESTIMATE'
          | 'PRELIMINARY_ESTIMATE'
          | 'DEALER_APPRAISAL'
          | 'FINAL_OFFER';
        amount: number | null;
        low: number | null;
        high: number | null;
        expiresAt: string | null;
      } | null;
    }
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
      vehicleLabel?: string;
      /** Finance estimate. Never a lease payment. */
      product: 'finance';
      status: 'estimate';
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
    vin: string;
    monthly: number;
    termMonths: number;
    downPayment: number;
    aprSource: string;
    product: 'finance';
    status: 'estimate';
    includesTaxAndFees: boolean;
  } | null;
  trade?: { summary: string; requestId?: string } | null;
  appointment?: { id: string; label: string; status: string } | null;
  creditApplication?: { state: string } | null;
  otdQuote?: {
    status: string;
    total: number | null;
    vin?: string;
  } | null;
  service?: { need?: string; vehicle?: string } | null;
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

type Question = {
  key: PendingQuestion;
  text: string;
  priority: number;
  /** What a "yes" means; inferred from the key/text when not given. */
  offer?: OfferKind;
};

/** What the chosen follow-up question offers, so the next short reply can be interpreted. */
function offerFor(q: Question): OfferKind {
  if (q.offer) return q.offer;
  const byKey: Partial<Record<PendingQuestion, OfferKind>> = {
    confirm_credit_link: 'credit',
    confirm_handoff: 'handoff',
    appointment_date: 'date',
    appointment_time: 'date',
    contact_name: 'contact',
    contact_method: 'contact',
    otd_zip: 'zip',
    figure_meaning: 'choice',
    vehicle_choice: 'pick_vehicle',
    service_need: 'service',
    service_vehicle: 'service',
    payment_method: 'other',
  };
  if (byKey[q.key]) return byKey[q.key]!;
  const x = q.text.toLowerCase();
  if (
    /adjust the down payment|adjust .*term|another down payment|different down payment/.test(
      x,
    ) &&
    !/, or /.test(x)
  )
    return 'adjust_payment';
  if (
    /model you have your eye on|anything specific|something in mind|what are you looking for|narrow it down/.test(
      x,
    )
  )
    return 'discovery';
  // "A or B?" — a bare "yes" doesn't pick one.
  if (
    /\?\s*$/.test(x) &&
    /\b(?:or|o)\b (?:the |a |an )?[a-z-]+/.test(x) &&
    !/\bor (?:not|something|anything)\b/.test(x)
  )
    return 'choice';
  if (/per month|a month|payments? (?:might|would|look)|monthly/.test(x))
    return 'payment';
  if (/out-the-door|out the door/.test(x)) return 'otd';
  if (/credit application/.test(x)) return 'credit';
  if (/test[- ]drive|come in|come by|stop by|set up a time|visit/.test(x))
    return 'visit';
  if (/similar|other options|show you/.test(x)) return 'similar';
  if (/someone from the team|a person|reach out|confirm it for you/.test(x))
    return 'handoff';
  if (
    /model you have your eye on|anything specific|something in mind|what are you looking for|narrow it down/.test(
      x,
    )
  )
    return 'discovery';
  return 'other';
}

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
  languageModel: NonNullable<ChatProvenance['languageModel']>;
  modelInterpreted: boolean;
  fallbackReason?: string;
  /** Live data retrieved this turn (weather …), passed to the composer as its only live source. */
  live?: string;
  urgent: boolean;
  /** Skip model polish so safety wording cannot be rewritten. */
  lockReply?: boolean;
  quickReplies: string[];
  /** Social opener for this turn ("Hi there!") — replaces the generic acknowledgement. */
  socialPrefix?: string;
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

/** "red Wrangler" → "Wrangler rojo" for Spanish replies (plain colors only). */
function esColorLabel(label: string): string {
  const ES: Record<string, string> = {
    black: 'negro',
    white: 'blanco',
    red: 'rojo',
    blue: 'azul',
    gray: 'gris',
    grey: 'gris',
    silver: 'plateado',
    green: 'verde',
    yellow: 'amarillo',
    orange: 'naranja',
    brown: 'café',
    beige: 'beige',
    gold: 'dorado',
  };
  const m = /^(\w+)\s+(.+)$/.exec(label);
  return m && ES[m[1].toLowerCase()]
    ? `${m[2]} ${ES[m[1].toLowerCase()]}`
    : label;
}

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
    // Named paint colors keep their casing ("Silver Zynith"); plain ones read naturally ("black").
    withColor && v.color
      ? /^(black|white|red|blue|gray|grey|silver|green|yellow|orange|brown|beige|gold|tan|maroon|purple)$/i.test(
          v.color.trim(),
        )
        ? v.color.trim().toLowerCase()
        : v.color.trim()
      : null,
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
    private readonly composer: ConversationComposerService,
    private readonly liveInfo: LiveInfoService,
    private readonly grounding: GroundingGuardService,
    private readonly evidenceSvc: ClaimEvidenceService,
    private readonly analytics: AnalyticsService,
    private readonly metrics: MetricsService,
    private readonly outbox: OutboxService,
    private readonly crmSync: CrmSyncService,
    private readonly campaigns: CampaignEngine,
    private readonly consent: ConsentService,
    private readonly quotes: PriceQuoteService,
    private readonly appraisals: AppraisalService,
    private readonly experiments: ExperimentsService,
  ) {}

  /** First greeting copy, optionally from a RUNNING greeting experiment (tone only). */
  private async greetingLine(t: Turn, salt: string) {
    const ex = await this.experiments.greetingFor(
      t.tenantId,
      t.locationId,
      t.s.externalKey,
      !!t.st.social?.experimentExposed,
    );
    if (ex && t.lang === 'en') {
      t.st.social = { ...t.st.social, experimentExposed: true };
      return ex.text;
    }
    return socialLine(
      'greetingFirst',
      t.lang,
      t.st.recentOpeners,
      this.seed(t, salt),
    );
  }

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
    let u = understandTurn(rawMessage, {
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
      knownModels: st.visibleModels ?? [],
      knownTrims: st.visibleTrims ?? [],
      hasPaymentEstimate: !!st.payment.lastEstimate,
      hasCriteria: Object.keys(st.criteria ?? {}).length > 0,
      creditOffered: !!st.finance?.creditLinkOffered,
      incidentActive: !!st.incident && !st.incident.safeNow,
      incidentSeverity: st.incident?.severity,
      tradeOpen: !!st.trade || st.pending === 'trade_vehicle',
    });

    // Model-assisted understanding only when the rules found nothing specific to act on.
    let modelInterpreted = false;
    if (
      needsModelUnderstanding(u, rawMessage, {
        hasContext: !!st.selectedVin || st.visibleVins.length > 0,
      }) &&
      !u.entities.sensitive?.length &&
      this.llm.isEnabled() &&
      !(await this.capabilities.flags(tenantId, s.locationId)).llmDisabled
    ) {
      const m = await this.llm.interpretTurn({
        message: redactCreditSensitive(rawMessage),
        context:
          [
            st.department ? `department: ${st.department}` : null,
            st.selectedLabel ? `selected vehicle: ${st.selectedLabel}` : null,
            st.selectedStatus
              ? `selected vehicle status: ${st.selectedStatus}`
              : null,
            st.lastOffer?.text
              ? `assistant's last question: ${st.lastOffer.text.slice(0, 160)}`
              : st.pending && st.pending !== 'none'
                ? `assistant just asked: ${st.pending}`
                : null,
            st.visibleVins.length > 1
              ? `${st.visibleVins.length} vehicles on screen`
              : null,
            st.service?.need ? `service need: ${st.service.need}` : null,
            st.appointment
              ? `has ${st.appointment.type} appointment request`
              : null,
          ]
            .filter(Boolean)
            .join('\n') || 'start of conversation',
        tenantId,
      });
      if (m) {
        const merged = mergeInterpretation(u, m, rawMessage);
        if (merged !== u) {
          u = merged;
          modelInterpreted = true;
          this.metrics.increment('chat.model_interpreted');
        }
      }
    }

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
      languageModel: 'none',
      modelInterpreted,
      urgent: false,
      quickReplies: [],
      // "Actually, …" opening a new request is not a correction of what we just did.
      isCorrection:
        /\b(instead|i meant|correction|no,? i said|en realidad|mejor)\b/i.test(
          rawMessage,
        ) ||
        /^\s*actually,?\s+(?:make it|change|i meant|no)\b/i.test(rawMessage),
      capCache: new Map(),
      handled: new Set(),
      conversationExtra: {},
    };

    // Language: explicit choice or confident detection; stays sticky once chosen.
    if (hasIntent(u, 'LANGUAGE_SWITCH') && u.entities.language) {
      st.language = u.entities.language;
      // "hablas español?" is a question, not a standing preference: follow the customer's
      // current language afterwards. Only an explicit request ("in Spanish please") sticks.
      st.languageLocked =
        /\b(?:please|por favor|from now on|de ahora en adelante|switch to|cambia(?:mos)? a|only|solo)\b/i.test(
          rawMessage,
        ) ||
        /^\s*(?:en español|in english|in spanish|english|español)\s*[.!]*\s*$/i.test(
          rawMessage,
        );
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
    if (t.u.entities.incident) {
      await this.handleCustomerIncident(t);
      t.handled.add('COMPLAINT');
      t.handled.add('HUMAN_HANDOFF');
      t.handled.add('SAFETY_URGENT');
      if (t.u.entities.incident.safeNow) t.handled.add('DECLINE');
    } else if (t.u.entities.taxQuestion) {
      await this.handleTaxQuestion(t);
      t.handled.add('OTD_QUOTE');
      t.handled.add('VEHICLE_QUESTION');
    } else if (
      t.u.entities.statedAmount != null ||
      t.u.entities.statedAmountRole === 'price'
    ) {
      await this.handleStatedAmount(t);
      t.handled.add('OTD_QUOTE');
      t.handled.add('INVENTORY_SEARCH');
      t.handled.add('PAYMENT_ESTIMATE');
    }
    const intents = this.planIntents(t, input);
    if (!intents.some((i) => i === 'UNKNOWN' || i === 'KNOWLEDGE_QUESTION'))
      st.fallbacks = 0;
    if (await this.handleFollowUp(t)) {
      for (const i of [
        'UNKNOWN',
        'SMALL_TALK',
        'GREETING',
        'AFFIRM',
        'KNOWLEDGE_QUESTION',
        'SELECT_VEHICLE',
      ] as const)
        t.handled.add(i);
    }
    if (u.entities.notAnswered) {
      this.handleNotAnswered(t);
      t.handled.add('UNKNOWN');
      t.handled.add('COMPLAINT');
      t.handled.add('SMALL_TALK');
    }

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

    await this.syncTradeTarget(t);
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
    if (input.vin && input.vin.toUpperCase() !== st.selectedVin) {
      st.selectedVin = input.vin.toUpperCase();
      st.selectedLabel = undefined; // set by the handler that loads the vehicle
    }
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
      e.ownVehicle &&
      (hasIntent(u, 'SERVICE_APPOINTMENT') || st.department === 'service')
    )
      st.service = { ...st.service, vehicle: e.ownVehicle };
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
      hasIntent(u, 'TRADE_IN') ||
      (hasIntent(u, 'SELECT_VEHICLE') &&
        !(st.pending === 'parts_vin' && e.vin) &&
        !e.ownVehicle) ||
      hasIntent(u, 'COMPARE') ||
      hasIntent(u, 'OTD_QUOTE') ||
      hasIntent(u, 'SHOPPING_START') ||
      (hasIntent(u, 'PAYMENT_ESTIMATE') && st.department !== 'finance')
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
      case 'SAFETY_URGENT':
        return this.handleSafety(t);
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
      case 'SMALL_TALK':
        return this.handleSocial(t);
      case 'SHOPPING_START':
        return this.handleShoppingStart(t);
      case 'OTD_QUOTE':
        return this.handleOtd(t);
      case 'PURCHASE_START':
        return this.handlePurchase(t);
      case 'CHANGE_OF_MIND':
        return this.handleChangeOfMind(t);
      case 'RESUME_VEHICLE':
        return this.handleResume(t);
      case 'LIVE_INFO':
        return this.handleLiveInfo(t);
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

  private ask(
    t: Turn,
    key: PendingQuestion,
    text: string,
    priority: number,
    offer?: OfferKind,
  ) {
    t.questions.push({ key, text, priority, ...(offer ? { offer } : {}) });
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

  /** Stable per-turn seed so phrasing varies across turns but is reproducible in tests. */
  private seed(t: Turn, salt = '') {
    return seedOf(t.s.externalKey, t.st.turnCount, salt);
  }

  private pick(t: Turn, options: string[], salt = '') {
    return vary(options, t.st.recentOpeners, this.seed(t, salt));
  }

  /** Remember models on screen so "that Wrangler" later refers to them. */
  private rememberModels(t: Turn, vehicles: InventoryVehicle[]) {
    const models = vehicles
      .map((v) => (v.model ?? '').toLowerCase())
      .filter(Boolean);
    t.st.visibleModels = [
      ...new Set([...(t.st.visibleModels ?? []), ...models]),
    ].slice(-12);
    t.st.visibleTrims = vehicles
      .map((v) => (v.trim ?? '').toLowerCase().trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  /** One-time, plain-language note that the demo runs on simulated inventory. */
  private noteSimulated(t: Turn, vehicles: InventoryVehicle[]) {
    if (!vehicles.some((v) => v.simulated) || t.st.social?.demoNoted) return;
    t.st.social = { ...t.st.social, demoNoted: true };
    t.narration.push(
      tr(
        t.lang,
        '(Heads up: this demo runs on simulated vehicles, not the dealership’s live inventory.)',
        '(Nota: esta demostración usa vehículos simulados, no el inventario real de la agencia.)',
      ),
    );
  }

  /**
   * ONE useful next step for the sales journey — chosen from what the customer has NOT done
   * yet, so we never repeat the same menu after every reply.
   */
  private salesNextStep(t: Turn, label?: string): string | null {
    const st = t.st;
    const it = label
      ? tr(t.lang, `the ${label}`, `el ${label}`)
      : tr(t.lang, 'it', 'eso');
    if (!st.payment.lastEstimate)
      return this.pick(
        t,
        t.lang === 'es'
          ? [`¿Quiere ver cómo quedarían los pagos de ${it}?`]
          : [
              `Want to see what payments might look like on ${it}?`,
              `Curious what ${it} would run per month?`,
            ],
        'next-pay',
      );
    if (!st.otd?.requestId)
      return tr(
        t.lang,
        'Would an out-the-door price help, or would you rather see it in person first?',
        '¿Le sirve un precio final, o prefiere verlo en persona primero?',
      );
    if (!st.appointment)
      return tr(
        t.lang,
        'Would you like to come take it for a test drive?',
        '¿Le gustaría venir a manejarlo?',
      );
    return null;
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
    // Named paint colors that only exist on the cars shown ("the Earl one", "the Hydro Blue").
    if (!want?.color && visible.length > 1) {
      const msg = ` ${t.message.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
      const byPaint = visible.filter((v) => {
        const c = (v.color ?? '').toLowerCase().trim();
        return c.length >= 3 && msg.includes(` ${c} `);
      });
      const byWord = byPaint.length
        ? byPaint
        : visible.filter((v) =>
            (v.color ?? '')
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.length >= 4 && msg.includes(` ${w} `)),
          );
      if (byWord.length === 1) return { v: byWord[0] };
    }
    if (want?.color)
      cands = cands.filter((v) =>
        (v.color ?? '').toLowerCase().includes(want.color!),
      );
    if (want?.model)
      cands = cands.filter((v) =>
        (v.model ?? '').toLowerCase().includes(want.model!.toLowerCase()),
      );
    if (want?.trim) {
      const tw = want.trim.toLowerCase();
      const exact = cands.filter((v) =>
        new RegExp(
          `(^|\\s)${tw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`,
        ).test((v.trim ?? '').toLowerCase()),
      );
      cands = exact.length
        ? exact
        : cands.filter((v) => (v.trim ?? '').toLowerCase().includes(tw));
    }
    if (cands.length === 1) return { v: cands[0] };
    // Several match, but one is the vehicle they already chose → that's the one they mean.
    const chosen = cands.find((c) => c.vin === t.st.selectedVin);
    if (cands.length > 1 && chosen && !want?.color && !ord)
      return { v: chosen };
    if (cands.length > 1) {
      if (e.rank) return { v: this.rankVehicles(cands, e.rank)[0] };
      return { ambiguous: cands.slice(0, 3) };
    }
    if (want?.model) {
      // "back to the Wrangler" when the Wrangler is no longer on screen: the selected vehicle
      // if it matches, otherwise the one verified vehicle of that model (never a guess).
      if (
        t.st.selectedVin &&
        (t.st.selectedLabel ?? '')
          .toLowerCase()
          .includes(want.model.toLowerCase())
      ) {
        const v = await this.inventory.getVehicleByVin(
          t.tenantId,
          t.st.selectedVin,
        );
        if (v) return { v };
      }
      const found = await this.inventory.searchVehicles({
        tenantId: t.tenantId,
        locationId: t.locationId,
        model: want.model,
        limit: 4,
      });
      if (found.length === 1) return { v: found[0] };
      if (found.length > 1) return { ambiguous: found.slice(0, 3) };
      return {};
    }
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

  private rankVehicles(
    vs: InventoryVehicle[],
    rank: NonNullable<TurnUnderstanding['entities']['rank']>,
  ) {
    const by = rank.by;
    return [...vs].sort((a, b) =>
      by === 'price_asc'
        ? (a.price ?? Infinity) - (b.price ?? Infinity)
        : by === 'year_desc'
          ? (b.year ?? 0) - (a.year ?? 0)
          : by === 'miles_asc'
            ? (a.mileage ?? Infinity) - (b.mileage ?? Infinity)
            : (b.price ?? 0) - (a.price ?? 0),
    );
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
    // A lease question must not wear a finance estimate on the vehicle card.
    if (
      t.st.payment.leaseOrPurchase === 'lease' ||
      t.u.entities.leaseOrPurchase === 'lease'
    )
      return vehicles.map((v) => ({ ...v, estimatedPayment: undefined }));
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

  /**
   * Customer-reported incident. Words stay unverified. One escalation is updated
   * in place. Danger advice is to move away and call emergency services — never
   * to the car or to the person they named. Nothing is described as contacted
   * unless a delivery actually succeeded.
   */
  private async handleCustomerIncident(t: Turn) {
    const inc = t.u.entities.incident;
    if (!inc) return;
    const st = t.st;
    const names = [
      ...new Set([
        ...(st.incident?.reportedNames ?? []),
        ...(inc.reportedName ? [inc.reportedName] : []),
      ]),
    ];
    const prev = st.incident?.severity;
    const severity =
      prev && incidentRank(prev) > incidentRank(inc.severity)
        ? prev
        : inc.severity;
    st.incident = {
      severity: inc.safeNow ? (prev ?? severity) : severity,
      safeNow: inc.safeNow || st.incident?.safeNow,
      reportedNames: names,
      withholdContact:
        (inc.safeNow ? (prev ?? severity) : severity) === 'danger',
    };
    const danger = st.incident.severity === 'danger' && !inc.safeNow;
    t.urgent = danger;
    if (danger) t.lockReply = true;

    if (danger && inc.insideDealership) {
      t.answers.push(
        tr(
          t.lang,
          "You're inside the dealership. Stay in a public area away from the person you reported, or leave the building if you can do that safely. If you still feel in danger, contact emergency services at 911. I have not contacted the police or anyone at the store, and I won't ask you to return to your vehicle or to approach that person.",
          'Está dentro de la agencia. Quédese en un área pública, lejos de la persona que reportó, o salga del edificio si puede hacerlo con seguridad. Si aún se siente en peligro, llame al 911. No he contactado a la policía ni a nadie de la agencia, y no le voy a pedir que regrese a su vehículo ni que se acerque a esa persona.',
        ),
      );
    } else if (danger && !inc.continuing) {
      t.answers.push(
        tr(
          t.lang,
          "If you can, move away from that person to a safer place and contact emergency services at 911. What you reported is not a confirmed fact. I have not contacted the police or the dealership. Stay away from the vehicle you arrived in, and don't approach anyone you reported, if that doesn't feel safe.",
          'Si puede, aléjese de esa persona a un lugar más seguro y llame al 911. Lo que reportó no es un hecho confirmado. No he contactado a la policía ni a la agencia. Manténgase lejos del vehículo en el que llegó y no se acerque a la persona que reportó si eso no se siente seguro.',
        ),
      );
    } else if (danger) {
      t.answers.push(
        tr(
          t.lang,
          `I'll add that to the same report${inc.reportedName ? `, including the name ${inc.reportedName}` : ''}. That's what you reported — I haven't verified it. If you're still near that person, move somewhere safer and contact 911. I have not contacted anyone.`,
          `Lo agrego al mismo reporte${inc.reportedName ? `, incluido el nombre ${inc.reportedName}` : ''}. Es lo que usted reportó — no lo he verificado. Si sigue cerca de esa persona, vaya a un lugar más seguro y llame al 911. No he contactado a nadie.`,
        ),
      );
    } else if (inc.safeNow) {
      t.answers.push(
        tr(
          t.lang,
          `I'm glad you're okay. I'll leave the safety steps there.${names.length ? ` I won't send you back to ${names.join(', ')}.` : ''} If you still want help with a vehicle, tell me and we'll stay with someone else.`,
          `Me alegra que esté bien. Dejo ahí los pasos de seguridad.${names.length ? ` No lo voy a enviar de vuelta con ${names.join(', ')}.` : ''} Si aún quiere ayuda con un vehículo, dígame y seguimos con otra persona.`,
        ),
      );
    } else {
      t.answers.push(
        tr(
          t.lang,
          `I'm sorry that happened. I'm recording this as what you reported, not as a confirmed fact.${inc.reportedName ? ` I'll note the name ${inc.reportedName} on that report.` : ''}`,
          `Lamento que haya pasado. Lo registro como lo que usted reportó, no como un hecho confirmado.${inc.reportedName ? ` Anoto el nombre ${inc.reportedName} en ese reporte.` : ''}`,
        ),
      );
    }

    if (!(await this.cap(t, 'handoff')).allowed) {
      t.narration.push(
        tr(
          t.lang,
          "I can't route this to staff while handoff is turned off. I have not contacted anyone.",
          'No puedo enviar esto al personal mientras la transferencia está apagada. No he contactado a nadie.',
        ),
      );
      return;
    }

    const loc = t.locationId
      ? await this.prisma.location.findFirst({
          where: { id: t.locationId, tenantId: t.tenantId },
          select: { escalationRecipients: true },
        })
      : null;
    const recipientsConfigured = Boolean(loc?.escalationRecipients?.trim());
    const line = [
      `[customer-reported, unverified] ${inc.severity}`,
      inc.safeNow ? 'customer says they are safe now' : null,
      inc.insideDealership
        ? 'customer says they are inside the dealership'
        : null,
      inc.reportedName ? `reported name: ${inc.reportedName}` : null,
      names.length
        ? `do not assign to reported staff: ${names.join(', ')}`
        : null,
      `"${redactCreditSensitive(t.message).slice(0, 240)}"`,
    ]
      .filter(Boolean)
      .join(' — ');
    const recorded = await this.escalations.appendCustomerReport({
      tenantId: t.tenantId,
      locationId: t.locationId,
      externalKey: t.s.externalKey,
      reason:
        inc.severity === 'danger'
          ? 'Customer reported immediate danger (unverified)'
          : inc.severity === 'allegation'
            ? 'Customer reported a serious allegation (unverified)'
            : 'Customer reported a complaint (unverified)',
      urgency:
        inc.severity === 'danger'
          ? EscalationUrgency.CRITICAL
          : EscalationUrgency.HIGH,
      line,
      metadata: {
        kind: 'customer_incident',
        severity: inc.severity,
        reportedNames: names,
        unverified: true,
        recipientsConfigured,
        doNotAssignTo: names,
      },
    });
    st.handoff = {
      escalationId: recorded.escalation.id,
      notified: recorded.notified,
      queued: recorded.queued,
    };
    t.conversationExtra.handoffState = recorded.notified
      ? 'QUEUED'
      : 'REQUESTED';
    if (!recorded.deduped) {
      t.cards.push({
        kind: 'handoff',
        state: recorded.notified
          ? 'notified'
          : recorded.queued
            ? 'queued'
            : 'recorded',
        escalationId: recorded.escalation.id,
      });
    }
    if (!inc.safeNow) {
      const delivery = !recorded.channelConfigured
        ? `I've saved this on the staff record${recipientsConfigured ? '' : ', and this store has no escalation recipients on file'}. No notification channel is configured, so I have not contacted the staff, the police, or emergency services.`
        : recorded.notified
          ? 'A staff notification was already delivered for this conversation. I added what you just said to that same record. I have not contacted the police.'
          : recorded.queued
            ? 'The staff notification is still retrying. I added this to the same record. I have not contacted emergency services.'
            : 'I saved this for the team. Delivery has not been confirmed, so I am not saying that anyone was contacted.';
      t.narration.push(tr(t.lang, delivery, delivery));
    }
    if (
      inc.severity !== 'danger' &&
      !inc.safeNow &&
      !st.contact.phone &&
      !st.contact.email
    ) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          "If you want a manager who wasn't involved to reach you, what's the best number or email?",
          'Si quiere que le contacte un gerente que no estuvo involucrado, ¿cuál es el mejor número o correo?',
        ),
        4,
      );
    }
  }

  /** A stated dollar figure is not assumed to be price, down payment, or tax. */
  private async handleStatedAmount(t: Turn) {
    const role = t.u.entities.statedAmountRole ?? t.st.statedFigure?.role;
    const amount = t.u.entities.statedAmount ?? t.st.statedFigure?.amount;
    if (amount == null) return;
    let v: InventoryVehicle | null = null;
    if (t.st.selectedVin)
      v = await this.inventory.getVehicleByVin(t.tenantId, t.st.selectedVin);
    const label = v ? vehicleLabel(v, true) : t.st.selectedLabel;
    t.st.statedFigure = {
      amount,
      role:
        role === 'price' || role === 'down' || role === 'otd'
          ? role
          : 'unclear',
      vin: v?.vin,
    };
    if (role === 'price' && v?.price) {
      t.answers.push(
        v.price === amount
          ? tr(
              t.lang,
              `${money(amount)} matches the advertised price of the ${label}. That figure is not an out-the-door total, and it does not include your taxes — this store has not verified a tax amount.`,
              `${money(amount)} coincide con el precio anunciado del ${label}. No es el precio final y no incluye sus impuestos — esta agencia no tiene un impuesto verificado.`,
            )
          : tr(
              t.lang,
              `The ${label} is advertised at ${money(v.price)}, which is not ${money(amount)}. I'll treat ${money(amount)} as a price you have in mind, not as the out-the-door total and not as a monthly payment. Taxes are not included in either number.`,
              `El ${label} está anunciado en ${money(v.price)}, no en ${money(amount)}. Tomo ${money(amount)} como un precio que usted tiene en mente, no como el precio final ni como un pago mensual. Ninguno incluye impuestos.`,
            ),
      );
      return;
    }
    const advertised = v?.price
      ? tr(
          t.lang,
          `The ${label} is advertised at ${money(v.price)}. `,
          `El ${label} está anunciado en ${money(v.price)}. `,
        )
      : '';
    this.ask(
      t,
      'figure_meaning',
      tr(
        t.lang,
        `${advertised}${money(amount)} could be the price you want to pay, a down payment, or an out-the-door total. Which one is it?`,
        `${advertised}${money(amount)} puede ser el precio que quiere pagar, un enganche o el precio final. ¿Cuál es?`,
      ),
      1,
      'choice',
    );
  }

  /** "Is this with my taxes?" — answered from the policy, not guessed. */
  private async handleTaxQuestion(t: Turn) {
    const policy = await this.getPolicy(t);
    let price: number | undefined;
    if (t.st.selectedVin) {
      const v = await this.inventory.getVehicleByVin(
        t.tenantId,
        t.st.selectedVin,
      );
      price = v?.price ?? undefined;
    }
    const fig = t.st.statedFigure?.amount;
    const includes =
      policy.mode === 'DEALER_CONFIGURED' && policy.taxRatePercent != null;
    const which = [
      fig != null ? money(fig) : null,
      price != null ? `the advertised price of ${money(price)}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    t.answers.push(
      includes
        ? tr(
            t.lang,
            `The verified tax rate on file is ${policy.taxRatePercent}%. ${which ? `${which} ` : ''}${t.st.otd?.estimated ? 'The out-the-door estimate includes that tax line.' : 'A price by itself is not the out-the-door total.'}`,
            `La tasa de impuesto verificada es ${policy.taxRatePercent}%. El precio anunciado no es el total final por sí solo.`,
          )
        : tr(
            t.lang,
            `No. ${which || 'The price I can show'} does not include your taxes. This store has not verified a tax rate, so I won't guess the tax in dollars.`,
            `No. ${which || 'El precio que puedo mostrar'} no incluye sus impuestos. Esta agencia no tiene una tasa verificada, así que no voy a adivinar el impuesto.`,
          ),
    );
    t.sources.add('dealer_pricing_policy');
  }

  /** Safety first; no diagnosis, no "it's probably fine". Then route to a person. */
  private async handleSafety(t: Turn) {
    t.urgent = true;
    this.metrics.increment('chat.safety_urgent');
    t.answers.push(
      tr(
        t.lang,
        "If you're in danger or the vehicle isn't safe to drive, please stop driving, get to a safe place, and call 911 or roadside assistance. I can't diagnose the problem from here.",
        'Si está en peligro o el vehículo no es seguro, deje de manejar, póngase en un lugar seguro y llame al 911 o a asistencia en el camino. No puedo diagnosticar el problema desde aquí.',
      ),
    );
    t.st.department = 'service';
    if (!t.handled.has('HUMAN_HANDOFF')) {
      t.handled.add('HUMAN_HANDOFF');
      await this.handleHandoff(t, 'complaint');
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
    const tr0 = st.trade!;
    const toward = !!t.u.entities.tradeTowardPurchase;
    if (!tr0.year && !tr0.make && !tr0.model && !tr0.requestId && !toward) {
      this.ask(
        t,
        'trade_vehicle',
        tr(
          t.lang,
          'What are you trading in? Year, make, model, and approximate miles are the most useful.',
          '¿Qué vehículo entrega? Año, marca, modelo y millas aproximadas son lo más útil.',
        ),
        1,
      );
      return;
    }
    t.toolCount += 1;
    if (tr0.requestId) {
      await this.prisma.tradeRequest.updateMany({
        where: { id: tr0.requestId, tenantId: t.tenantId },
        data: {
          year: tr0.year ?? undefined,
          make: tr0.make ?? undefined,
          model: tr0.model ?? undefined,
          mileage: tr0.mileage ?? undefined,
          payoffAmount: tr0.payoff ?? undefined,
          ...(toward ? {} : { desiredVehicleVin: st.selectedVin ?? undefined }),
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
      // Licensed providers first (none configured → queued for a human appraiser).
      await this.appraisals.requestEstimate(t.tenantId, row.id);
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
      toward
        ? tr(
            t.lang,
            `The ${label}${miles} stays your trade. I won't treat it as the vehicle you're buying, and I can't invent what it's worth.`,
            `El ${label}${miles} sigue siendo su vehículo a cuenta. No lo tomo como el que va a comprar, y no puedo inventar cuánto vale.`,
          )
        : tr(
            t.lang,
            `I've noted the ${label}${miles} as your trade-in.`,
            `Anoté su ${label}${miles} como vehículo a cuenta.`,
          ),
    );
    const value = await this.appraisals.customerValue(
      t.tenantId,
      tr0.requestId!,
    );
    if (value) {
      const amt =
        value.amount != null
          ? money(value.amount)
          : `${money(value.low!)}–${money(value.high!)}`;
      const until = value.expiresAt
        ? dateLabel(value.expiresAt.toISOString().slice(0, 10), t.lang)
        : null;
      t.narration.push(
        value.kind === 'FINAL_OFFER'
          ? tr(
              t.lang,
              `The dealership's trade offer for it is ${amt}${until ? `, valid through ${until}` : ''}. It's separate from any financing decision.`,
              `La oferta de la agencia por su vehículo es de ${amt}${until ? `, válida hasta el ${until}` : ''}. Es independiente de cualquier decisión de financiamiento.`,
            )
          : value.kind === 'DEALER_APPRAISAL'
            ? tr(
                t.lang,
                `The team appraised it at ${amt}. A manager confirms the final offer.`,
                `El equipo lo valuó en ${amt}. Un gerente confirma la oferta final.`,
              )
            : tr(
                t.lang,
                `A market estimate puts it around ${amt} — that's an estimate, not an offer.`,
                `Una estimación de mercado lo ubica en ${amt} — es una estimación, no una oferta.`,
              ),
      );
      t.facts.push(`Trade value (${value.kind}, dealership record): ${amt}`);
      t.evidence.push(
        this.evidenceSvc.verifiedConfig(
          t.tenantId,
          t.locationId,
          'trade_value',
          value.amount ?? value.low ?? 0,
          `trade_appraisal.${value.kind.toLowerCase()}`,
          new Date().toISOString(),
        ),
      );
    } else {
      t.narration.push(
        tr(
          t.lang,
          "I can't put a value on it here — the dealership appraises it, usually with a quick look in person.",
          'No puedo darle un valor aquí — la agencia lo valúa, normalmente con una revisión rápida en persona.',
        ),
      );
      t.evidence.push(
        this.evidenceSvc.unverified(
          t.tenantId,
          t.locationId,
          'trade_value',
          'Appraisal requires the dealership or an authorized appraisal provider.',
        ),
      );
      if (t.u.entities.tradeValuation) {
        this.ask(
          t,
          'trade_vehicle',
          !tr0.mileage
            ? tr(
                t.lang,
                "About how many miles are on it? That's the most useful detail still missing. I still won't invent a value.",
                '¿Cuántas millas tiene? Es el dato que más falta. Igual no voy a inventar un valor.',
              )
            : tr(
                t.lang,
                "How would you describe the condition — clean, average, or rough? I still can't put a dollar value on it from here.",
                '¿Cómo describiría la condición — limpio, promedio o áspero? Igual no puedo ponerle un valor desde aquí.',
              ),
          2,
        );
      }
    }
    t.cards.push({
      kind: 'trade',
      id: tr0.requestId!,
      summary: `${label}${miles}`,
      appraisalVerified: !!value,
      value: value
        ? {
            ...value,
            expiresAt: value.expiresAt ? value.expiresAt.toISOString() : null,
          }
        : null,
    });
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
    t.st.selectedLabel = vehicleLabel(v, true);
    t.st.selectedStock = v.stock ?? undefined;
    t.st.selectedStatus = v.status ?? undefined;
    this.rememberModels(t, [v]);
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
      const resumed = t.u.entities.resume;
      t.narration.push(
        resumed
          ? tr(
              t.lang,
              `Sure — back to the ${vehicleLabel(v, true)}.`,
              `Claro — volvamos al ${vehicleLabel(v)}.`,
            )
          : this.pick(
              t,
              t.lang === 'es'
                ? [`Buena elección — el ${vehicleLabel(v)}.`]
                : [
                    `Good pick — the ${vehicleLabel(v, true)}.`,
                    `The ${vehicleLabel(v, true)} — nice choice.`,
                    `Got it, the ${vehicleLabel(v, true)}.`,
                  ],
              'select',
            ),
      );
      if (resumed && t.st.payment.lastEstimate?.vin === v.vin) {
        const le = t.st.payment.lastEstimate;
        t.narration.push(
          tr(
            t.lang,
            `Last estimate we ran was about ${money(le.monthly)}/month with ${money(le.downPayment)} down over ${le.termMonths} months.`,
            `El último estimado fue de unos ${money(le.monthly)}/mes con ${money(le.downPayment)} de enganche a ${le.termMonths} meses.`,
          ),
        );
      }
      const next = this.salesNextStep(t);
      if (next) this.ask(t, 'none', next, 8);
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
    if (t.u.intents.some((i) => i.evidence === 'family needs')) {
      const max = t.st.criteria.maxPrice ?? t.u.entities.maxPrice;
      t.answers.push(
        tr(
          t.lang,
          `With the family in mind, here’s what fits${max ? ` under ${money(max)}` : ''}.`,
          `Pensando en la familia, esto es lo que encaja${max ? ` por menos de ${money(max)}` : ''}.`,
        ),
      );
    }
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
    // "Pathfinder or Rogue?" — if the first has nothing verified, try the other(s) named.
    let altNote: string | null = null;
    if (vehicles.length === 0 && t.u.entities.alternativeModels?.length) {
      for (const alt of t.u.entities.alternativeModels) {
        const found = await this.inventory.searchVehicles({
          tenantId: t.tenantId,
          locationId: t.locationId,
          model: alt,
        });
        if (found.length) {
          altNote = tr(
            t.lang,
            `I don't see a ${c.model} I can verify in stock, but here ${found.length === 1 ? `is the ${found[0].model}` : `are ${found.length} ${found[0].model}s`} I can.`,
            `No veo un ${c.model} en existencia, pero aquí ${found.length === 1 ? `está el ${found[0].model}` : `hay ${found.length} ${found[0].model}`}.`,
          );
          vehicles = found;
          t.st.criteria = { ...t.st.criteria, model: alt };
          break;
        }
      }
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
      const kind = await this.inventory.sourceKind(t.tenantId, t.locationId);
      const what =
        vehicleLabel(
          {
            make: c.model ? undefined : c.make,
            model: c.model,
            color: c.color,
          },
          true,
        ) || tr(t.lang, 'a match', 'una coincidencia');
      // Never imply that a miss in a demo/fixture dataset says anything about real stock.
      t.answers.push(
        kind === 'synthetic'
          ? tr(
              t.lang,
              `I don't see ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} in this demo's simulated inventory — that says nothing about the dealership's real stock.`,
              `No veo ${what} en el inventario simulado de esta demostración — eso no refleja el inventario real de la agencia.`,
            )
          : tr(
              t.lang,
              `I don't see ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} I can verify in this store's current inventory.`,
              `No veo ${what} que pueda verificar en el inventario actual de esta tienda.`,
            ),
      );
      // Offer genuinely similar vehicles that DO exist (same body style / make), never invented ones.
      const sim = await this.inventory.alternatives(t.tenantId, t.locationId, {
        make: c.model ? c.make : undefined,
        bodyType: c.bodyType ?? (c.model ? 'SUV' : undefined),
        price: c.maxPrice,
      });
      if (sim.length) {
        this.ask(
          t,
          'none',
          tr(
            t.lang,
            `Want me to show you similar ${c.bodyType ? `${c.bodyType}s` : 'vehicles'} that are in stock, or have the team check incoming vehicles?`,
            `¿Le muestro vehículos similares en existencia, o pido al equipo que revise los que vienen en camino?`,
          ),
          7,
        );
      } else {
        this.ask(
          t,
          'none',
          tr(
            t.lang,
            'Want me to have the team check incoming vehicles for you?',
            '¿Quiere que el equipo revise los vehículos que vienen en camino?',
          ),
          7,
        );
      }
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
    const sameAsShown =
      !relaxedNote &&
      shown.length === t.st.visibleVins.length &&
      shown.every((v) => t.st.visibleVins.includes(v.vin));
    t.st.visibleVins = shown.map((v) => v.vin);
    this.rememberModels(t, shown);
    t.vehicles = await this.withPaymentEstimates(t, shown);
    t.type = 'vehicle_carousel';
    await this.attachVehicleEvidence(t, shown);
    const stale = t.evidence.some(
      (e) =>
        e.field === 'inventory_availability' && e.freshnessState !== 'fresh',
    );
    if (altNote) t.narration.push(altNote);
    else if (relaxedNote) t.narration.push(relaxedNote);
    else if (sameAsShown && shown.length > 1) {
      t.narration.push(
        tr(
          t.lang,
          `Those ${shown.length} are everything I can verify in stock for that right now.`,
          `Esos ${shown.length} son todos los que puedo verificar en existencia ahora.`,
        ),
      );
    } else if (monthlyMiss) {
      t.narration.push(
        tr(
          t.lang,
          `None of these come in under ${money(t.st.payment.maxMonthly!)}/month with ${t.st.payment.downPayment ? `${money(t.st.payment.downPayment)} down` : 'nothing down'} at an example rate — here are the closest.`,
          `Ninguno queda por debajo de ${money(t.st.payment.maxMonthly!)}/mes con ${t.st.payment.downPayment ? `${money(t.st.payment.downPayment)} de enganche` : 'cero enganche'} a una tasa de ejemplo — estos son los más cercanos.`,
        ),
      );
    } else {
      // Name the model the way the inventory does ("QX60", "CR-V"), not the parser's casing.
      const shownModel =
        c.model &&
        shown.every((v) =>
          (v.model ?? '').toLowerCase().startsWith(c.model!.toLowerCase()),
        )
          ? (shown.find(
              (v) => (v.model ?? '').toLowerCase() === c.model!.toLowerCase(),
            )?.model ?? c.model)
          : c.model;
      const what =
        vehicleLabel(
          {
            model: shownModel,
            make: c.model ? undefined : c.make,
            color: c.color,
          },
          true,
        ) || tr(t.lang, 'vehicle', 'vehículo');
      const plural = /s$/.test(what) ? what : `${what}s`;
      const under = c.maxPrice
        ? tr(
            t.lang,
            ` under ${money(c.maxPrice)}`,
            ` por menos de ${money(c.maxPrice)}`,
          )
        : '';
      // "What's your cheapest Jeep?" — answer the superlative directly from the results.
      if (
        shown.length > 1 &&
        /\b(cheapest|least expensive|lowest[- ]priced|most affordable|most expensive|priciest)\b/i.test(
          t.message,
        )
      ) {
        const priced = shown.filter((x) => x.price);
        const pick = /most expensive|priciest/i.test(t.message)
          ? [...priced].sort((a, b) => b.price! - a.price!)[0]
          : [...priced].sort((a, b) => a.price! - b.price!)[0];
        if (pick)
          t.answers.push(
            tr(
              t.lang,
              `The ${/most expensive|priciest/i.test(t.message) ? 'highest' : 'lowest'}-priced one here is the ${vehicleLabel(pick, true)} at ${money(pick.price!)}${pick.simulated ? ' (demo figure)' : ''}.`,
              `El de ${/most expensive|priciest/i.test(t.message) ? 'mayor' : 'menor'} precio aquí es el ${vehicleLabel(pick, true)} en ${money(pick.price!)}${pick.simulated ? ' (cifra de demostración)' : ''}.`,
            ),
          );
      }
      // "In stock" is only said about vehicles that are; in-transit units are named as such.
      const transit = shown.filter((x) => x.status === 'IN_TRANSIT').length;
      if (shown.length === 1 && transit === 1) {
        t.narration.push(
          tr(
            t.lang,
            `I found one ${what}${under} — it’s marked in transit, so it isn’t on the lot yet.`,
            `Encontré un ${esColorLabel(what)}${under} — aparece en tránsito, así que aún no está en el lote.`,
          ),
        );
      } else if (transit > 0) {
        t.narration.push(
          tr(
            t.lang,
            transit === shown.length
              ? `I found ${shown.length} ${plural}${under} — all marked in transit, so none are on the lot yet. Tell me which one catches your eye.`
              : `I found ${shown.length} ${plural}${under} — ${transit} marked in transit, the rest in stock. Tell me which one catches your eye.`,
            `Encontré ${shown.length} opciones${under} — ${transit === shown.length ? 'todas' : transit} en tránsito. Dígame cuál le llama la atención.`,
          ),
        );
      } else
        t.narration.push(
          shown.length === 1
            ? this.pick(
                t,
                t.lang === 'es'
                  ? [
                      `Encontré un ${esColorLabel(what)} que puedo verificar en existencia${under}.`,
                    ]
                  : [
                      `Here's the one ${what} I can verify in stock right now${under}.`,
                      `I found one ${what}${under} — take a look.`,
                    ],
                'found1',
              )
            : this.pick(
                t,
                t.lang === 'es'
                  ? [
                      `Encontré ${shown.length} opciones${under}. Dígame cuál le llama la atención.`,
                    ]
                  : [
                      `I found ${shown.length} ${plural}${under} worth a look. Tell me which one catches your eye.`,
                      `Here are ${shown.length} ${plural}${under} in stock right now — take a look.`,
                    ],
                'foundN',
              ),
        );
    }
    this.noteSimulated(t, shown);
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
      t.st.selectedLabel = vehicleLabel(shown[0], true);
      t.st.selectedStock = shown[0].stock ?? undefined;
      t.st.selectedStatus = shown[0].status ?? undefined;
      const next = this.salesNextStep(t);
      if (next) this.ask(t, 'none', next, 9);
    } else if (shown.length > 3 && !c.maxPrice && !t.st.payment.maxMonthly) {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Is there a budget or a must-have feature I should narrow these down by?',
          '¿Hay un presupuesto o una característica indispensable para filtrarlos?',
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
      if (yes.length === 1) {
        t.st.selectedVin = yes[0].vin;
        t.st.selectedLabel = vehicleLabel(yes[0], true);
        t.st.selectedStock = yes[0].stock ?? undefined;
        t.st.selectedStatus = yes[0].status ?? undefined;
      }
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
    // Comparing a few vehicles and no single one picked → estimate each, same assumptions.
    if (
      !t.st.selectedVin &&
      t.st.compareVins.length >= 2 &&
      !t.u.entities.vehicle?.model &&
      !t.u.entities.vin
    ) {
      return this.handleMultiPayment(t, t.st.compareVins.slice(0, 3));
    }
    let v: InventoryVehicle | undefined;
    if (t.st.selectedVin)
      v =
        (await this.inventory.getVehicleByVin(t.tenantId, t.st.selectedVin)) ??
        undefined;
    if (!v) {
      const ref = await this.resolveVehicleReference(t);
      if (
        !ref.v &&
        !t.u.entities.vehicle?.model &&
        t.st.visibleVins.length >= 2 &&
        t.st.visibleVins.length <= 3
      ) {
        // A few on screen: estimate each with the same assumptions instead of quizzing.
        return this.handleMultiPayment(t, t.st.visibleVins);
      }
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
    t.st.selectedLabel = vehicleLabel(v, true);
    t.st.selectedStock = v.stock ?? undefined;
    t.st.selectedStatus = v.status ?? undefined;
    if (
      (t.u.entities.leaseOrPurchase ?? t.st.payment.leaseOrPurchase) === 'lease'
    ) {
      t.answers.push(
        tr(
          t.lang,
          `I don't have verified lease terms — money factor, residual, or mileage — for the ${vehicleLabel(v)}, so I won't show a finance payment as if it were a lease. I can estimate a finance payment if you want that, or save the lease question for the finance team.`,
          `No tengo términos de arrendamiento verificados para el ${vehicleLabel(v)}, así que no voy a mostrar un pago de financiamiento como si fuera un arrendamiento. Puedo estimar un pago de financiamiento si lo desea, o dejar la pregunta de arrendamiento para el equipo.`,
        ),
      );
      return;
    }
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
    const prevEstimate = t.st.payment.lastEstimate;
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
    const prev = prevEstimate;
    const adjusting = !!prev && prev.vin === v.vin;
    const downText =
      down > 0
        ? tr(t.lang, `${money(down)} down`, `${money(down)} de enganche`)
        : tr(t.lang, 'nothing down', 'cero enganche');
    const lead = adjusting
      ? this.pick(
          t,
          t.lang === 'es'
            ? [
                `Con ${downText} a ${est.breakdown.termMonths} meses, baja a unos ${money(est.monthlyPayment)} al mes.`,
              ]
            : [
                `With ${downText} over ${est.breakdown.termMonths} months, that comes to about ${money(est.monthlyPayment)} a month.`,
                `At ${downText} and ${est.breakdown.termMonths} months, you'd be around ${money(est.monthlyPayment)} a month.`,
              ],
          'pay-adj',
        )
      : tr(
          t.lang,
          `For the ${vehicleLabel(v)} at ${money(v.price)}, you're looking at roughly ${money(est.monthlyPayment)} a month with ${downText} over ${est.breakdown.termMonths} months.`,
          `Para el ${vehicleLabel(v)} de ${money(v.price)}, serían unos ${money(est.monthlyPayment)} al mes con ${downText} a ${est.breakdown.termMonths} meses.`,
        );
    if (adjusting && prev && prev.monthly !== est.monthlyPayment) {
      const diff = Math.round(prev.monthly - est.monthlyPayment);
      t.narration.push(
        `${lead} ${
          diff > 0
            ? tr(
                t.lang,
                `That's about ${money(diff)} less than before.`,
                `Unos ${money(diff)} menos que antes.`,
              )
            : tr(
                t.lang,
                `That's about ${money(-diff)} more than before.`,
                `Unos ${money(-diff)} más que antes.`,
              )
        }`,
      );
    } else t.narration.push(lead);
    // ONE concise disclosure in the reply; the card carries the detailed terms.
    t.narration.push(
      est.aprSource === 'CUSTOMER'
        ? tr(
            t.lang,
            `That's at the ${est.breakdown.apr}% rate you mentioned${est.includesTaxAndFees ? '' : ', before taxes and fees'} — an estimate, not a financing offer.`,
            `Con la tasa de ${est.breakdown.apr}% que mencionó${est.includesTaxAndFees ? '' : ', sin impuestos ni cargos'} — es un estimado, no una oferta de financiamiento.`,
          )
        : tr(
            t.lang,
            `That uses an example ${est.breakdown.apr}% rate${est.includesTaxAndFees ? '' : ' and leaves out taxes and fees'} — an estimate, not a financing offer.`,
            `Usa una tasa de ejemplo de ${est.breakdown.apr}%${est.includesTaxAndFees ? '' : ' y no incluye impuestos ni cargos'} — es un estimado, no una oferta de financiamiento.`,
          ),
    );
    if (/\b(with (?:my|the|a) trade|trade(?:-| )in value)\b/i.test(t.message))
      t.narration.push(
        tr(
          t.lang,
          "I haven't included a trade value — that needs an appraisal from the team before it can count toward the numbers.",
          'No incluí el valor de su vehículo a cuenta — necesita una valuación del equipo primero.',
        ),
      );
    if (t.st.payment.maxMonthly) {
      const target = t.st.payment.maxMonthly;
      if (est.monthlyPayment > target) {
        // Deterministic: the down payment that would reach the target at the same term/rate.
        const need = this.payments.estimateWithPolicy({
          price: v.price,
          policy,
          downPayment: 0,
          termMonths: est.breakdown.termMonths,
          customerApr: t.st.payment.customerApr,
        });
        const perDollar = need.monthlyPayment / Math.max(1, v.price);
        const downNeeded =
          Math.ceil((v.price - target / Math.max(perDollar, 1e-9)) / 500) * 500;
        t.narration.push(
          downNeeded > down && downNeeded < v.price
            ? tr(
                t.lang,
                `To land under ${money(target)} a month at that term, you'd need roughly ${money(downNeeded)} down — or a longer term.`,
                `Para quedar por debajo de ${money(target)} al mes a ese plazo, necesitaría unos ${money(downNeeded)} de enganche — o un plazo más largo.`,
              )
            : tr(
                t.lang,
                `That's above your ${money(target)} a month target.`,
                `Eso está por encima de su meta de ${money(target)} al mes.`,
              ),
        );
      } else {
        t.narration.push(
          tr(
            t.lang,
            `That keeps you under your ${money(target)} target.`,
            `Así queda por debajo de su meta de ${money(target)}.`,
          ),
        );
      }
    }
    t.cards.push({
      kind: 'payment',
      vin: v.vin,
      vehicleLabel: vehicleLabel(v, true),
      product: 'finance',
      status: 'estimate',
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
        leaseOrPurchase:
          t.st.payment.leaseOrPurchase === 'cash'
            ? null
            : (t.st.payment.leaseOrPurchase ?? null),
        customerApr: t.st.payment.customerApr ?? null,
        tradeInterest: !!t.st.trade?.requestId,
      });
      t.st.finance = { ...t.st.finance, requestId: fr.id };
    }
    this.ask(
      t,
      'none',
      adjusting
        ? tr(
            t.lang,
            'Want to try another down payment or term, or see the out-the-door price?',
            '¿Probamos otro enganche o plazo, o le muestro el precio final?',
          )
        : tr(
            t.lang,
            'Want to adjust the down payment or term?',
            '¿Quiere ajustar el enganche o el plazo?',
          ),
      9,
    );
  }

  /** Same assumptions across the vehicles being compared — consistent, deterministic. */
  private async handleMultiPayment(t: Turn, vins: string[]) {
    const vs = (await this.inventory.getVehiclesByVin(t.tenantId, vins)).filter(
      (v) => v.price && (v.status === 'AVAILABLE' || v.status === 'IN_TRANSIT'),
    );
    if (!vs.length) return;
    t.toolCount += 1;
    const withEst = await this.withPaymentEstimates(t, vs);
    t.vehicles = withEst;
    t.type = vs.length > 1 ? 'vehicle_compare' : 'vehicle_carousel';
    await this.attachVehicleEvidence(t, vs);
    t.sources.add('payment_calculator');
    const pa = (
      withEst[0] as InventoryVehicle & {
        paymentAssumptions?: {
          apr: number;
          termMonths: number;
          downPayment: number;
          includesTaxAndFees: boolean;
        };
      }
    ).paymentAssumptions;
    const parts = withEst.map(
      (v) =>
        `${money(v.estimatedPayment ?? 0)}${tr(t.lang, '/mo for the ', '/mes el ')}${[v.year, v.model, v.trim].filter(Boolean).join(' ')}`,
    );
    const down = pa?.downPayment ?? 0;
    t.narration.push(
      tr(
        t.lang,
        `With ${down ? `${money(down)} down` : 'nothing down'} over ${pa?.termMonths ?? 72} months: ${parts.join('; ')}.`,
        `Con ${down ? `${money(down)} de enganche` : 'cero enganche'} a ${pa?.termMonths ?? 72} meses: ${parts.join('; ')}.`,
      ),
    );
    t.narration.push(
      tr(
        t.lang,
        `Those use an example ${pa?.apr ?? ''}% rate${pa?.includesTaxAndFees ? '' : ' and leave out taxes and fees'} — estimates, not financing offers.`,
        `Usan una tasa de ejemplo de ${pa?.apr ?? ''}%${pa?.includesTaxAndFees ? '' : ' sin impuestos ni cargos'} — son estimados, no ofertas.`,
      ),
    );
    this.signal(t, 'payment_estimate');
    t.facts.push(
      `Payment estimates (computed, not offers): ${withEst.map((v) => `${v.vin} ${money(v.estimatedPayment ?? 0)}/mo`).join('; ')}`,
    );
    this.ask(
      t,
      'none',
      tr(
        t.lang,
        'Want to focus on one of these?',
        '¿Quiere enfocarse en uno de estos?',
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
      leaseOrPurchase:
        t.st.payment.leaseOrPurchase === 'cash'
          ? null
          : (t.st.payment.leaseOrPurchase ?? null),
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
    if (t.u.entities.approvalQuestion && t.st.finance?.creditLinkOffered) {
      t.answers.push(
        tr(
          t.lang,
          "No — filling out the application isn't an approval. The dealership's finance team and its lenders review it and follow up with any actual offer and terms.",
          'No — llenar la solicitud no es una aprobación. El equipo de finanzas y sus prestamistas la revisan y le comunican cualquier oferta real y sus términos.',
        ),
      );
    } else if (t.u.entities.creditConcern) {
      t.answers.push(
        tr(
          t.lang,
          'That’s more common than you’d think, and it doesn’t automatically rule anything out — lenders look at the whole picture, including income and down payment. I can’t promise an approval or a rate, but the finance team works with a range of credit situations.',
          'Es más común de lo que parece y no descarta nada automáticamente — los prestamistas ven el panorama completo, incluido ingreso y enganche. No puedo prometer aprobación ni tasa, pero el equipo de finanzas trabaja con distintas situaciones de crédito.',
        ),
      );
    } else if (
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
    if (
      /payment method/.test(
        t.u.intents.find((i) => i.intent === 'FINANCE_REQUEST')?.evidence ?? '',
      )
    )
      t.answers.push(
        tr(
          t.lang,
          t.st.payment.leaseOrPurchase === 'lease'
            ? 'Leasing — got it.'
            : 'Financing — got it. You can still get the out-the-door price without applying for credit.',
          t.st.payment.leaseOrPurchase === 'lease'
            ? 'Arrendamiento — entendido.'
            : 'Financiamiento — entendido. Puede obtener el precio final sin solicitar crédito.',
        ),
      );
    if (!t.handled.has('CREDIT_APPLICATION')) {
      const res = await this.credit.resolve(t.tenantId, t.locationId);
      if (res.available && !t.st.finance?.creditLinkOffered) {
        if (
          /\bcan i finance\b|\bfinance (?:it|this|that|one|the)\b/i.test(
            t.message,
          )
        )
          t.answers.push(
            tr(
              t.lang,
              t.st.selectedLabel
                ? `Yes — you can finance the ${t.st.selectedLabel} through the dealership.`
                : 'Yes — the dealership offers financing.',
              'Sí — puede financiarlo con la agencia.',
            ),
          );
        this.ask(
          t,
          'confirm_credit_link',
          tr(
            t.lang,
            "Want me to pull up the dealership's secure credit application? It opens in a new tab, so your financial details stay out of this chat.",
            '¿Le muestro la solicitud de crédito segura de la agencia? Se abre en otra pestaña, así sus datos financieros no pasan por este chat.',
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
          "I don't have the dealership's online credit application set up in this chat yet, and I don't want to send you anywhere unofficial.",
          'Aún no tengo la solicitud de crédito en línea de la agencia en este chat, y no quiero enviarle a un sitio no oficial.',
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
    const again = !!t.st.finance?.creditLinkOffered;
    await this.credit.markOffered(t.tenantId, fr.id, t.locationId);
    t.st.finance.creditLinkOffered = true;
    t.st.finance.creditPreview = !!res.preview;
    this.signal(t, 'credit_link_offered');
    const url = this.credit.trackedPath(fr.id, t.tenantId);
    const provider = res.config.providerName;
    t.cards.push({
      kind: 'credit_application',
      label: tr(
        t.lang,
        'Secure Credit Application',
        'Solicitud de crédito segura',
      ),
      url,
      providerName: provider,
      cta: tr(t.lang, 'Apply for Financing', 'Solicitar financiamiento'),
      note: tr(
        t.lang,
        'Opens securely in a new tab.',
        'Se abre de forma segura en otra pestaña.',
      ),
      preview: res.preview,
    });
    t.sources.add('credit_application_config');
    const via = provider
      ? tr(
          t.lang,
          ` It opens through ${provider}`,
          ` Se abre a través de ${provider}`,
        )
      : tr(t.lang, ' It opens in a new tab', ' Se abre en otra pestaña');
    t.narration.push(
      again
        ? tr(
            t.lang,
            `Yes — it's completely online. Tap Apply for Financing and it opens in a new tab.`,
            'Sí — es completamente en línea. Toque Solicitar financiamiento y se abre en otra pestaña.',
          )
        : tr(
            t.lang,
            `Of course. Here's the dealership's secure credit application.${via}, so your sensitive financial information stays out of this chat.`,
            `Claro. Aquí está la solicitud de crédito segura de la agencia.${via}, así su información financiera no pasa por este chat.`,
          ),
    );
    if (res.preview)
      t.narration.push(
        tr(
          t.lang,
          `(Demo preview: the live ${provider ?? 'provider'} link stays off until ${provider ?? 'the provider'} and the dealership confirm it for this store.)`,
          `(Vista previa: el enlace real de ${provider ?? 'el proveedor'} sigue apagado hasta que ${provider ?? 'el proveedor'} y la agencia lo confirmen.)`,
        ),
      );
    if (!again) {
      t.narration.push(
        tr(
          t.lang,
          'Once you’ve completed it, the finance team can review the next steps — applying isn’t an approval.',
          'Cuando la complete, el equipo de finanzas revisará los siguientes pasos — aplicar no es una aprobación.',
        ),
      );
      // Only offer a drive on a car that's actually on the lot.
      if (
        t.st.selectedVin &&
        !t.st.appointment &&
        t.st.selectedStatus === 'AVAILABLE'
      )
        this.ask(
          t,
          'none',
          tr(
            t.lang,
            'I can also help you set up a test drive in the meantime, if you’d like.',
            'Mientras tanto también le puedo ayudar a agendar una prueba de manejo.',
          ),
          9,
        );
    }
  }

  // ───────────────────────────────────────── out-the-door

  private async handleOtd(t: Turn) {
    const st = t.st;
    const e = t.u.entities;
    if (e.leaseOrPurchase === 'cash')
      st.otd = { ...st.otd, paymentMethod: 'CASH' };
    else if (e.leaseOrPurchase === 'lease')
      st.otd = { ...st.otd, paymentMethod: 'LEASE' };
    if (e.zip) st.otd = { ...st.otd, zip: e.zip };
    if (e.registrationPlace)
      st.otd = { ...st.otd, registrationPlace: e.registrationPlace };
    let v: InventoryVehicle | null = null;
    if (st.selectedVin)
      v = await this.inventory.getVehicleByVin(t.tenantId, st.selectedVin);
    if (!v) {
      const ref = await this.resolveVehicleReference(t);
      v = ref.v ?? null;
    }
    if (!v) {
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Happy to get you an out-the-door number — which vehicle is it for?',
          'Con gusto le consigo el precio final — ¿para qué vehículo es?',
        ),
        3,
      );
      return;
    }
    if (!(v.status === 'AVAILABLE' || v.status === 'IN_TRANSIT')) {
      t.answers.push(
        tr(
          t.lang,
          `The ${vehicleLabel(v)} isn't showing as available anymore, so I can't quote it.`,
          `El ${vehicleLabel(v)} ya no aparece disponible, así que no puedo cotizarlo.`,
        ),
      );
      return;
    }
    st.selectedVin = v.vin;
    st.selectedLabel = vehicleLabel(v, true);
    st.selectedStock = v.stock ?? undefined;
    st.selectedStatus = v.status ?? undefined;
    t.toolCount += 1;
    await this.attachVehicleEvidence(t, [v]);
    const policy = await this.getPolicy(t);
    const est = estimateOutTheDoor({ price: v.price, policy });
    // A payment estimate is not a decision to finance; only an explicit choice counts.
    const method =
      st.otd?.paymentMethod ??
      (st.payment.leaseOrPurchase === 'lease'
        ? 'LEASE'
        : st.finance?.creditLinkOffered ||
            st.signals.includes('finance_interest')
          ? 'FINANCE'
          : 'UNDECIDED');
    const label = vehicleLabel(v, true);
    if (!(await this.cap(t, 'leadCapture')).allowed) {
      // Without lead capture we can still show a verified estimate, but can't route a request.
      if (!est.computable) {
        t.answers.push(
          tr(
            t.lang,
            "I can't put together an exact out-the-door total from here — the sales team can give you one.",
            'No puedo armar un precio final exacto desde aquí — el equipo de ventas se lo puede dar.',
          ),
        );
        return;
      }
    }
    const quote = await this.quotes.upsertForConversation({
      tenantId: t.tenantId,
      locationId: t.locationId,
      conversationId: t.s.conversationId,
      vehicleVin: v.vin,
      vehicleLabel: label,
      paymentMethod: method,
      registrationZip: st.otd?.zip ?? null,
      estimateShown: est.computable
        ? {
            lines: est.lines,
            total: est.total,
            assumptions: est.assumptions,
            policyVersion: est.policyVersion,
          }
        : null,
      missingInputs: est.computable ? [] : est.missingInputs,
      customer: {
        name: this.customerName(t),
        phone: st.contact.phone,
        email: st.contact.email,
      },
    });
    const first = !st.otd?.requestId;
    st.otd = {
      ...st.otd,
      requestId: quote.id,
      vin: v.vin,
      paymentMethod: method,
      estimated: est.computable,
    };
    this.signal(t, 'quote_requested');
    void this.analytics.trackEvent(
      t.tenantId,
      t.locationId,
      'otd_quote_requested',
      { computable: est.computable, method },
      t.s.externalKey,
    );
    t.sources.add('dealer_pricing_policy');
    t.cards.push({
      kind: 'otd_quote',
      id: quote.id,
      vin: v.vin,
      vehicleLabel: label,
      status: est.computable ? 'estimate' : 'requested',
      paymentMethod: method,
      lines: est.computable ? est.lines : [],
      total: est.computable ? est.total : null,
      assumptions: est.computable ? est.assumptions : [],
      missingInputs: est.computable ? [] : est.missingInputs,
      preliminary: true,
    });
    if (method === 'CASH' && t.u.entities.leaseOrPurchase === 'cash')
      t.answers.push(
        tr(
          t.lang,
          'Paying cash works — no credit application needed for a quote.',
          'Pagar de contado está perfecto — no necesita solicitud de crédito para una cotización.',
        ),
      );
    if (est.computable) {
      t.narration.push(
        tr(
          t.lang,
          `Here's a preliminary out-the-door estimate for the ${label}: about ${money(est.total)}, itemized below using the dealership's verified tax and fees for ${est.jurisdiction} registration.`,
          `Este es un estimado preliminar del precio final del ${label}: unos ${money(est.total)}, desglosado con los impuestos y cargos verificados de la agencia para registro en ${est.jurisdiction}.`,
        ),
      );
      t.narration.push(
        tr(
          t.lang,
          "It's not a written offer — the team will confirm it in writing.",
          'No es una oferta por escrito — el equipo la confirmará por escrito.',
        ),
      );
      t.facts.push(
        `OTD estimate (verified inputs only): ${money(est.total)} for ${v.vin}`,
      );
    } else {
      // Say what IS known (the advertised price) and exactly what is NOT, then the next step.
      const missing = est.missingInputs;
      const NAMES: Record<string, [string, string]> = {
        verified_price: [
          'an advertised price on file',
          'un precio anunciado registrado',
        ],
        tax_rate: [
          'the sales tax for where it’s registered',
          'el impuesto según dónde se registre',
        ],
        doc_fee: [
          'the dealership’s documentation fee',
          'el cargo de documentación de la agencia',
        ],
        title_registration: [
          'title and registration fees',
          'los cargos de título y registro',
        ],
        jurisdiction: ['the registration location', 'el lugar de registro'],
        out_of_state_registration: [
          'out-of-state registration rules',
          'las reglas de registro fuera del estado',
        ],
      };
      const list = (lang: 'en' | 'es') => {
        const items = missing
          .filter((m) => m !== 'jurisdiction' || !missing.includes('tax_rate'))
          .map((m) => (NAMES[m] ?? [m, m])[lang === 'en' ? 0 : 1]);
        const and = lang === 'en' ? ' and ' : ' y ';
        return items.length > 1
          ? `${items.slice(0, -1).join(', ')}${and}${items[items.length - 1]}`
          : (items[0] ?? '');
      };
      const priceFact =
        v.price && v.price > 0
          ? tr(
              t.lang,
              `The advertised price on the ${label} is ${money(v.price)}${v.simulated ? ' (demo figure)' : ''}.`,
              `El precio anunciado del ${label} es ${money(v.price)}${v.simulated ? ' (cifra de demostración)' : ''}.`,
            )
          : '';
      if (first) {
        if (priceFact) t.answers.push(priceFact);
        t.narration.push(
          tr(
            t.lang,
            `For the full out-the-door number I still need ${list('en')} — I won’t guess those, so I’ve saved a written-quote request for the sales team to fill in.`,
            `Para el precio final completo todavía falta ${list('es')} — no voy a adivinarlos, así que guardé una solicitud de cotización por escrito para el equipo de ventas.`,
          ),
        );
      } else {
        t.narration.push(
          e.zip
            ? tr(
                t.lang,
                `Got it — I added registration ZIP ${e.zip} to your quote request.`,
                `Listo — agregué el código postal ${e.zip} a su solicitud.`,
              )
            : tr(
                t.lang,
                `Your out-the-door request on the ${label} is already saved with the sales team${v.price ? ` (advertised price ${money(v.price)})` : ''}. It still needs ${list('en')} before there’s an exact total.`,
                `Su solicitud de precio final del ${label} ya está guardada${v.price ? ` (precio anunciado ${money(v.price)})` : ''}. Aún falta ${list('es')} para tener el total exacto.`,
              ),
        );
      }
      if (!st.otd?.zip)
        this.ask(
          t,
          'otd_zip',
          st.otd?.registrationPlace
            ? tr(
                t.lang,
                `I've noted ${st.otd.registrationPlace}. Sales tax still depends on the registration ZIP, and that rate isn't verified here, so I won't guess it. What's the ZIP?`,
                `Anoté ${st.otd.registrationPlace}. El impuesto depende del código postal y esa tasa no está verificada, así que no la adivino. ¿Cuál es el código postal?`,
              )
            : tr(
                t.lang,
                "What ZIP code would you register it in? That's what sets the taxes and fees.",
                '¿En qué código postal lo registraría? Eso define impuestos y cargos.',
              ),
          4,
        );
    }
    if (
      method !== 'CASH' &&
      !st.finance?.creditLinkOffered &&
      !t.handled.has('CREDIT_APPLICATION') &&
      first
    ) {
      const res = await this.credit.resolve(t.tenantId, t.locationId);
      if (res.available)
        this.ask(
          t,
          'confirm_credit_link',
          tr(
            t.lang,
            'If you plan to finance, I can also pull up the secure credit application — totally optional.',
            'Si piensa financiar, también le puedo mostrar la solicitud de crédito segura — es opcional.',
          ),
          6,
        );
    }
  }

  // ───────────────────────────────────────── conversation

  /**
   * Social turns ("hi", "how are you", "pretty good, you?", "thanks", "just looking",
   * "are you a bot?"). Pure social messages get a warm, varied, honest reply with no sales
   * menu; social words attached to a real request only set a brief opener.
   */
  private async handleSocial(t: Turn) {
    const st = t.st;
    const acts = t.u.entities.social ?? [];
    const strength = t.u.entities.socialStrength ?? 0;
    const L = t.lang;
    const recent = [
      ...st.recentOpeners,
      ...(st.lastReplySig ? [st.lastReplySig] : []),
    ];
    const line = (k: Parameters<typeof socialLine>[0]) =>
      socialLine(k, L, recent, this.seed(t, k));
    const taskIntents = t.u.intents.filter(
      (i) =>
        !['SMALL_TALK', 'GREETING', 'AFFIRM', 'DECLINE', 'UNKNOWN'].includes(
          i.intent,
        ),
    );
    const greeted = !!st.social?.greeted;
    st.social = { ...st.social, greeted: true };
    if (
      taskIntents.length &&
      !acts.includes('identity') &&
      !acts.includes('name_question') &&
      !acts.includes('origin_question')
    ) {
      // Light touch: a short opener, then the real answer.
      if (acts.includes('greeting') || acts.includes('how_are_you'))
        t.socialPrefix = acts.includes('how_are_you')
          ? tr(L, 'Doing well, thanks!', '¡Muy bien, gracias!')
          : greeted
            ? undefined
            : this.pick(
                t,
                L === 'es' ? ['¡Hola!'] : ['Hi there!', 'Hey!', 'Hi!'],
                'hi',
              );
      else if (acts.includes('thanks'))
        t.socialPrefix = tr(L, "You're welcome!", '¡Con gusto!');
      return;
    }
    if (acts.includes('name_question')) return this.handleWhoWeAre(t, 'name');
    if (acts.includes('origin_question'))
      return this.handleWhoWeAre(t, 'origin');
    if (acts.includes('identity')) return void t.answers.push(line('identity'));
    if (acts.includes('farewell')) return void t.answers.push(line('farewell'));
    if (acts.includes('how_are_you')) {
      st.social.askedHowAreYou = true;
      const hi =
        acts.includes('greeting') && !greeted ? tr(L, 'Hey! ', '¡Hola! ') : '';
      // Already asked about their day → don't ask again; move the conversation forward.
      return void t.answers.push(
        `${hi}${line(greeted ? 'wellbeingAskBack' : 'howAreYou')}`,
      );
    }
    if (acts.includes('reply_wellbeing_ask_back'))
      return void t.answers.push(line('wellbeingAskBack'));
    if (acts.includes('reply_wellbeing')) {
      const low =
        /\b(tired|busy|meh|so so|not (?:good|great)|rough|long day|cansad)/i.test(
          t.message,
        );
      return void t.answers.push(
        line(low ? 'wellbeingLow' : 'wellbeingPositive'),
      );
    }
    if (acts.includes('browsing')) {
      st.social.browsing = true;
      return void t.answers.push(line('browsing'));
    }
    if (acts.includes('thanks')) {
      t.answers.push(line('thanks'));
      // Only when they were in the middle of something does a gentle pointer help.
      if (
        strength >= 0.6 &&
        st.selectedVin &&
        !st.appointment &&
        !st.payment.lastEstimate
      )
        this.ask(t, 'none', this.salesNextStep(t) ?? '', 9);
      return;
    }
    if (acts.includes('greeting')) {
      if (st.department === 'service' || st.department === 'parts')
        return this.handleGreeting(t);
      return void t.answers.push(
        greeted
          ? `${line('greetingAgain')} ${tr(L, 'What can I help with?', '¿En qué le ayudo?')}`
          : await this.greetingLine(t, 'greetingFirst'),
      );
    }
    if (acts.includes('compliment'))
      return void t.answers.push(line('compliment'));
    if (acts.includes('laughter')) return void t.answers.push(line('laughter'));
    if (acts.includes('apology')) return void t.answers.push(line('apology'));
  }

  /** "I want to buy a car" — discovery, not a menu. */
  private handleShoppingStart(t: Turn) {
    const st = t.st;
    st.department = 'sales';
    st.social = { ...st.social, browsing: false };
    if (st.criteria.model && st.visibleVins.length) {
      t.answers.push(
        tr(
          t.lang,
          `Still thinking about the ${st.criteria.model}, or open to other ideas?`,
          `¿Sigue pensando en el ${st.criteria.model}, o abierto a otras ideas?`,
        ),
      );
      return;
    }
    t.answers.push(
      socialLine(
        'shoppingStart',
        t.lang,
        st.recentOpeners,
        this.seed(t, 'shop'),
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
    // Keep date/time pieces given earlier in this booking ("Friday" … "morning").
    const prior =
      st.draftAppointment &&
      (st.draftAppointment.type === type ||
        (type !== 'SERVICE' && st.draftAppointment.type !== 'SERVICE'))
        ? st.draftAppointment.when
        : undefined;
    const now = t.u.entities.when;
    if (prior && (!now || !now.date)) {
      t.u.entities.when = {
        ...prior,
        ...(now ?? {}),
        date: prior.date,
        phrase: [prior.phrase, now?.phrase].filter(Boolean).join(' '),
        inferred: prior.inferred || !!now?.inferred,
      };
    }
    // A test drive needs the car on the lot: re-read status, never trust a stale selection.
    if (type === 'TEST_DRIVE' && st.selectedVin) {
      const v = await this.inventory.getVehicleByVin(
        t.tenantId,
        st.selectedVin,
      );
      st.selectedStatus = v?.status ?? st.selectedStatus;
      if (!v || (v.status !== 'AVAILABLE' && v.status !== 'IN_TRANSIT')) {
        t.answers.push(
          tr(
            t.lang,
            `The ${st.selectedLabel ?? 'vehicle you picked'} isn’t showing as available anymore, so I can’t set up a test drive on it. Want me to find similar ones that are?`,
            `El ${st.selectedLabel ?? 'vehículo que eligió'} ya no aparece disponible, así que no puedo pedir una prueba de manejo. ¿Le busco similares disponibles?`,
          ),
        );
        return;
      }
      if (v.status === 'IN_TRANSIT') {
        if (!t.handled.has('IN_TRANSIT_NOTE')) {
          t.handled.add('IN_TRANSIT_NOTE');
          t.answers.push(
            tr(
              t.lang,
              `The ${st.selectedLabel} is still in transit, so it isn’t here to drive yet. I can request a visit and the sales team will confirm it’s arrived before your time — or you could drive a similar one that’s in stock now.`,
              `El ${st.selectedLabel} sigue en tránsito, así que aún no está para manejarlo. Puedo pedir una visita y el equipo confirma que haya llegado antes de su hora — o puede manejar uno similar que sí está en inventario.`,
            ),
          );
        }
        // Recorded as a sales visit (never a test drive) with the arrival caveat for staff.
        type = 'SALES';
      }
    }
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
    // Tell the customer about a closed day BEFORE asking anything else.
    const early = t.u.entities.when;
    if (early?.date) {
      const hours = await this.getHours(t);
      if (hours?.verified) {
        const dept = type === 'SERVICE' ? 'service' : 'sales';
        const day = StoreHoursService.resolveDay(hours, early.date, dept);
        if (day.closed) {
          st.draftAppointment = {
            type,
            serviceNeed: t.u.entities.serviceNeed ?? st.service?.need,
            when: t.u.entities.when,
          };
          return this.narrateAppointmentResult(
            t,
            {
              status: 'rejected',
              code: 'closed_day',
              day: {
                date: day.date,
                open: day.open,
                close: day.close,
                note: day.note,
              },
              alternatives: AppointmentService.nextOpenDays(
                hours,
                addDaysLocal(early.date, 1),
                dept,
              ),
              timezone: hours.timezone,
            },
            type,
          );
        }
      }
    }
    if (
      type === 'SERVICE' &&
      /\b(check engine|engine light|warning light)\b/i.test(t.message) &&
      !t.handled.has('WARNING_LIGHT_NOTE')
    ) {
      t.handled.add('WARNING_LIGHT_NOTE');
      const g = generalAnswer(t.message, t.lang);
      if (g) t.answers.push(g);
    }
    if (type === 'SERVICE') {
      const need = t.u.entities.serviceNeed ?? st.service?.need;
      st.service = { ...st.service, need };
      // Keep the shopper's sales vehicle untouched; ask which car is being serviced.
      // Only when we'd be asking something anyway: a fully specified request ("oil change
      // Friday morning") is saved first and the vehicle is collected afterwards.
      if (
        !st.service.vehicle &&
        !st.service.vin &&
        !t.u.entities.vin &&
        !t.u.entities.when?.date &&
        !st.parts?.inquiryId
      ) {
        st.draftAppointment = {
          type,
          serviceNeed: need,
          when: t.u.entities.when,
        };
        this.ask(
          t,
          'service_vehicle',
          need
            ? tr(
                t.lang,
                `I can help with that. What vehicle are we scheduling the ${need} for? Year, make and model is plenty.`,
                `Con gusto. ¿Para qué vehículo es el ${need}? Año, marca y modelo es suficiente.`,
              )
            : tr(
                t.lang,
                'I can help with that. What vehicle are we scheduling service for?',
                'Con gusto. ¿Para qué vehículo es el servicio?',
              ),
          2,
        );
        return;
      }
      if (t.u.entities.ownVehicle && !t.handled.has('ACK_OWN_VEHICLE')) {
        t.handled.add('ACK_OWN_VEHICLE');
        const ov = t.u.entities.ownVehicle;
        t.narration.push(
          tr(
            t.lang,
            `Got it — your ${[ov.year, ov.make, ov.model].filter(Boolean).join(' ')}.`,
            `Entendido — su ${[ov.year, ov.make, ov.model].filter(Boolean).join(' ')}.`,
          ),
        );
      }
      // A date/time already given is enough to save the request; the advisor asks the details.
      if (
        !need &&
        !t.u.entities.partNeed &&
        !st.parts?.inquiryId &&
        !t.u.entities.when?.date
      ) {
        st.draftAppointment = { type, when: t.u.entities.when };
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
      st.draftAppointment = {
        type,
        serviceNeed: st.service?.need,
        when: t.u.entities.when,
      };
      this.ask(
        t,
        'appointment_date',
        t.u.entities.looseTime === 'after_work'
          ? tr(
              t.lang,
              'After work works. Which day are you thinking, and about what time do you get off?',
              'Después del trabajo está bien. ¿Qué día piensa venir, y a qué hora sale más o menos?',
            )
          : tr(t.lang, 'What day works for you?', '¿Qué día le funciona?'),
        2,
      );
      return;
    }
    if (when.time === undefined && !when.partOfDay) {
      st.draftAppointment = {
        type,
        serviceNeed: st.service?.need,
        when: t.u.entities.when,
      };
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
      notes:
        [
          type === 'SERVICE' && st.service?.vehicle
            ? `Customer vehicle: ${[st.service.vehicle.year, st.service.vehicle.make, st.service.vehicle.model].filter(Boolean).join(' ')}`
            : null,
          st.parts?.inquiryId
            ? `Installation for parts inquiry ${st.parts.inquiryId}`
            : null,
          type === 'SALES' &&
          st.selectedVin &&
          st.selectedStatus === 'IN_TRANSIT'
            ? `Vehicle ${st.selectedVin}${st.selectedStock ? ` (stock ${st.selectedStock})` : ''} is IN TRANSIT — confirm arrival before any test drive`
            : null,
          t.u.entities.looseTime
            ? `Customer said "${t.u.entities.looseTime.replace('_', ' ')}" — confirm exact time`
            : null,
        ]
          .filter(Boolean)
          .join(' | ') || null,
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
      vehicle: e.ownVehicle
        ? e.ownVehicle
        : e.vehicle?.model
          ? {
              year: e.vehicle.year,
              make: e.vehicle.make,
              model: e.vehicle.model,
            }
          : (st.parts?.vehicle ?? st.service?.vehicle),
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
    if (t.u.entities.askPhone) {
      // One verified number per store (the location record) — never a guessed department line.
      const phone = await this.locationPhone(t);
      if (phone) {
        t.sources.add('location_record');
        t.answers.push(
          tr(
            t.lang,
            `You can reach the dealership at ${phone}.`,
            `Puede comunicarse con la agencia al ${phone}.`,
          ),
        );
      } else {
        t.answers.push(
          tr(
            t.lang,
            'I don’t have a verified phone number on file for this store yet, so I won’t guess one.',
            'Aún no tengo un teléfono verificado para esta agencia, así que no voy a adivinar uno.',
          ),
        );
        this.ask(
          t,
          'confirm_handoff',
          tr(
            t.lang,
            'Want me to have someone from the team reach out to you instead?',
            '¿Quiere que alguien del equipo se comunique con usted?',
          ),
          6,
        );
      }
      if (!/\b(hours|open|close|horario)\b/i.test(t.message)) return;
    }
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
    const demo = hours.synthetic
      ? tr(
          t.lang,
          'These are simulated demo hours, not the store’s real hours — ',
          'Estos son horarios simulados de demostración, no los reales — ',
        )
      : '';
    t.answers.push(
      `${demo}${deptName ? `${deptName}: ` : ''}${summary}. ${now}`.trim(),
    );
    t.cards.push({
      kind: 'hours',
      summary: hours.synthetic
        ? `${tr(t.lang, 'Demo hours', 'Horario demo')} · ${summary}`
        : summary,
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
    let v = ref.v;
    // "Is that good?" refers to the vehicle we just estimated, even if nothing was "selected".
    if (!v && t.u.entities.assessment && t.st.payment.lastEstimate)
      v =
        (await this.inventory.getVehicleByVin(
          t.tenantId,
          t.st.payment.lastEstimate.vin,
        )) ?? undefined;
    if (!v && t.u.entities.priceQuestion && t.st.visibleVins.length > 1) {
      const shown = (
        await this.inventory.getVehiclesByVin(t.tenantId, t.st.visibleVins)
      ).slice(0, 4);
      if (shown.length) {
        t.sources.add('inventory_feed');
        const demo = shown.some((x) => x.simulated)
          ? tr(t.lang, ' (demo figures)', ' (cifras de demostración)')
          : '';
        t.answers.push(
          tr(t.lang, 'Here’s what they’re listed at', 'Estos son sus precios') +
            demo +
            ': ' +
            shown
              .map(
                (x) =>
                  `${vehicleLabel(x, true)} — ${x.price ? money(x.price) : tr(t.lang, 'no price on file', 'sin precio registrado')}`,
              )
              .join('; ') +
            '.',
        );
        this.ask(
          t,
          'vehicle_choice',
          tr(
            t.lang,
            'Which one should we look at more closely?',
            '¿Cuál vemos más de cerca?',
          ),
          3,
        );
        return;
      }
    }
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
    if (t.u.entities.assessment) {
      const est = t.st.payment.lastEstimate;
      const bits: string[] = [];
      if (est && est.vin === v.vin)
        bits.push(
          tr(
            t.lang,
            `As a ballpark, ${money(est.monthly)}/mo is an estimate at an example ${est.apr}% rate over ${est.termMonths} months — your real payment depends on your credit, the lender’s rate and taxes and fees.`,
            `Como referencia, ${money(est.monthly)}/mes es un estimado con una tasa de ejemplo de ${est.apr}% a ${est.termMonths} meses — el pago real depende de su crédito, la tasa del prestamista e impuestos y cargos.`,
          ),
        );
      if (t.st.payment.maxMonthly && est)
        bits.push(
          est.monthly <= t.st.payment.maxMonthly
            ? tr(
                t.lang,
                `It’s within the ${money(t.st.payment.maxMonthly)}/mo you mentioned.`,
                `Está dentro de los ${money(t.st.payment.maxMonthly)}/mes que mencionó.`,
              )
            : tr(
                t.lang,
                `It’s above the ${money(t.st.payment.maxMonthly)}/mo you mentioned — more down or a longer term would lower it.`,
                `Está por encima de los ${money(t.st.payment.maxMonthly)}/mes que mencionó — más enganche o un plazo mayor lo bajaría.`,
              ),
        );
      if (v.price && v.msrp && v.msrp > v.price)
        bits.push(
          tr(
            t.lang,
            `On price, it’s listed ${money(v.msrp - v.price)} under its MSRP of ${money(v.msrp)}${v.simulated ? ' (demo figures)' : ''}.`,
            `En precio, está ${money(v.msrp - v.price)} por debajo de su MSRP de ${money(v.msrp)}${v.simulated ? ' (cifras de demostración)' : ''}.`,
          ),
        );
      t.sources.add('inventory_feed');
      t.answers.push(
        bits.length
          ? bits.join(' ')
          : tr(
              t.lang,
              'It depends mostly on your budget and how you’ll use it — what matters most to you?',
              'Depende sobre todo de su presupuesto y del uso que le dará — ¿qué es lo más importante para usted?',
            ),
      );
      return;
    }
    if (t.u.entities.priceQuestion) {
      // Selling price straight from inventory; never confused with MSRP, payment or OTD.
      t.st.selectedVin = v.vin;
      t.st.selectedLabel = vehicleLabel(v, true);
      t.st.selectedStock = v.stock ?? undefined;
      t.st.selectedStatus = v.status ?? undefined;
      t.sources.add('inventory_feed');
      if (!v.price) {
        t.answers.push(
          tr(
            t.lang,
            `There’s no advertised price on file for the ${t.st.selectedLabel}, so I won’t guess one — the sales team can give you the number.`,
            `No hay un precio anunciado para el ${t.st.selectedLabel}, así que no voy a adivinar — el equipo de ventas le da la cifra.`,
          ),
        );
        this.ask(
          t,
          'confirm_handoff',
          tr(
            t.lang,
            'Want me to have them reach out?',
            '¿Quiere que le contacten?',
          ),
          4,
        );
        return;
      }
      const label = v.simulated
        ? tr(
            t.lang,
            ' (demo figure — simulated inventory)',
            ' (cifra de demostración — inventario simulado)',
          )
        : '';
      const msrp =
        v.msrp && v.msrp > v.price
          ? tr(
              t.lang,
              ` MSRP is ${money(v.msrp)}.`,
              ` El MSRP es ${money(v.msrp)}.`,
            )
          : '';
      const transit =
        v.status === 'IN_TRANSIT'
          ? tr(
              t.lang,
              ' It’s marked in transit, so it isn’t on the lot yet.',
              ' Aparece en tránsito, así que aún no está en el lote.',
            )
          : '';
      t.answers.push(
        tr(
          t.lang,
          `The ${t.st.selectedLabel} is listed at ${money(v.price)}${label}.${msrp}${transit} That’s the selling price before taxes and fees.`,
          `El ${t.st.selectedLabel} tiene un precio de ${money(v.price)}${label}.${msrp}${transit} Es el precio de venta antes de impuestos y cargos.`,
        ),
      );
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'Want a monthly estimate, or the out-the-door number?',
          '¿Quiere un pago mensual estimado o el precio final?',
        ),
        4,
      );
      return;
    }
    if (t.u.entities.lotAgeQuestion) {
      t.sources.add('inventory_feed');
      const lbl = vehicleLabel(v, true);
      t.answers.push(
        v.status === 'IN_TRANSIT'
          ? tr(
              t.lang,
              `The ${lbl} isn’t on the lot yet — it’s marked in transit. I don’t have a verified arrival date, so I won’t guess one.`,
              `El ${lbl} aún no está en el lote — aparece en tránsito. No tengo una fecha de llegada verificada, así que no voy a adivinar.`,
            )
          : v.status === 'AVAILABLE'
            ? tr(
                t.lang,
                `It’s showing as in stock, but the listing doesn’t include the date it arrived, so I can’t say how long it’s been here — the sales team can tell you.`,
                `Aparece en inventario, pero el anuncio no incluye la fecha en que llegó, así que no puedo decir cuánto tiempo lleva — el equipo de ventas se lo dice.`,
              )
            : tr(
                t.lang,
                `The ${lbl} isn’t showing as available right now.`,
                `El ${lbl} no aparece disponible en este momento.`,
              ),
      );
      this.ask(
        t,
        'confirm_handoff',
        tr(
          t.lang,
          'Want me to have someone from sales confirm the details?',
          '¿Quiere que alguien de ventas le confirme los detalles?',
        ),
        6,
      );
      return;
    }
    // "Why should I buy this one?" — a pitch built only from the listing, then a fit question.
    if (
      /\bwhy (?:should|would) i\b|\bwhat makes\b|\bworth (?:it|the money|the price)\b|\bsell me\b/.test(
        m,
      )
    ) {
      const feats = (
        (v as InventoryVehicle & { features?: string[] }).features ?? []
      ).slice(0, 3);
      const points = [
        v.trim
          ? tr(t.lang, `the ${v.trim} trim`, `la versión ${v.trim}`)
          : null,
        v.drivetrain &&
        !(v.trim ?? '').toLowerCase().includes(v.drivetrain.toLowerCase())
          ? v.drivetrain
          : null,
        v.mileage != null && v.mileage < 100
          ? tr(t.lang, 'essentially new miles', 'prácticamente sin millas')
          : null,
        ...feats,
      ].filter(Boolean) as string[];
      t.sources.add('inventory_feed');
      t.answers.push(
        points.length
          ? tr(
              t.lang,
              `From the listing, here’s what it has going for it: ${points.join(', ')}${v.color ? ` — in ${v.color}` : ''}.`,
              `Según el anuncio, esto es lo que ofrece: ${points.join(', ')}${v.color ? ` — en ${v.color}` : ''}.`,
            )
          : tr(
              t.lang,
              'The listing doesn’t give me much beyond the basics, so I won’t oversell it.',
              'El anuncio no da mucho más que lo básico, así que no voy a exagerar.',
            ),
      );
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          'What will you mostly use it for? That tells me whether it’s actually a good fit.',
          '¿Para qué lo usaría principalmente? Así le digo si de verdad le conviene.',
        ),
        5,
      );
      return;
    }
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
    const rank = t.u.entities.rank;
    let vins: string[];
    if (rank && t.st.visibleVins.length >= 2) {
      // "compare the two nicest ones" → rank what's on screen by verified data only.
      const visible = await this.loadVisible(t);
      vins = this.rankVehicles(visible, rank)
        .slice(0, Math.min(rank.count ?? 2, 3))
        .map((v) => v.vin);
    } else {
      vins = [
        ...new Set([
          ...(t.st.selectedVin ? [t.st.selectedVin] : []),
          ...t.st.compareVins,
          ...t.st.visibleVins,
        ]),
      ].slice(0, 3);
    }
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
    // Comparing means no single vehicle is chosen yet — payments then cover each of them.
    if (rank) t.st.selectedVin = undefined;
    t.vehicles = await this.withPaymentEstimates(t, vs);
    t.type = 'vehicle_compare';
    await this.attachVehicleEvidence(t, vs);
    this.signal(t, 'vehicle_compare');
    const [a, b] = vs;
    const name = (v: InventoryVehicle) =>
      [v.year, v.model, v.trim].filter(Boolean).join(' ');
    const diffs: string[] = [];
    if (a && b && a.price && b.price && a.price !== b.price) {
      const hi = a.price > b.price ? a : b;
      const lo = hi === a ? b : a;
      diffs.push(
        tr(
          t.lang,
          `the ${name(hi)} is ${money(hi.price! - lo.price!)} more than the ${name(lo)}`,
          `el ${name(hi)} cuesta ${money(hi.price! - lo.price!)} más que el ${name(lo)}`,
        ),
      );
    }
    if (
      a &&
      b &&
      a.mileage != null &&
      b.mileage != null &&
      Math.abs(a.mileage - b.mileage) > 1000
    ) {
      const less = a.mileage < b.mileage ? a : b;
      diffs.push(
        tr(
          t.lang,
          `the ${name(less)} has ${Math.abs(a.mileage - b.mileage).toLocaleString('en-US')} fewer miles`,
          `el ${name(less)} tiene ${Math.abs(a.mileage - b.mileage).toLocaleString('es-US')} millas menos`,
        ),
      );
    }
    t.narration.push(
      diffs.length
        ? tr(
            t.lang,
            `Here they are side by side. The big differences: ${diffs.join(', and ')}.`,
            `Aquí están lado a lado. Las diferencias principales: ${diffs.join(', y ')}.`,
          )
        : tr(
            t.lang,
            "Here they are side by side — I've highlighted where they actually differ.",
            'Aquí están lado a lado — resalté dónde realmente difieren.',
          ),
    );
    t.facts.push(
      `Compared: ${vs.map((v) => `${vehicleLabel(v)} ${v.price ? money(v.price) : 'no price'}`).join(' vs ')}`,
    );
    this.ask(
      t,
      'none',
      tr(
        t.lang,
        'Anything specific you want to weigh between them — price, miles, features?',
        '¿Algo en particular que quiera comparar — precio, millas, equipamiento?',
      ),
      9,
    );
  }

  private async handleKnowledge(t: Turn) {
    if (t.u.entities.policyTopic) return this.handlePolicyTopic(t);
    if (t.u.entities.managerQuestion) return this.handleManagerQuestion(t);
    if (t.u.entities.otherStore) {
      t.answers.push(
        tr(
          t.lang,
          'I can only see this store’s inventory and records — I don’t have access to other locations, so I can’t show what they have. Their own website or sales team can help with that, and I’m happy to search here.',
          'Solo puedo ver el inventario y los registros de esta agencia — no tengo acceso a otras ubicaciones. Su sitio web o su equipo de ventas le pueden ayudar, y con gusto busco aquí.',
        ),
      );
      return;
    }
    if (t.u.entities.servicePriceQuestion) {
      // Keep any booking question pending; just answer this honestly.
      t.answers.push(
        tr(
          t.lang,
          'I don’t have this store’s verified service prices, so I won’t quote a number — the service team gives you the exact price, usually when they confirm the visit.',
          'No tengo los precios de servicio verificados de esta agencia, así que no voy a dar una cifra — el equipo de servicio le da el precio exacto, normalmente al confirmar la visita.',
        ),
      );
      return;
    }
    if (
      t.u.intents.some(
        (i) =>
          i.intent === 'KNOWLEDGE_QUESTION' && i.evidence === 'whats the catch',
      )
    ) {
      t.answers.push(
        tr(
          t.lang,
          'No catch from my side — chatting here doesn’t commit you to anything. The one thing to know: prices and payments I show are estimates until the dealership puts them in writing, and nothing is booked or approved until a person confirms it.',
          'No hay trampa de mi parte — conversar aquí no le compromete a nada. Lo único: los precios y pagos que muestro son estimados hasta que la agencia los ponga por escrito, y nada queda reservado ni aprobado hasta que una persona lo confirme.',
        ),
      );
      return;
    }
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
    const llmOff = !!(await this.capabilities.flags(t.tenantId, t.locationId))
      .llmDisabled;
    if (!ctx.length && (!this.llm.isEnabled() || llmOff)) {
      const general = generalAnswer(t.message, t.lang);
      if (general) {
        t.sources.add('general_automotive_knowledge');
        t.answers.push(general);
        return;
      }
      t.st.openQuestions = [...t.st.openQuestions, t.message].slice(-3);
      t.st.fallbacks = (t.st.fallbacks ?? 0) + 1;
      if (t.st.fallbacks > 1) {
        // Never the same "I don't have that" twice in a row: say what we CAN do from here.
        const can = t.st.selectedLabel
          ? tr(
              t.lang,
              `I can’t verify that one either. What I can do right now on the ${t.st.selectedLabel}: payments, an out-the-door quote request, or a time to come in.`,
              `Eso tampoco lo puedo verificar. Lo que sí puedo hacer ahora con el ${t.st.selectedLabel}: pagos, una cotización final o una cita.`,
            )
          : tr(
              t.lang,
              'I can’t verify that one either. I can search inventory, run payment estimates, or set up a visit or service request.',
              'Eso tampoco lo puedo verificar. Puedo buscar inventario, calcular pagos o pedir una cita o servicio.',
            );
        t.answers.push(can);
        this.ask(
          t,
          'confirm_handoff',
          tr(
            t.lang,
            'Or I can have a person answer it — want that?',
            'O puedo pedir que una persona le responda — ¿quiere?',
          ),
          6,
        );
        return;
      }
      t.answers.push(
        tr(
          t.lang,
          'That’s not something I have in the dealership’s information, so I’d rather not guess.',
          'Eso no lo tengo en la información de la agencia, y prefiero no adivinar.',
        ),
      );
      this.ask(
        t,
        'confirm_handoff',
        tr(
          t.lang,
          'Want me to have someone from the team confirm it for you?',
          '¿Quiere que alguien del equipo se lo confirme?',
        ),
        6,
      );
      return;
    }
    if (llmOff) {
      // Language model switched off: share the approved text verbatim, never improvise.
      t.answers.push(
        tr(
          t.lang,
          `Here’s what the dealership has on file: ${ctx.join(' ').slice(0, 500)}`,
          `Esto es lo que la agencia tiene registrado: ${ctx.join(' ').slice(0, 500)}`,
        ),
      );
      t.facts.push(...ctx.map((c) => c.slice(0, 300)));
      return;
    }
    let fromModel = false;
    let answer = await this.llm.answerIntelligentQuestion(t.message, ctx, {
      language: t.lang,
      tenantId: t.tenantId,
      assistantName: await this.assistantName(t),
      onModelAnswer: () => {
        fromModel = true;
      },
    });
    if (fromModel) {
      // Model-written answers pass the same grounding guard as polished replies: only claim
      // types present in the retrieved dealership documents may appear.
      const g = this.grounding.sanitizeCustomerReply({
        reply: answer,
        verifiedFacts: verifiedFactsFrom(t.evidence),
        allowedClaimTypes: detectClaimTypes(ctx.join('\n')),
      });
      if (g.sanitized) {
        this.metrics.increment('chat.grounding.sanitized');
        t.languageModel = 'discarded';
        answer = ctx.length
          ? tr(
              t.lang,
              `Here’s what the dealership has on file: ${ctx.join(' ').slice(0, 500)}`,
              `Esto es lo que la agencia tiene registrado: ${ctx.join(' ').slice(0, 500)}`,
            )
          : tr(
              t.lang,
              'That’s not something I have in the dealership’s information, so I’d rather not guess. Want me to have someone from the team confirm it for you?',
              'Eso no lo tengo en la información de la agencia, y prefiero no adivinar. ¿Quiere que alguien del equipo se lo confirme?',
            );
      } else {
        t.languageModel = 'answered';
      }
    }
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
    // Every open request from this conversation (a sales visit AND a service visit, say) gets
    // the contact details — only filling blanks, never overwriting what staff already have.
    const open = {
      tenantId: t.tenantId,
      conversationId: t.s.conversationId,
      status: { in: ['REQUESTED', 'PENDING_CONFIRMATION'] as never },
    };
    const name = this.customerName(t);
    if (name)
      await this.prisma.appointment.updateMany({
        where: { ...open, customerName: null },
        data: { customerName: name },
      });
    if (st.contact.phone)
      await this.prisma.appointment.updateMany({
        where: { ...open, customerPhone: null },
        data: { customerPhone: st.contact.phone },
      });
    if (st.contact.email)
      await this.prisma.appointment.updateMany({
        where: { ...open, customerEmail: null },
        data: { customerEmail: st.contact.email },
      });
    // The staff inbox item (purchase request / handoff) shows how to reach the customer.
    const escId = st.purchase?.escalationId ?? st.handoff?.escalationId;
    if (escId && (name || st.contact.phone || st.contact.email)) {
      const esc = await this.prisma.escalation.findFirst({
        where: { id: escId, tenantId: t.tenantId },
        select: { summary: true },
      });
      const line = `Contact: ${[name, st.contact.phone, st.contact.email].filter(Boolean).join(', ')}`;
      if (esc && !(esc.summary ?? '').includes(line))
        await this.prisma.escalation.updateMany({
          where: { id: escId, tenantId: t.tenantId },
          data: { summary: `${esc.summary ?? ''} | ${line}`.slice(0, 4000) },
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
    if (p === 'figure_meaning' || p === 'payment_method') {
      this.ask(
        t,
        p,
        tr(
          t.lang,
          "A yes doesn't pick one of those. Tell me which you mean in a few words.",
          'Un sí no elige una de esas opciones. Dígame cuál en pocas palabras.',
        ),
        1,
        p === 'figure_meaning' ? 'choice' : undefined,
      );
      return;
    }
    if (p === 'otd_zip') {
      this.ask(
        t,
        'otd_zip',
        tr(
          t.lang,
          "I still need the ZIP code — yes doesn't tell me which one.",
          'Aún necesito el código postal — un sí no me dice cuál.',
        ),
        2,
      );
      return;
    }
    if (p === 'confirm_credit_link') return this.handleCreditApp(t);
    if (p === 'confirm_handoff') return this.handleHandoff(t, 'request');
    if (p === 'text_consent') {
      if (!t.st.contact.phone) return;
      await this.consent.record({
        tenantId: t.tenantId,
        locationId: t.locationId,
        leadId: t.st.leadId ?? null,
        conversationExternalKey: t.s.externalKey,
        channel: 'SMS',
        endpoint: t.st.contact.phone,
        purpose: 'CONVERSATIONAL',
        granted: true,
        wording:
          'OK for the dealership to text you about this conversation? Msg & data rates may apply; reply STOP anytime.',
        wordingVersion: 'sms-continuation-v1',
        source: 'WIDGET',
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
    // "Yes" means yes to the question we JUST asked — nothing else. No offer → no action.
    const offer = this.freshOffer(t);
    switch (offer?.kind) {
      case 'payment':
        return this.handlePayment(t);
      case 'otd':
        return this.handleOtd(t);
      case 'credit':
        return this.handleCreditApp(t);
      case 'handoff':
        return this.handleHandoff(t, 'request');
      case 'visit':
        return this.handleAppointment(
          t,
          t.st.selectedVin ? 'TEST_DRIVE' : 'SALES',
        );
      case 'similar':
      case 'show_vehicles':
        return this.handleSearch(t);
      case 'service':
        return this.handleAppointment(t, 'SERVICE');
      case 'discovery':
        this.ask(
          t,
          'none',
          tr(
            t.lang,
            'Great — what are you thinking? A model, a type like SUV or truck, or a budget is plenty to start.',
            'Perfecto — ¿qué tiene en mente? Un modelo, un tipo como SUV o camioneta, o un presupuesto es suficiente.',
          ),
          2,
        );
        return;
      case 'pick_vehicle':
        if (t.st.visibleVins.length === 1) return this.handleSelect(t);
        break;
      case 'adjust_payment':
        this.ask(
          t,
          'none',
          tr(
            t.lang,
            'Sure — what down payment or term should I try? For example “$5,000 down” or “60 months”.',
            'Claro — ¿qué enganche o plazo pruebo? Por ejemplo “5,000 de enganche” o “60 meses”.',
          ),
          2,
        );
        return;
    }
    // Several cars on screen and none picked: "yes" means "one of these" — ask which.
    if (!t.st.selectedVin && t.st.visibleVins.length > 1) {
      this.ask(
        t,
        'vehicle_choice',
        tr(
          t.lang,
          'Which one caught your eye? The color or trim is enough.',
          '¿Cuál le llamó la atención? El color o la versión es suficiente.',
        ),
        2,
      );
      return;
    }
    if (t.u.entities.interest) {
      if (!t.st.selectedVin && t.st.visibleVins.length === 1)
        return this.handleSelect(t);
      if (t.st.selectedLabel) {
        t.answers.push(
          tr(
            t.lang,
            `Great — the ${t.st.selectedLabel} it is.`,
            `Perfecto — el ${t.st.selectedLabel}.`,
          ),
        );
        this.ask(
          t,
          'none',
          this.salesNextStep(t) ??
            tr(
              t.lang,
              'Want the price, a monthly estimate, or to set up a time to see it?',
              '¿Quiere el precio, un pago mensual estimado o una cita para verlo?',
            ),
          3,
        );
        return;
      }
    }
    if (offer?.kind === 'choice') {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          `Happy to — which one? ${offer.text}`,
          `Con gusto — ¿cuál? ${offer.text}`,
        ),
        2,
      );
      return;
    }
    if (t.st.selectedLabel) {
      this.ask(
        t,
        'none',
        tr(
          t.lang,
          `Sure. On the ${t.st.selectedLabel}, I can run a monthly estimate, start an out-the-door quote, or set up a time to see it — which sounds good?`,
          `Claro. Con el ${t.st.selectedLabel} puedo calcular un pago mensual, pedir el precio final o una cita para verlo — ¿qué prefiere?`,
        ),
        3,
      );
      return;
    }
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
      this.pick(
        t,
        t.lang === 'es'
          ? [
              'Sin problema — aquí estoy si necesita algo más.',
              'Está bien. Cuando quiera, seguimos.',
            ]
          : [
              "No problem — I'm here if you need anything else.",
              'All good. Just say the word whenever you want to pick it back up.',
              "That's fine — no pressure at all.",
            ],
        'decline',
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
      t.answers.push(
        socialLine(
          'greetingFirst',
          t.lang,
          t.st.recentOpeners,
          this.seed(t, 'greet'),
        ),
      );
    }
  }

  /**
   * "How do I buy it now?" — a real purchase workflow, not a knowledge lookup:
   * resolve the exact vehicle, re-read its status, say the legitimate next step for THAT status
   * (in stock / in transit / unavailable), record a purchase-ready request staff can see, and
   * ask the one question that moves it forward (finance or cash → contact → visit).
   * Never promises holds, deposits, delivery, online contracting or completion.
   */
  private async handlePurchase(t: Turn) {
    const st = t.st;
    if (t.u.entities.bringQuestion) {
      t.answers.push(
        tr(
          t.lang,
          'Typically you’d bring your driver’s license, proof of insurance, and how you plan to pay — a down payment method, or financing details if you have them. If you’re trading in, bring the title or payoff info and all the keys. The team will confirm anything specific to this store.',
          'Normalmente se trae la licencia de manejo, comprobante de seguro y cómo piensa pagar — el método del enganche, o los datos de financiamiento si ya los tiene. Si entrega un auto a cuenta, traiga el título o los datos del saldo y todas las llaves. El equipo confirma cualquier requisito específico de la agencia.',
        ),
      );
      if (!st.selectedVin) return;
    }
    if (st.incident?.reportedNames.length) {
      t.answers.push(
        tr(
          t.lang,
          `I won't send you back to ${st.incident.reportedNames.join(', ')}. Someone else on the sales team can take the purchase from here.`,
          `No lo voy a enviar de vuelta con ${st.incident.reportedNames.join(', ')}. Otra persona del equipo de ventas puede seguir con la compra.`,
        ),
      );
    }
    if (!st.selectedVin) {
      if (
        st.incident?.reportedNames.length &&
        (await this.cap(t, 'handoff')).allowed
      ) {
        await this.escalations.appendCustomerReport({
          tenantId: t.tenantId,
          locationId: t.locationId,
          externalKey: t.s.externalKey,
          reason: 'Purchase-ready customer',
          urgency: EscalationUrgency.HIGH,
          line: `PURCHASE REQUEST: customer still wants to buy. Do not assign to reported staff (unverified): ${st.incident.reportedNames.join(', ')}`,
          metadata: {
            kind: 'purchase',
            doNotAssignTo: st.incident.reportedNames,
          },
        });
      }
      const shown = st.visibleVins.length;
      this.ask(
        t,
        'vehicle_choice',
        shown > 1
          ? tr(
              t.lang,
              'Happy to help you get started. Which of these is the one?',
              'Con gusto le ayudo a empezar. ¿Cuál de estos es?',
            )
          : tr(
              t.lang,
              'Happy to help you get started. Which vehicle are you looking to buy?',
              'Con gusto le ayudo a empezar. ¿Qué vehículo quiere comprar?',
            ),
        1,
      );
      return;
    }
    const v = await this.inventory.getVehicleByVin(t.tenantId, st.selectedVin);
    if (!v) {
      t.answers.push(
        tr(
          t.lang,
          'I can’t pull that vehicle up in the current inventory, so I won’t guess whether it’s still available.',
          'No encuentro ese vehículo en el inventario actual, así que no voy a suponer si sigue disponible.',
        ),
      );
      await this.handleHandoff(t, 'request');
      return;
    }
    st.selectedLabel = vehicleLabel(v, true);
    st.selectedStock = v.stock ?? undefined;
    st.selectedStatus = v.status ?? undefined;
    const label = st.selectedLabel;
    const stockNote =
      v.stock || v.simulated
        ? ` (${[v.stock ? `stock ${v.stock}` : null, v.simulated ? tr(t.lang, 'demo vehicle', 'vehículo de demostración') : null].filter(Boolean).join(', ')})`
        : '';
    if (v.status !== 'AVAILABLE' && v.status !== 'IN_TRANSIT') {
      t.answers.push(
        tr(
          t.lang,
          `The ${label}${stockNote} isn’t showing as available anymore, so I can’t start a purchase on it. Want me to find you similar ones that are?`,
          `El ${label}${stockNote} ya no aparece disponible, así que no puedo iniciar una compra con él. ¿Le busco opciones similares que sí estén?`,
        ),
      );
      return;
    }
    const demo = '';
    t.answers.push(
      v.status === 'IN_TRANSIT'
        ? tr(
            t.lang,
            `We can get the process started on the ${label}${stockNote}${demo}. It’s marked in transit, so the sales team needs to confirm when it arrives before anyone can drive it or take it home.`,
            `Podemos empezar el proceso del ${label}${stockNote}${demo}. Aparece en tránsito, así que el equipo de ventas tiene que confirmar cuándo llega antes de manejarlo o llevárselo.`,
          )
        : tr(
            t.lang,
            `Let’s get it started on the ${label}${stockNote}${demo}. It shows as in stock — the sales team will confirm it and walk you through the paperwork.`,
            `Empecemos con el ${label}${stockNote}${demo}. Aparece en inventario — el equipo de ventas lo confirma y le guía con los papeles.`,
          ),
    );
    this.signal(t, 'purchase_ready');
    if (
      st.timeline === undefined &&
      /\b(today|now|tonight|weekend|this week|asap)\b/i.test(t.message)
    )
      st.timeline = 'this_week';

    // One purchase request per vehicle, visible in the staff inbox.
    if (st.purchase?.vin !== v.vin && (await this.cap(t, 'handoff')).allowed) {
      t.toolCount += 1;
      const pay = st.payment.leaseOrPurchase;
      const { escalation, notified, deduped } = await this.escalations.create({
        tenantId: t.tenantId,
        locationId: t.locationId,
        externalKey: t.s.externalKey,
        reason: 'Purchase-ready customer',
        urgency: EscalationUrgency.HIGH,
        summary: [
          `Customer wants to buy: ${label}`,
          `VIN ${v.vin}`,
          v.stock ? `Stock ${v.stock}` : null,
          `Inventory status: ${v.status}`,
          pay === 'cash' || pay === 'lease'
            ? `Payment: ${pay}`
            : st.signals.includes('finance_interest')
              ? 'Payment: finance'
              : 'Payment: not stated yet',
          st.timeline ? `Timeline: ${st.timeline}` : null,
          this.customerName(t) ? `Name: ${this.customerName(t)}` : null,
          st.contact.phone ? `Phone: ${st.contact.phone}` : null,
          st.contact.email ? `Email: ${st.contact.email}` : null,
          st.incident?.reportedNames.length
            ? `Do not assign to reported staff (unverified): ${st.incident.reportedNames.join(', ')}`
            : null,
          `Message: "${redactCreditSensitive(t.message).slice(0, 200)}"`,
        ]
          .filter(Boolean)
          .join(' | '),
        metadata: {
          department: 'sales',
          kind: 'purchase',
          vin: v.vin,
          stock: v.stock ?? null,
          inventoryStatus: v.status ?? null,
          leadId: st.leadId ?? null,
        },
      });
      if (deduped) {
        // One open inbox item per conversation: add the purchase to it so staff see it.
        const line = `PURCHASE REQUEST: ${label} | VIN ${v.vin}${v.stock ? ` | Stock ${v.stock}` : ''} | Status ${v.status}${st.incident?.reportedNames.length ? ` | Do not assign to reported staff (unverified): ${st.incident.reportedNames.join(', ')}` : ''}`;
        if (!(escalation.summary ?? '').includes(line))
          await this.prisma.escalation.updateMany({
            where: { id: escalation.id, tenantId: t.tenantId },
            data: {
              summary: `${escalation.summary ?? ''} | ${line}`.slice(0, 4000),
              urgency: EscalationUrgency.HIGH,
            },
          });
      }
      st.purchase = {
        vin: v.vin,
        stock: v.stock ?? undefined,
        status: v.status ?? undefined,
        escalationId: escalation.id,
        notified,
        requestedAt: new Date().toISOString(),
      };
      st.handoff = st.handoff ?? { escalationId: escalation.id, notified };
      t.conversationExtra.handoffState = notified ? 'QUEUED' : 'REQUESTED';
      t.cards.push({
        kind: 'handoff',
        state: notified ? 'notified' : 'recorded',
        escalationId: escalation.id,
      });
      t.narration.push(
        notified
          ? tr(
              t.lang,
              'I’ve sent this to the sales team as a purchase request.',
              'Envié esto al equipo de ventas como solicitud de compra.',
            )
          : tr(
              t.lang,
              'I’ve saved this as a purchase request for the sales team.',
              'Guardé esto como solicitud de compra para el equipo de ventas.',
            ),
      );
    }

    // The one question that moves it forward. "buy" alone is not a stated payment method.
    const methodStated =
      st.payment.leaseOrPurchase === 'cash' ||
      st.payment.leaseOrPurchase === 'lease' ||
      st.signals.includes('finance_interest') ||
      (!!st.otd?.paymentMethod && st.otd.paymentMethod !== 'UNDECIDED');
    if (!methodStated) {
      this.ask(
        t,
        'payment_method',
        tr(
          t.lang,
          'Are you planning to finance or pay cash?',
          '¿Piensa financiarlo o pagar de contado?',
        ),
        1,
      );
    } else if (!st.contact.phone && !st.contact.email) {
      this.ask(
        t,
        'contact_method',
        tr(
          t.lang,
          'What’s the best number or email for the sales team to reach you?',
          '¿Cuál es el mejor número o correo para que el equipo de ventas le contacte?',
        ),
        1,
      );
    } else if (!st.appointment) {
      this.ask(
        t,
        'appointment_date',
        v.status === 'IN_TRANSIT'
          ? tr(
              t.lang,
              'Want me to request a time to come in once it arrives? What day works for you?',
              '¿Quiere que pida una cita para cuando llegue? ¿Qué día le funciona?',
            )
          : tr(
              t.lang,
              'What day works for you to come in?',
              '¿Qué día le funciona para venir?',
            ),
        2,
      );
    }
  }

  /** Compact structured memory for the composer — no phone/email (privacy). */
  private memorySummary(t: Turn): string[] {
    const st = t.st;
    const m: string[] = [];
    if (st.department) m.push(`department: ${st.department}`);
    if (st.selectedLabel)
      m.push(
        `selected vehicle: ${st.selectedLabel}${st.selectedStock ? ` (stock ${st.selectedStock})` : ''}${st.selectedStatus ? `, status ${st.selectedStatus}` : ''}`,
      );
    const c = st.criteria;
    const crit = [
      c.model,
      c.bodyType,
      c.color,
      c.maxPrice ? `under $${c.maxPrice.toLocaleString('en-US')}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    if (crit) m.push(`shopping for: ${crit}`);
    if (st.payment.maxMonthly)
      m.push(`monthly budget: $${st.payment.maxMonthly}`);
    if (
      st.payment.leaseOrPurchase === 'cash' ||
      st.payment.leaseOrPurchase === 'lease'
    )
      m.push(`payment method: ${st.payment.leaseOrPurchase}`);
    const e = st.payment.lastEstimate;
    if (e)
      m.push(
        `last payment estimate: $${e.monthly}/mo, $${e.downPayment} down, ${e.termMonths} months, example ${e.apr}% APR (estimate)`,
      );
    if (st.otd?.requestId)
      m.push(
        `out-the-door quote: requested${st.otd.zip ? `, ZIP ${st.otd.zip}` : ', ZIP not given'}`,
      );
    if (st.appointment)
      m.push(
        `${st.appointment.type.toLowerCase()} appointment: ${st.appointment.status} ${st.appointment.requestedDate ?? ''} ${st.appointment.requestedTime ?? ''}`.trim(),
      );
    if (st.service?.need || st.service?.vehicle)
      m.push(
        `service: ${st.service.need ?? 'need not stated'}${st.service.vehicle ? ` for their ${[st.service.vehicle.year, st.service.vehicle.make, st.service.vehicle.model].filter(Boolean).join(' ')}` : ''}`,
      );
    if (st.parts?.need) m.push(`parts: ${st.parts.need}`);
    if (st.trade?.model)
      m.push(
        `trade-in: ${[st.trade.year, st.trade.make, st.trade.model].filter(Boolean).join(' ')}`,
      );
    if (st.finance?.creditLinkOffered)
      m.push(
        `credit application: ${st.finance.creditPreview ? 'demo preview shown' : 'link offered'} (not submitted, not approved)`,
      );
    if (st.handoff?.escalationId)
      m.push(
        `staff request: saved${st.handoff.notified ? ', delivery confirmed' : ', delivery not confirmed'}`,
      );
    if (st.contact.firstName)
      m.push(`customer first name: ${st.contact.firstName}`);
    if (st.contact.phone || st.contact.email)
      m.push('contact details: on file');
    return m;
  }

  /** What each card on screen shows (numbers included) so the sentence agrees with it. */
  private cardSummaries(t: Turn): string[] {
    const out: string[] = [];
    for (const v of (t.vehicles ?? []).slice(0, 6))
      out.push(
        `vehicle card: ${vehicleLabel(v, true)}${v.price ? `, $${v.price.toLocaleString('en-US')}` : ''}${v.msrp ? `, MSRP $${v.msrp.toLocaleString('en-US')}` : ''}${v.status ? `, ${v.status}` : ''}${v.simulated ? ', demo vehicle' : ''}${v.mileage != null ? `, ${v.mileage.toLocaleString('en-US')} mi` : ''}`,
      );
    for (const c of t.cards) {
      const { kind, ...rest } = c as Record<string, unknown> & { kind: string };
      for (const k of ['url', 'id', 'escalationId', 'lines', 'policyVersion'])
        delete (rest as Record<string, unknown>)[k];
      out.push(`${kind} card: ${JSON.stringify(rest).slice(0, 400)}`);
    }
    return out;
  }

  /** The offer from the immediately preceding assistant turn, if still current. */
  private freshOffer(t: Turn) {
    const o = t.st.lastOffer;
    return o && o.turn === t.st.turnCount ? o : undefined;
  }

  /** Tenant/location display name for the assistant (configured branding, never hard-coded). */
  private async assistantName(t: Turn): Promise<string> {
    const [tenant, loc] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: t.tenantId },
        select: { publicConfig: true },
      }),
      t.locationId
        ? this.prisma.location.findFirst({
            where: { id: t.locationId, tenantId: t.tenantId },
            select: { publicConfig: true },
          })
        : null,
    ]);
    return mergePublicBranding(tenant?.publicConfig, loc?.publicConfig)
      .assistantDisplayName;
  }

  /** "What is your name?" / "Why are you texting me?" — answered from facts, no sales push. */
  private async handleWhoWeAre(t: Turn, act: 'name' | 'origin') {
    const name = await this.assistantName(t);
    if (act === 'name') {
      t.answers.push(
        tr(
          t.lang,
          `I’m ${name}, the dealership’s AI assistant on its website — not a person, but I can bring one in anytime.`,
          `Soy ${name}, el asistente de IA de la agencia en su sitio web — no una persona, pero puedo conectarle con alguien cuando quiera.`,
        ),
      );
      return;
    }
    // Only an actual SMS conversation would make "texting" true.
    const channel = await this.prisma.conversation
      .findFirst({
        where: { id: t.s.conversationId, tenantId: t.tenantId },
        select: { channel: true },
      })
      .catch(() => null);
    const sms = /sms|text/i.test(String(channel?.channel ?? ''));
    const never = /\b(?:never|didn'?t|did not)\b/i.test(t.message);
    t.answers.push(
      sms
        ? tr(
            t.lang,
            'You’re right to ask. This conversation is by text with the dealership. If you’d rather not get messages, reply STOP and they’ll end.',
            'Con razón pregunta. Esta conversación es por mensaje de texto con la agencia. Si prefiere no recibir mensajes, responda STOP.',
          )
        : never
          ? tr(
              t.lang,
              `You’re right — you didn’t reach out to us, and I haven’t sent you anything. I’m ${name}, the chat on the dealership’s website; I only see what’s typed in this window. No pressure at all — if you need anything, I’m here.`,
              `Tiene razón — usted no nos contactó y yo no le he enviado nada. Soy ${name}, el chat del sitio web de la agencia; solo veo lo que se escribe en esta ventana. Sin presión — si necesita algo, aquí estoy.`,
            )
          : tr(
              t.lang,
              `I’m not texting you — this is ${name}, the chat window on the dealership’s website. I haven’t sent anything to your phone or email; I only see what’s typed here.`,
              `No le estoy enviando mensajes de texto — soy ${name}, el chat del sitio web de la agencia. No he enviado nada a su teléfono ni correo; solo veo lo que se escribe aquí.`,
            ),
    );
  }

  /** "Who is your manager?" — answer from verified staff data or say plainly it isn't on file. */
  private async handlePolicyTopic(t: Turn) {
    const topic = t.u.entities.policyTopic!;
    const kc = await this.cap(t, 'knowledge');
    const knowledge = kc.allowed
      ? await this.knowledge.search({
          tenantId: t.tenantId,
          locationId: t.locationId,
          query: t.message,
          forWidget: true,
          limit: 3,
        })
      : [];
    const policy = await this.getPolicy(t);
    let features: string[] | undefined;
    let vehicleLabelText = t.st.selectedLabel;
    let advertisedPrice: number | null = null;
    if (t.st.selectedVin) {
      const v = await this.inventory.getVehicleByVin(
        t.tenantId,
        t.st.selectedVin,
      );
      if (v) {
        features = v.features;
        vehicleLabelText = vehicleLabel(v, true);
        advertisedPrice = v.price ?? null;
      }
    }
    let hoursSummary: string | null = null;
    if (topic === 'walk_in') {
      const hours = await this.getHours(t);
      if (hours?.verified)
        hoursSummary = StoreHoursService.summarize(hours, 'store', t.lang);
    }
    const fact = answerDealershipFact({
      topic,
      knowledge: knowledge.map((h) => ({ title: h.title, content: h.content })),
      docFee: policy.docFee,
      taxRatePercent: policy.taxRatePercent,
      policyConfigured: policy.mode === 'DEALER_CONFIGURED',
      features,
      vehicleLabel: vehicleLabelText,
      hoursSummary,
      advertisedPrice,
    });
    if (
      fact.source !== 'none' &&
      fact.source !== 'general_automotive_knowledge'
    )
      t.sources.add(fact.source);
    if (fact.source === 'general_automotive_knowledge')
      t.sources.add('general_automotive_knowledge');
    if (knowledge.length) t.sources.add('knowledge_base');
    t.answers.push(t.lang === 'es' ? fact.es : fact.en);
    t.facts.push((t.lang === 'es' ? fact.es : fact.en).slice(0, 300));
  }

  private async handleManagerQuestion(t: Turn) {
    const kc = await this.cap(t, 'knowledge');
    if (kc.allowed) {
      const hits = await this.knowledge.search({
        tenantId: t.tenantId,
        locationId: t.locationId,
        query: t.message,
        forWidget: true,
        limit: 3,
      });
      if (hits.length) {
        t.sources.add('knowledge_base');
        t.answers.push(
          tr(
            t.lang,
            `Here's what the dealership has on file: ${hits
              .map((h) => h.content)
              .join(' ')
              .slice(0, 500)}`,
            `Esto es lo que la agencia tiene registrado: ${hits
              .map((h) => h.content)
              .join(' ')
              .slice(0, 500)}`,
          ),
        );
        return;
      }
    }
    t.answers.push(
      tr(
        t.lang,
        'I don’t have the managers’ names in what I can verify, so I won’t guess. I can ask a manager to reach out to you, though.',
        'No tengo los nombres de los gerentes en la información que puedo verificar, así que no voy a adivinar. Sí puedo pedir que un gerente le contacte.',
      ),
    );
    this.ask(
      t,
      'confirm_handoff',
      tr(t.lang, 'Want me to do that?', '¿Quiere que lo haga?'),
      3,
    );
  }

  /** Short replies that only make sense against the previous assistant message. */
  private async handleFollowUp(t: Turn): Promise<boolean> {
    const f = t.u.entities.followUp;
    if (!f) return false;
    const offer = this.freshOffer(t) ?? t.st.lastOffer;
    switch (f) {
      case 'who_is_that':
        t.answers.push(
          offer?.kind === 'handoff' ||
            /team|manager|someone/i.test(offer?.text ?? '')
            ? tr(
                t.lang,
                'Someone on the dealership’s team — I don’t have individual names I can verify here, so I won’t guess.',
                'Alguien del equipo de la agencia — no tengo nombres que pueda verificar, así que no voy a adivinar.',
              )
            : tr(
                t.lang,
                'Sorry — who do you mean?',
                'Perdón — ¿a quién se refiere?',
              ),
        );
        return true;
      case 'hold_on':
        t.answers.push(
          tr(
            t.lang,
            'Take your time — I’ll be right here.',
            'Tómese su tiempo — aquí estoy.',
          ),
        );
        return true;
      case 'what_do_you_mean':
        t.answers.push(
          offer?.text
            ? tr(
                t.lang,
                `Sorry — let me put it simply. I was asking: ${offer.text}`,
                `Perdón — se lo digo más simple. Le preguntaba: ${offer.text}`,
              )
            : tr(
                t.lang,
                'Sorry, that wasn’t clear. What can I help you with?',
                'Perdón, no fui claro. ¿En qué le ayudo?',
              ),
        );
        return true;
      case 'why': {
        const WHY: Partial<Record<OfferKind, [string, string]>> = {
          zip: [
            'The registration ZIP decides which sales tax and registration fees apply — that’s what turns the price into an out-the-door number.',
            'El código postal de registro define qué impuestos y cargos aplican — así se calcula el precio final.',
          ],
          contact: [
            'So the team can reach you about this — I only share it with this dealership.',
            'Para que el equipo le contacte sobre esto — solo lo comparto con esta agencia.',
          ],
          date: [
            'So I can put in the visit request for a time that works for you — the team then confirms it.',
            'Para pedir la visita en un horario que le funcione — luego el equipo la confirma.',
          ],
          payment: [
            'Just so you can see a ballpark monthly number — it’s an estimate, not an offer.',
            'Solo para que vea un pago mensual aproximado — es un estimado, no una oferta.',
          ],
          credit: [
            'It’s the only way to see real financing terms — the lender sets the rate after reviewing it.',
            'Es la única forma de ver términos reales — el prestamista define la tasa al revisarla.',
          ],
        };
        const w = offer ? WHY[offer.kind] : undefined;
        t.answers.push(
          w
            ? t.lang === 'es'
              ? w[1]
              : w[0]
            : tr(
                t.lang,
                'Fair question — what part would you like me to explain?',
                'Buena pregunta — ¿qué parte quiere que le explique?',
              ),
        );
        return true;
      }
      case 'send_it':
        if (offer?.kind === 'credit') {
          await this.handleCreditApp(t);
          return true;
        }
        if (offer?.kind === 'otd') {
          await this.handleOtd(t);
          return true;
        }
        t.answers.push(
          tr(
            t.lang,
            'Happy to — what would you like me to send?',
            'Con gusto — ¿qué le envío?',
          ),
        );
        return true;
      case 'show_me':
        if (offer?.kind === 'payment') await this.handlePayment(t);
        else if (t.st.selectedVin) await this.handleResume(t);
        else await this.handleSearch(t);
        return true;
      case 'that_one':
        if (t.st.visibleVins.length === 1 || t.u.entities.vehicle) {
          await this.handleSelect(t);
        } else {
          this.ask(
            t,
            'vehicle_choice',
            tr(
              t.lang,
              'Which one — the color or trim is enough.',
              '¿Cuál — el color o la versión es suficiente.',
            ),
            2,
          );
        }
        return true;
    }
    return false;
  }

  /**
   * Weather / sports. Facts only from a live provider (with source + retrieval time). Without
   * one, say plainly we can't check live — never present memory as current.
   */
  private async handleLiveInfo(t: Turn) {
    const topic =
      t.u.entities.liveTopic ??
      (/\b(weather|rain|snow|forecast)\b/i.test(t.message)
        ? 'weather'
        : 'sports');
    if (topic === 'sports') {
      const r = await this.liveInfo.sports();
      t.live = `sports: ${r.status} (${r.reason}) — no live scores, results or schedules may be stated`;
      t.answers.push(
        tr(
          t.lang,
          'I can’t check live scores or schedules — I don’t have a live sports feed connected, so I won’t guess a result.',
          'No puedo revisar marcadores ni horarios en vivo — no tengo una fuente deportiva conectada, así que no voy a adivinar.',
        ),
      );
      return;
    }
    let place = this.liveInfo.resolvePlace(t.message);
    if (!place && t.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: t.locationId, tenantId: t.tenantId },
        select: { address: true, timezone: true },
      });
      place =
        this.liveInfo.resolvePlace(loc?.address) ??
        (loc?.timezone === 'America/Chicago' ? 'chicago' : null);
    }
    if (!place) {
      this.ask(
        t,
        'none',
        tr(t.lang, 'Which city should I check?', '¿De qué ciudad?'),
        3,
      );
      return;
    }
    const w = await this.liveInfo.weather(place);
    if (w.status !== 'ok') {
      t.live = 'weather: unavailable — no forecast may be stated';
      t.answers.push(
        w.status === 'unknown_place'
          ? tr(
              t.lang,
              'I can only check live weather for the Chicago area right now.',
              'Por ahora solo puedo revisar el clima en vivo del área de Chicago.',
            )
          : tr(
              t.lang,
              'I can’t reach the live weather service right now, so I won’t guess a forecast.',
              'No puedo consultar el clima en vivo ahora, así que no voy a adivinar.',
            ),
      );
      return;
    }
    t.sources.add('live_weather_nws');
    const lines = w.periods.map(
      (p) =>
        `${p.name}: ${p.temperature}°${p.unit}, ${p.shortForecast}${p.precipitationChance != null ? `, ${p.precipitationChance}% chance of precipitation` : ''}${p.wind ? `, wind ${p.wind}` : ''}`,
    );
    t.live = `weather for ${w.place} from ${w.source}, retrieved ${w.retrievedAt}:\n${lines.join('\n')}`;
    const [a, b] = w.periods;
    t.answers.push(
      tr(
        t.lang,
        `Per the National Weather Service for ${w.place}: ${a.name.toLowerCase()}, ${a.temperature}°${a.unit} and ${a.shortForecast.toLowerCase()}${b ? `; ${b.name.toLowerCase()}, ${b.temperature}°${b.unit} and ${b.shortForecast.toLowerCase()}` : ''}.`,
        `Según el Servicio Meteorológico Nacional para ${w.place}: ${a.name}, ${a.temperature}°${a.unit}, ${a.shortForecast}${b ? `; ${b.name}, ${b.temperature}°${b.unit}, ${b.shortForecast}` : ''}.`,
      ),
    );
    t.facts.push(...lines.map((l) => `NWS ${w.place} ${l}`));
  }

  /** "Let's go back to the Jeep" — restore the shopping vehicle and recap where we were. */
  private async handleResume(t: Turn) {
    const st = t.st;
    if (!st.selectedVin) return this.handleSearch(t);
    const v = await this.inventory.getVehicleByVin(t.tenantId, st.selectedVin);
    if (!v) return this.handleSearch(t);
    // A model named in the message that isn't the selected one is a new search, not a return.
    const named = t.u.entities.vehicle?.model?.toLowerCase();
    if (named && !(v.model ?? '').toLowerCase().includes(named))
      return this.handleSearch(t);
    st.selectedLabel = vehicleLabel(v, true);
    st.selectedStock = v.stock ?? undefined;
    st.selectedStatus = v.status ?? undefined;
    st.department = 'sales';
    st.visibleVins = [v.vin];
    t.vehicles = [v];
    t.type = 'vehicle_carousel';
    await this.attachVehicleEvidence(t, [v]);
    const recap: string[] = [];
    if (v.status === 'IN_TRANSIT')
      recap.push(
        tr(t.lang, 'it’s still marked in transit', 'sigue en tránsito'),
      );
    const est = st.payment.lastEstimate;
    if (est && est.vin === v.vin)
      recap.push(
        tr(
          t.lang,
          `your estimate was about ${money(est.monthly)}/mo with ${money(est.downPayment)} down over ${est.termMonths} months`,
          `su estimado era unos ${money(est.monthly)}/mes con ${money(est.downPayment)} de enganche a ${est.termMonths} meses`,
        ),
      );
    if (st.otd?.requestId && st.otd.vin === v.vin)
      recap.push(
        tr(
          t.lang,
          'your out-the-door quote request is saved',
          'su solicitud de precio final está guardada',
        ),
      );
    if (st.appointment && st.appointment.type !== 'SERVICE')
      recap.push(
        tr(
          t.lang,
          `your visit request for ${st.appointment.requestedDate ?? ''} is ${st.appointment.status === 'CONFIRMED' ? 'confirmed' : 'still a request'}`.replace(
            '  ',
            ' ',
          ),
          `su solicitud de visita del ${st.appointment.requestedDate ?? ''} está ${st.appointment.status === 'CONFIRMED' ? 'confirmada' : 'pendiente'}`,
        ),
      );
    t.answers.push(
      tr(
        t.lang,
        `Back to the ${st.selectedLabel}${recap.length ? ` — ${recap.join('; ')}` : ''}.`,
        `De vuelta al ${st.selectedLabel}${recap.length ? ` — ${recap.join('; ')}` : ''}.`,
      ),
    );
    this.ask(
      t,
      'none',
      tr(
        t.lang,
        'What would you like to do next on it?',
        '¿Qué le gustaría hacer ahora con él?',
      ),
      7,
    );
  }

  /** "Actually I changed my mind" — drop whatever was being collected, keep what's true. */
  private handleChangeOfMind(t: Turn) {
    const st = t.st;
    st.draftAppointment = undefined;
    st.pending = 'none';
    t.answers.push(
      st.selectedLabel
        ? tr(
            t.lang,
            `No problem at all. Want to look at something other than the ${st.selectedLabel}, or change something else?`,
            `No hay problema. ¿Quiere ver algo distinto al ${st.selectedLabel}, o cambiar otra cosa?`,
          )
        : tr(
            t.lang,
            'No problem at all — what would you like to do instead?',
            'No hay problema — ¿qué le gustaría hacer en su lugar?',
          ),
    );
  }

  /** The customer says we didn't answer. Own it, name the question, give the honest path. */
  private handleNotAnswered(t: Turn) {
    const st = t.st;
    const q = st.openQuestions[st.openQuestions.length - 1];
    if (q) {
      t.answers.push(
        tr(
          t.lang,
          `You’re right, sorry — I didn’t give you a straight answer on “${q.slice(0, 120)}”. That’s something I can’t verify from the dealership’s information, and I won’t make it up.`,
          `Tiene razón, perdón — no le di una respuesta clara sobre “${q.slice(0, 120)}”. Eso no lo puedo verificar con la información de la agencia, y no lo voy a inventar.`,
        ),
      );
      this.ask(
        t,
        'confirm_handoff',
        tr(
          t.lang,
          'Want me to get a person from the team on it?',
          '¿Quiere que alguien del equipo se encargue?',
        ),
        1,
      );
    } else {
      t.answers.push(
        tr(
          t.lang,
          'Tell me the question again and I’ll give you a straight answer — or tell you plainly if it’s something I can’t verify.',
          'Perdón — dígame la pregunta otra vez y le doy una respuesta directa, o le digo claramente si es algo que no puedo verificar.',
        ),
      );
    }
  }

  private handleUnknown(t: Turn) {
    if (t.answers.length || t.narration.length || t.questions.length) return;
    const st = t.st;
    // Ask ONE clarifying question grounded in where the conversation is — never a menu.
    const text =
      st.department === 'service'
        ? tr(
            t.lang,
            "Sorry, I didn't quite catch that — is this about your service visit, or something else?",
            'Perdón, no le entendí bien — ¿es sobre su servicio, o algo más?',
          )
        : st.selectedLabel
          ? tr(
              t.lang,
              `Sorry, I didn't quite follow — is that about the ${st.selectedLabel}, or something else?`,
              `Perdón, no le entendí — ¿es sobre el ${st.selectedLabel}, o algo más?`,
            )
          : this.pick(
              t,
              t.lang === 'es'
                ? ['Perdón, no le entendí bien. ¿Me cuenta un poco más?']
                : [
                    "Sorry, I didn't quite catch that — could you tell me a bit more?",
                    'I want to make sure I get this right — what are you looking for?',
                  ],
              'unk',
            );
    this.ask(t, 'none', text, 9);
  }

  // ───────────────────────────────────────── lead sync

  /** Point the trade at the vehicle being bought, never at the trade itself. */
  private async syncTradeTarget(t: Turn) {
    const tr0 = t.st.trade;
    if (!tr0?.requestId || !t.st.selectedVin) return;
    const tradeModel = (tr0.model ?? '').toLowerCase();
    const selected = (t.st.selectedLabel ?? '').toLowerCase();
    if (tradeModel && selected.includes(tradeModel)) return;
    await this.prisma.tradeRequest.updateMany({
      where: { id: tr0.requestId, tenantId: t.tenantId },
      data: { desiredVehicleVin: t.st.selectedVin },
    });
  }

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
        'purchase_ready',
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
    if (isNewLead) {
      void this.analytics.trackEvent(
        t.tenantId,
        t.locationId,
        'lead_captured',
        { stage: score.stage },
        t.s.externalKey,
      );
      await this.campaigns.onEvent({
        tenantId: t.tenantId,
        locationId: t.locationId,
        trigger: 'lead.no_response',
        subjectId: lead.id,
      });
    }
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
    const paymentCurrent =
      !!est && (!st.selectedVin || est.vin === st.selectedVin);
    return {
      selectedVehicle: st.selectedVin
        ? { vin: st.selectedVin, label: st.selectedLabel ?? st.selectedVin }
        : null,
      payment:
        paymentCurrent && est
          ? {
              vin: est.vin,
              monthly: est.monthly,
              termMonths: est.termMonths,
              downPayment: est.downPayment,
              aprSource: est.aprSource,
              product: 'finance',
              status: 'estimate',
              includesTaxAndFees: est.includesTaxAndFees,
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
      // OFFERED = live link shown; PREVIEW = labeled demo preview (never reaches the vendor).
      // Neither means sent, clicked, submitted or approved.
      creditApplication: st.finance?.creditLinkOffered
        ? { state: st.finance.creditPreview ? 'PREVIEW' : 'OFFERED' }
        : null,
      otdQuote:
        st.otd?.requestId &&
        (!st.selectedVin || !st.otd.vin || st.otd.vin === st.selectedVin)
          ? {
              status: st.otd.estimated ? 'ESTIMATE_SHOWN' : 'REQUESTED',
              vin: st.otd.vin,
              total:
                (
                  t.cards.find((c) => c.kind === 'otd_quote') as
                    | { total: number | null }
                    | undefined
                )?.total ?? null,
            }
          : null,
      service:
        st.service?.need || st.service?.vehicle
          ? {
              need: st.service?.need,
              vehicle: st.service?.vehicle
                ? [
                    st.service.vehicle.year,
                    st.service.vehicle.make,
                    st.service.vehicle.model,
                  ]
                    .filter(Boolean)
                    .join(' ')
                : undefined,
            }
          : null,
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
      !st.incident?.withholdContact &&
      ((st.appointment &&
        ['REQUESTED', 'PENDING_CONFIRMATION'].includes(
          st.appointment.status,
        )) ||
        !!st.handoff?.escalationId);
    // After a topic change, say WHY we still need it instead of a bare "who should they ask for?".
    const offTopic =
      !!st.appointment &&
      !t.u.intents.some((i) => /APPOINTMENT|PROVIDE_CONTACT/.test(i.intent));
    const forWhat = offTopic
      ? st.appointment!.type === 'SERVICE'
        ? tr(
            t.lang,
            'For your service request, ',
            'Para su solicitud de servicio, ',
          )
        : tr(
            t.lang,
            'For your visit request, ',
            'Para su solicitud de visita, ',
          )
      : '';
    if (needsContact && !st.contact.firstName) {
      return {
        key: 'contact_name',
        text: forWhat
          ? `${forWhat}${tr(t.lang, 'who should the team ask for?', '¿a nombre de quién lo dejo?')}`
          : tr(
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
    // A question we just asked and are deliberately not repeating is still the one an answer
    // ("60614", "Saturday") belongs to.
    const quiet = ranked.find((x) => x.key !== 'none' && skipped(x.key));
    if (quiet) silentPending = quiet.key;
    if (!q && !opts.forcedReply) {
      const o = this.outstandingQuestion(t);
      if (o && !skipped(o.key)) q = o;
      else if (o) silentPending = o.key; // still awaiting it — just don't nag
    }
    // Never answer with nothing: if the only thing left to say is the question we asked last
    // turn, ask it again (an empty "How can I help?" is worse than a repeat).
    if (
      !q &&
      !opts.forcedReply &&
      !t.answers.length &&
      !t.narration.length &&
      quiet
    )
      q = quiet;
    if (q && q.key !== 'none')
      st.lastAsked = { key: q.key, turn: st.turnCount + 1 };
    st.lastOffer = q
      ? {
          kind: offerFor(q),
          text: q.text,
          vin: st.selectedVin,
          department: st.department ?? null,
          turn: st.turnCount + 1,
        }
      : undefined;
    st.pending = q?.key ?? silentPending ?? 'none';
    const ack = chooseAcknowledgement({
      sentiment: t.u.sentiment,
      intents: t.u.intents.map((i) => i.intent),
      isCorrection: t.isCorrection,
      lang: t.lang,
      recentOpeners: st.recentOpeners,
    });
    const plan = compose({
      acknowledgement: opts.forcedReply ? undefined : (t.socialPrefix ?? ack),
      directAnswer: opts.forcedReply ? [opts.forcedReply] : t.answers,
      actionNarration: opts.forcedReply ? [] : t.narration,
      followUpQuestion: opts.forcedReply ? undefined : q?.text,
    });
    let draft =
      plan.text || tr(t.lang, 'How can I help?', '¿En qué le puedo ayudar?');
    if (signature(draft) === st.lastReplySig && !q) {
      // Same question asked again: keep the facts, but don't answer like a recording.
      draft = `${draft} ${tr(t.lang, 'Is there anything else I can help you with?', '¿Hay algo más en lo que le pueda ayudar?')}`;
    } else if (signature(draft) === st.lastReplySig && q) {
      // Re-asking the same thing: never drop the question itself. Say why we're asking again.
      const said = t.answers.concat(t.narration).join(' ').trim();
      draft = said
        ? `${said} ${tr(t.lang, 'Or is there something else I can help with?', '¿O hay algo más en lo que le pueda ayudar?')}`
        : `${tr(t.lang, 'Sorry, I still need one detail —', 'Perdón, aún me falta un dato —')} ${q.text.charAt(0).toLowerCase()}${q.text.slice(1)}`;
    }

    // Language layer: polish with LLM (router → fallback). Claims present in the server
    // draft were produced from tool evidence; anything NEW the model adds is stripped.
    let reply = draft;
    let segments = plan.segments.length ? plan.segments : [draft];
    const llmOff = !!(await this.capabilities.flags(t.tenantId, t.locationId))
      .llmDisabled;
    // Handoff/urgent turns are composed too (the validator keeps the honest delivery status);
    // only turns where a tool failed keep the fixed error wording.
    const usePolish =
      !llmOff &&
      !opts.forcedReply &&
      !t.lockReply &&
      !t.u.intents.some((i) => i.intent === 'SAFETY_URGENT') &&
      !t.narration.some((n) => /couldn't save that|no pude guardar/.test(n)) &&
      draft.length > 0;
    // Claude composes the reply from the conversation, memory and tool results; the
    // validator keeps it grounded. A model-answered knowledge reply is already model-written.
    if (
      usePolish &&
      t.languageModel !== 'answered' &&
      this.composer.isEnabled()
    ) {
      const transcript = (
        await this.store
          .recentMessages(t.s.conversationId, 10)
          .catch(
            () =>
              [] as Array<{ role: string; content: string; createdAt: Date }>,
          )
      )
        .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
        .map((m) => ({
          role: m.role as 'USER' | 'ASSISTANT',
          content: m.content,
        }));
      // the current message is passed separately
      if (
        transcript.length &&
        transcript[transcript.length - 1].role === 'USER'
      )
        transcript.pop();
      const res = await this.composer.compose({
        message: t.message,
        transcript,
        memory: this.memorySummary(t),
        draft,
        facts: [
          ...t.facts,
          ...verifiedFactsFrom(t.evidence).map(
            (f) => `${f.claimType}: ${JSON.stringify(f).slice(0, 300)}`,
          ),
        ],
        cards: this.cardSummaries(t),
        live: t.live,
        language: t.lang,
        assistantName: await this.assistantName(t),
        tenantId: t.tenantId,
      });
      if (res.status === 'composed' || res.status === 'repaired') {
        reply = stripFiller(res.text);
        segments = [reply];
        t.languageModel = res.status;
      } else if (res.status === 'fallback' && res.reasons[0] !== 'no_model') {
        t.languageModel = 'discarded';
        t.fallbackReason = res.reasons.join(',');
      }
    }
    if (ack) st.recentOpeners = [...st.recentOpeners, ack].slice(-4);
    st.lastReplySig = signature(reply);
    // A question that lives inside the reply text ("Want to adjust the down payment or term?")
    // is still what a following "yes" answers.
    if (!st.lastOffer || st.lastOffer.kind === 'other') {
      const asked = reply
        .split(/(?<=[.!?])\s+/)
        .reverse()
        .find((x) => /\?\s*$/.test(x));
      if (asked) {
        const kind = offerFor({ key: 'none', text: asked, priority: 9 });
        if (kind !== 'other' || !st.lastOffer)
          st.lastOffer = {
            kind,
            text: asked,
            vin: st.selectedVin,
            department: st.department ?? null,
            turn: st.turnCount + 1,
          };
      }
    }
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
      languageModel: t.languageModel,
      modelInterpreted: t.modelInterpreted,
      fallbackReason: t.fallbackReason,
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
