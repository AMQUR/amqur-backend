import { dealerDirectoryFor } from '../dealer-directory/dealer-directory';
import { isRecallQuestion } from '../chat/conversation/recall';
import { CapabilityService } from '../capability/capability.service';
import { OpenConversationService } from '../chat/conversation/open-conversation.service';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ChatResponse } from '../chat/chat.orchestrator';
import {
  JourneyState,
  JourneyStore,
  TurnSession,
} from '../chat/memory/journey.store';
import type { InventoryVehicle } from '../chat/types/vehicle.types';
import {
  TurnUnderstanding,
  understandTurn,
} from '../chat/understanding/turn-understanding';
import { redactCreditSensitive } from '../common/security/sensitive-data';
import { referenceNow } from '../common/time/reference-now';
import { MetricsService } from '../observability/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { decideDisambiguation, searchableMembers } from './disambiguation';
import * as copy from './group-copy';
import {
  GroupInventoryService,
  OwnedVehicleRow,
} from './group-inventory.service';
import { GroupMembershipService } from './group-membership.service';
import type { GroupScope } from './group-read-scope';
import type {
  GroupGrant,
  GroupMember,
  GroupRoutingState,
  Lang,
  ShownVehicle,
} from './group-routing.types';
import { memberOf } from './membership';
import {
  resolveOwner,
  resolveShownReference,
  switchDecision,
} from './ownership';
import {
  groupRoutingKey,
  ownerConversationKey,
  signRooftopRef,
  verifyRooftopRef,
} from './rooftop-ref';
import { decideRoute, effectiveIntents } from './route-decision';
import {
  parseStoreChoice,
  preferenceFor,
  StoreChoice,
  storesMentioned,
} from './store-choice';

export type GroupChatInput = {
  message: string;
  action?: string;
  vin?: string;
  language?: string;
  pageContext?: object;
  lead?: unknown;
  appointment?: unknown;
  onStatus?: unknown;
  onTextDelta?: unknown;
  signal?: unknown;
  /** Opaque rooftop reference echoed by the widget (group site only). */
  rooftopRef?: string;
  tenantId: string;
  locationId?: string | null;
  userId: string;
  role: string;
};

/** What the engine accepts: the request plus the two router-only directives. */
type EngineInput = Omit<GroupChatInput, 'rooftopRef'> & {
  pinnedVin?: string;
  resumeSearch?: boolean;
  /**
   * The visitor's group-site conversation, readable by the rooftop turn it handed off to, so
   * what was said before a store was chosen is not lost. One direction only: a rooftop's
   * conversation is never linked into another tenant's turn (not the group site's, and not
   * another rooftop's after a switch).
   */
  linkedConversationIds?: string[];
  /** Tenants those linked conversations may belong to (checked again at read time). */
  linkedTenantIds?: string[];
};
type Engine = (input: EngineInput) => Promise<ChatResponse>;

const PHONE_RE = /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const STAFF_RE =
  /\b(staff|team|person|someone|human|transfer|ask|equipo|persona|alguien|traslado|pregunt\w*)\b/i;
const VISIT_RE =
  /\b(yes|yeah|sure|ok|okay|visit|book|schedule|test drive|s[ií]|claro|visitar|agendar|cita)\b/i;
/** A 17-character VIN-shaped token (letters and digits mixed), including demo VINs. */
function typedVinIn(message: string): string | undefined {
  return (message.match(/\b[A-Za-z0-9]{17}\b/g) ?? []).find(
    (t) => /\d/.test(t) && /[A-Za-z]/.test(t),
  );
}

const WITHHELD_MARKER = '[contact details not stored — no store chosen yet]';

type Ctx = {
  grant: GroupGrant;
  input: GroupChatInput;
  engine: Engine;
  key: Buffer;
  lang: Lang;
  /** The GROUP conversation (in the group site's tenant). */
  group: TurnSession;
  gr: GroupRoutingState;
  bound: GroupMember | null;
  /** The bound rooftop's conversation, when there is one. */
  owner: TurnSession | null;
  u: TurnUnderstanding;
};

/**
 * Group-site rooftop routing (docs/CHAT_STREAM_CONTRACT.md §6).
 *
 * Sits in front of the chat engine. For every tenant that is not a designated, enabled group
 * site it is a pass-through. For a group site it decides, per turn, who answers:
 *
 *  - the GROUP conversation (group tenant): cross-rooftop search and general chat only. It can
 *    never create a lead, consent record, appointment or handoff;
 *  - a ROOFTOP conversation in the owning rooftop's own tenant: everything about a chosen
 *    vehicle or store. The unmodified engine runs there, so the lead, its consent, the
 *    appointment, its provider receipt and the ADF delivery are created in — and routed by —
 *    that tenant exactly as if the customer had been on that rooftop's own site.
 */
@Injectable()
export class GroupRoutingService {
  private readonly logger = new Logger(GroupRoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: JourneyStore,
    private readonly membership: GroupMembershipService,
    private readonly inventory: GroupInventoryService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly conversation: OpenConversationService,
    private readonly capabilities: CapabilityService,
  ) {}

  private routingKey(): Buffer {
    const dedicated = this.config.get<string>('CONVERSATION_ID_SECRET')?.trim();
    return groupRoutingKey(
      dedicated && dedicated.length >= 32
        ? dedicated
        : (this.config.get<string>('JWT_SECRET') ?? ''),
    );
  }

  async handle(input: GroupChatInput, engine: Engine): Promise<ChatResponse> {
    const { rooftopRef: _ref, ...plain } = input;
    void _ref;
    // Only anonymous widget traffic on a designated, enabled group site is routed.
    if (input.role !== 'widget') return engine(plain);
    const grant = await this.membership.resolve(
      input.tenantId,
      input.locationId,
    );
    if (!grant) return engine(plain);
    this.metrics.increment('group_routing.turns');
    return this.route(grant, input, engine);
  }

  // ───────────────────────────────────────── the turn

  private async route(
    grant: GroupGrant,
    input: GroupChatInput,
    engine: Engine,
  ): Promise<ChatResponse> {
    const key = this.routingKey();
    const group = await this.store.load(
      grant.groupSiteTenantId,
      input.locationId,
      input.userId,
    );
    const gr: GroupRoutingState = { v: 1, ...(group.state.groupRouting ?? {}) };
    const bound = memberOf(grant, gr.bound?.tenantId);
    if (gr.bound && !bound) gr.bound = undefined; // rooftop no longer listed
    const owner = bound
      ? await this.ownerSession(grant, key, group, bound)
      : null;
    const surface = owner?.state ?? group.state;
    const lang: Lang =
      input.language === 'es' || input.language === 'en'
        ? input.language
        : (gr.lang ?? surface.language ?? group.state.language ?? 'en');
    const message =
      input.lead || input.appointment ? '' : (input.message ?? '');
    const u = this.understand(message, surface);
    const c: Ctx = {
      grant,
      input,
      engine,
      key,
      lang:
        !surface.languageLocked && u.entities.language
          ? u.entities.language
          : lang,
      group,
      gr,
      bound,
      owner,
      u,
    };

    // Staff took over the group conversation: the engine's own staff handling answers.
    if (group.aiPaused) return this.runGroup(c);

    if (input.lead || input.appointment)
      return bound ? this.delegate(c, bound) : this.runGroup(c);

    // No rooftop has a connected lead or booking tool: a request for a person, a callback or
    // typed contact details cannot be delivered anywhere, so there is no point asking "which
    // store?" first. The engine answers with the stores' own contact routes and stores no
    // contact detail. Safety reports and complaints keep the rules below.
    if (
      message &&
      !input.action &&
      !input.vin &&
      !gr.pending &&
      !u.entities.incident &&
      this.conversation.directoryMode() !== 'off' &&
      (this.conversation.directoryMode() === 'force' ||
        grant.members.every((m) => m.locationIds.length === 0)) &&
      dealerDirectoryFor(grant.groupSlug)
    ) {
      const early = effectiveIntents(u.intents, undefined);
      if (
        !early.includes('SAFETY_URGENT') &&
        !early.includes('COMPLAINT') &&
        (early.includes('HUMAN_HANDOFF') ||
          early.includes('PROVIDE_CONTACT') ||
          PHONE_RE.test(message) ||
          EMAIL_RE.test(message))
      ) {
        this.metrics.increment('group_routing.direct_contact');
        return bound ? this.delegate(c, bound) : this.runGroup(c);
      }
    }

    // General conversation on the group site (a question, math, advice, writing) needs no
    // rooftop. When the keyword rules read it as rooftop work, the lane router gets the last
    // word before anyone is asked "which store?". Never applies to a button action, a VIN, a
    // pending store question, an answer a rooftop is waiting on, or a message with contact
    // details — those keep the rules below.
    if (
      message &&
      !input.action &&
      !input.vin &&
      !input.rooftopRef &&
      !gr.pending &&
      !(owner && (owner.state.pending ?? 'none') !== 'none') &&
      !u.entities.vin &&
      // "in stock today" is not a stock number; a real one carries a digit
      !(u.entities.stock && /\d/.test(u.entities.stock)) &&
      !u.entities.contact?.phone &&
      !u.entities.contact?.email &&
      this.conversation.isEnabled() &&
      // The per-tenant model kill switch covers the router call too: nothing is sent to a
      // model for the group site, or for the bound rooftop, when either has it off.
      !(await this.capabilities.flags(input.tenantId, input.locationId))
        .llmDisabled &&
      !(
        bound &&
        owner &&
        (await this.capabilities.flags(bound.tenantId, owner.locationId))
          .llmDisabled
      )
    ) {
      const ruleIntents = effectiveIntents(u.intents, undefined);
      // No member rooftop has a listed inventory feed: there is nothing to search and no
      // store to ask about first. A shopping, service, finance or trade request is answered
      // in conversation with the verified store links instead. Requests for a person,
      // complaints, safety reports and contact details keep the rules below.
      const keepsRules = new Set([
        'HUMAN_HANDOFF',
        'COMPLAINT',
        'SAFETY_URGENT',
        'PROVIDE_CONTACT',
        'APPOINTMENT_CANCEL',
        'APPOINTMENT_RESCHEDULE',
        'AFFIRM',
        'DECLINE',
      ]);
      if (
        this.conversation.directoryMode() !== 'off' &&
        (this.conversation.directoryMode() === 'force' ||
          grant.members.every((m) => m.locationIds.length === 0)) &&
        dealerDirectoryFor(grant.groupSlug) &&
        !u.entities.incident &&
        !ruleIntents.some((i) => keepsRules.has(i))
      ) {
        this.metrics.increment('group_routing.directory_lane');
        return bound ? this.delegate(c, bound) : this.runGroup(c);
      }
      const conversational = new Set([
        'UNKNOWN',
        'KNOWLEDGE_QUESTION',
        'SMALL_TALK',
        'GREETING',
        'LANGUAGE_SWITCH',
      ]);
      // A complaint or a request for a person keeps the rules; a safety keyword does not,
      // because the first thing a driver needs is advice, not "which store?".
      const urgent = new Set(['HUMAN_HANDOFF']);
      if (
        !ruleIntents.every((i) => conversational.has(i)) &&
        !ruleIntents.some((i) => urgent.has(i))
      ) {
        const recent = await this.store
          .recentMessages((owner ?? group).conversationId, 6)
          .catch(() => [] as Array<{ role: string; content: string }>);
        // A question about what the customer said earlier needs no verdict and no store.
        const lane = isRecallQuestion(message)
          ? 'conversation'
          : await this.conversation.classifyLane({
              message,
              recent,
              pending: null,
              ruleIntents,
              tenantId: input.tenantId,
              inventoryTool: false,
              groupSite: !bound,
            });
        if (lane === 'conversation') {
          this.metrics.increment('group_routing.conversation_lane');
          return bound ? this.delegate(c, bound) : this.runGroup(c);
        }
      }
    }

    // 1. A rooftop reference the client echoed must verify — otherwise nothing happens.
    let claimed: string | null = null;
    if (input.rooftopRef) {
      claimed = verifyRooftopRef(
        key,
        {
          dealerGroupId: grant.dealerGroupId,
          conversationKey: input.userId,
          nowMs: Date.now(),
          memberTenantIds: grant.members.map((m) => m.tenantId),
        },
        input.rooftopRef,
      );
      if (!claimed) {
        this.metrics.increment('group_routing.refused.reference');
        return this.say(c, copy.referenceNotVerified(c.lang));
      }
    }

    const intents = effectiveIntents(u.intents, input.action);
    const expecting =
      gr.pending?.kind === 'search_store' ||
      gr.pending?.kind === 'request_store';
    const choice = parseStoreChoice(message, grant.members, {
      expectingStore: expecting,
    });
    const ownerAwaiting = !!owner && (owner.state.pending ?? 'none') !== 'none';

    // 2. A vehicle named by VIN / stock number: ownership follows the vehicle.
    const typedVin = (u.entities.vin ?? typedVinIn(message))?.toUpperCase();
    const vin = input.vin?.toUpperCase() ?? typedVin;
    const ownVehicleContext =
      !input.vin &&
      (ownerAwaiting ||
        intents.includes('PARTS_INQUIRY') ||
        intents.includes('SERVICE_APPOINTMENT'));
    if ((vin || u.entities.stock) && !ownVehicleContext) {
      const rows = await this.inventory.owners(
        grant,
        vin ? { vins: [vin] } : { stock: u.entities.stock },
      );
      const res = resolveOwner(grant, rows, claimed);
      if (res.kind === 'ref_mismatch') {
        this.metrics.increment('group_routing.refused.reference');
        return this.say(c, copy.referenceNotVerified(c.lang));
      }
      if (res.kind === 'not_found') {
        this.metrics.increment('group_routing.refused.vehicle');
        // Typed mid-conversation with a rooftop: that rooftop's own engine answers honestly.
        if (bound && !input.vin && !claimed) return this.delegate(c, bound);
        return this.say(c, copy.vinNotInGroup(c.lang));
      }
      if (res.kind === 'conflict') {
        gr.pending = {
          kind: 'request_store',
          replay: {
            message: redactCreditSensitive(message),
            action: input.action,
            vin,
          },
        };
        const ask = copy.vinAtSeveralStores(res.members, c.lang);
        return this.say(c, ask.text, ask.quickReplies);
      }
      const row = rows.find((r) => r.tenantId === res.member.tenantId)!;
      const elsewhere = claimed
        ? undefined
        : storesMentioned(message, grant.members).find(
            (id) => id !== res.member.tenantId,
          );
      if (elsewhere) {
        // "Book me at the South store for this North VIN" — nothing moves.
        const asked = memberOf(grant, elsewhere)!;
        gr.pending = {
          kind: 'owner_offer',
          vin: row.vin,
          tenantId: res.member.tenantId,
        };
        const ans = copy.vehicleAtOtherStore(row, res.member, asked, c.lang);
        return this.say(c, ans.text, ans.quickReplies);
      }
      return this.delegate(c, res.member, { vin: row.vin, pinned: true });
    }

    // 3. Answer to "visit the owning store, or ask its team?"
    if (gr.pending?.kind === 'owner_offer') {
      const offer = gr.pending;
      const m = memberOf(grant, offer.tenantId);
      gr.pending = undefined;
      const namesOwner =
        choice?.kind === 'store' && choice.tenantId === offer.tenantId;
      if (m && STAFF_RE.test(message) && !namesOwner)
        return this.delegate(c, m, {
          vin: offer.vin,
          pinned: true,
          action: 'human',
          message: '',
        });
      if (m && (namesOwner || VISIT_RE.test(message)))
        return this.delegate(c, m, {
          vin: offer.vin,
          pinned: true,
          action: 'test_drive',
          message: '',
        });
    }

    // 4. A store the customer named (or a verified reference with no vehicle).
    const named: StoreChoice | null = claimed
      ? { kind: 'store', tenantId: claimed, by: 'name' }
      : choice;
    const explicitSearch =
      intents.includes('INVENTORY_SEARCH') ||
      intents.includes('SHOPPING_START');
    const carriesContact =
      !!u.entities.contact?.phone ||
      !!u.entities.contact?.email ||
      PHONE_RE.test(message) ||
      EMAIL_RE.test(message);

    if (gr.pending?.kind === 'request_store') {
      const pend = gr.pending;
      if (named?.kind === 'store') {
        const m = memberOf(grant, named.tenantId)!;
        gr.pending = undefined;
        if (pend.replay)
          return this.delegate(c, m, {
            message: pend.replay.message,
            action: pend.replay.action,
            vin: pend.replay.vin,
            pinned: !!pend.replay.vin,
          });
        return this.bindAndSay(c, m, copy.resendContactNote(m, c.lang));
      }
      if (named?.kind === 'ambiguous') {
        const ask = copy.whichSideAsk(
          this.members(grant, named.tenantIds),
          c.lang,
        );
        return this.say(c, ask.text, ask.quickReplies);
      }
      if (
        !explicitSearch &&
        !carriesContact &&
        intents.every((i) => i === 'UNKNOWN')
      ) {
        const ask = copy.requestStoreAsk(grant.members, c.lang);
        return this.say(c, ask.text, ask.quickReplies);
      }
      gr.pending = undefined;
    } else if (named && !carriesContact) {
      const offered =
        gr.pending?.kind === 'search_store' ? gr.pending.options : null;
      const hasCriteria = !!(
        group.state.criteria?.make || group.state.criteria?.model
      );
      const needsRooftop = !explicitSearch && this.needsRooftop(intents);
      if (named.kind === 'ambiguous') {
        const opts = this.members(grant, named.tenantIds);
        const ask = copy.whichSideAsk(opts, c.lang);
        gr.pending =
          offered || explicitSearch || (!needsRooftop && hasCriteria)
            ? { kind: 'search_store', options: named.tenantIds }
            : {
                kind: 'request_store',
                replay: {
                  message: redactCreditSensitive(message),
                  action: input.action,
                },
              };
        return this.say(c, ask.text, ask.quickReplies);
      }
      const pref = preferenceFor(named, grant.members, offered);
      if (offered || explicitSearch) {
        if (pref) gr.prefer = pref;
        gr.pending = undefined;
        // Answering the question re-runs the search they asked for; a new search runs as is.
        return this.runGroup(c, { resume: !explicitSearch });
      }
      if (named.kind === 'store') {
        const m = memberOf(grant, named.tenantId)!;
        if (needsRooftop) return this.delegate(c, m);
        if (pref) gr.prefer = pref;
        if (hasCriteria) return this.runGroup(c, { resume: true });
        return this.bindAndSay(
          c,
          m,
          `${copy.nowWithStore(m, c.lang)} ${c.lang === 'es' ? '¿En qué le puedo ayudar ahí?' : 'What can I help you with there?'}`,
        );
      }
      if (named.kind === 'either' && hasCriteria && !needsRooftop) {
        gr.prefer = pref ?? gr.prefer;
        return this.runGroup(c, { resume: true });
      }
    }

    // 5. Everything else: who answers?
    const shown = gr.shown ?? [];
    const groupList = gr.listSurface === 'group' && shown.length > 0;
    const ref = groupList
      ? resolveShownReference(message, shown, grant, u.entities.vehicle)
      : ({ kind: 'none' } as const);
    const decision = decideRoute({
      intents,
      structured: false,
      carriesContact,
      bound: !!bound,
      ownerAwaitingAnswer: ownerAwaiting,
      listSurface: gr.listSurface,
      lastSurface: gr.lastSurface,
      hasShown: shown.length > 0,
      reference: ref.kind,
      safety: intents.includes('SAFETY_URGENT') || !!u.entities.incident,
      groupQueue: grant.handoffQueue,
    });
    switch (decision.to) {
      case 'group':
        return this.runGroup(c);
      case 'owner':
        return this.delegate(c, bound!);
      case 'owner_of_reference': {
        const v = (ref as { vehicle: ShownVehicle }).vehicle;
        const m = memberOf(grant, v.tenantId);
        if (!m) return this.say(c, copy.vinNotInGroup(c.lang));
        return this.delegate(c, m, { vin: v.vin, pinned: true });
      }
      case 'ask_vehicle': {
        gr.pending = { kind: 'which_vehicle' };
        const ask = copy.whichVehicleAsk(
          ref.kind === 'ambiguous' ? ref.vehicles : shown,
          (id) => {
            const m = memberOf(grant, id);
            return m ? copy.rooftopLabel(m, c.lang) : '';
          },
          c.lang,
        );
        return this.say(c, ask.text, ask.quickReplies);
      }
      default: {
        gr.pending = {
          kind: 'request_store',
          ...(carriesContact
            ? {}
            : {
                replay: {
                  message: redactCreditSensitive(message),
                  action: input.action,
                },
              }),
        };
        const ask = copy.requestStoreAsk(grant.members, c.lang, {
          contactWithheld: carriesContact,
        });
        return this.say(c, ask.text, ask.quickReplies, {
          withholdUserText: carriesContact,
        });
      }
    }
  }

  // ───────────────────────────────────────── helpers

  private members(grant: GroupGrant, ids: readonly string[]): GroupMember[] {
    return ids
      .map((id) => memberOf(grant, id))
      .filter((m): m is GroupMember => !!m);
  }

  private needsRooftop(intents: string[]): boolean {
    return (
      decideRoute({
        intents: intents as never,
        structured: false,
        carriesContact: false,
        bound: false,
        ownerAwaitingAnswer: false,
        listSurface: undefined,
        lastSurface: undefined,
        hasShown: false,
        reference: 'none',
        safety: false,
        groupQueue: false,
      }).to === 'ask_store'
    );
  }

  private understand(message: string, st: JourneyState): TurnUnderstanding {
    return understandTurn(message, {
      pending: st.pending,
      hasVisibleVehicles: st.visibleVins.length > 0,
      hasSelectedVehicle: !!st.selectedVin,
      hasActiveAppointment:
        !!st.appointment &&
        ['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(
          st.appointment.status,
        ),
      activeDepartment: st.department ?? null,
      now: referenceNow(),
      timeZone: 'America/Chicago',
      knownModels: st.visibleModels ?? [],
      knownTrims: st.visibleTrims ?? [],
      hasPaymentEstimate: !!st.payment.lastEstimate,
      hasCriteria: Object.keys(st.criteria ?? {}).length > 0,
      creditOffered: !!st.finance?.creditLinkOffered,
      incidentActive: !!st.incident && !st.incident.safeNow,
      incidentSeverity: st.incident?.severity,
      tradeOpen: !!st.trade || st.pending === 'trade_vehicle',
    });
  }

  private ownerKey(
    grant: GroupGrant,
    key: Buffer,
    group: TurnSession,
    m: GroupMember,
  ) {
    return ownerConversationKey(key, {
      groupSiteTenantId: grant.groupSiteTenantId,
      groupConversationKey: group.externalKey,
      ownerTenantId: m.tenantId,
    });
  }

  private ownerSession(
    grant: GroupGrant,
    key: Buffer,
    group: TurnSession,
    m: GroupMember,
  ) {
    return this.store.load(
      m.tenantId,
      m.primaryLocationId,
      this.ownerKey(grant, key, group, m),
    );
  }

  private ref(c: Ctx, tenantId: string): string {
    return signRooftopRef(c.key, {
      dealerGroupId: c.grant.dealerGroupId,
      tenantId,
      conversationKey: c.input.userId,
      nowMs: Date.now(),
    });
  }

  private label<T extends InventoryVehicle>(c: Ctx, v: T, m: GroupMember): T {
    return {
      ...v,
      rooftopName: copy.rooftopLabel(m, c.lang),
      rooftopRef: this.ref(c, m.tenantId),
    };
  }

  private async saveGroup(c: Ctx, session: TurnSession = c.group) {
    session.state.groupRouting = c.gr;
    await this.store.save(session);
  }

  private async audit(
    tenantId: string,
    action: string,
    resource: string,
    resourceId: string,
    grant: GroupGrant,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action,
        resource,
        resourceId,
        metadata: {
          origin: 'group_site',
          dealerGroupId: grant.dealerGroupId,
          groupSiteTenantId: grant.groupSiteTenantId,
        },
      },
    });
  }

  // ───────────────────────────────────────── a reply from the router itself

  private response(c: Ctx, text: string, quickReplies: string[]): ChatResponse {
    return {
      reply: text,
      segments: [text],
      cards: [],
      quickReplies,
      journey: {},
      provenance: {
        sources: [],
        verifiedFactsOnly: true,
        languageModel: 'none',
      },
      evidence: [],
      conversation: {
        language: c.lang,
        handoffState: c.group.handoffState,
        aiPaused: false,
        pending: 'none',
      },
      delivery: {
        urgent: false,
        toolCount: 0,
        minTypingMs: 400,
        maxTypingMs: 1200,
      },
    };
  }

  /** Answer in the GROUP conversation without running the engine. Creates no record. */
  private async say(
    c: Ctx,
    text: string,
    quickReplies: string[] = [],
    opts: { withholdUserText?: boolean } = {},
  ): Promise<ChatResponse> {
    await this.store.appendMessage(
      c.group,
      'USER',
      opts.withholdUserText
        ? WITHHELD_MARKER
        : redactCreditSensitive((c.input.message ?? '').trim()),
      c.input.action ? { action: c.input.action } : undefined,
    );
    c.gr.lastSurface = 'group';
    c.gr.lang = c.lang;
    c.group.state.language = c.lang;
    c.group.state.turnCount += 1;
    await this.saveGroup(c);
    await this.store.appendMessage(c.group, 'ASSISTANT', text, {
      type: 'reply',
      groupRouting: true,
      language: c.lang,
    });
    return this.response(c, text, quickReplies);
  }

  /** Bind to a rooftop the customer chose, and say so — no engine turn, no record. */
  private async bindAndSay(c: Ctx, m: GroupMember, text: string) {
    await this.bind(c, m);
    return this.say(c, text);
  }

  // ───────────────────────────────────────── the group conversation (search + chat)

  private async runGroup(
    c: Ctx,
    opts: { resume?: boolean } = {},
  ): Promise<ChatResponse> {
    const { grant, gr } = c;
    await this.saveGroup(c);
    const scope: GroupScope = {
      grant,
      searchable: searchableMembers(grant.members, gr),
      lang: c.lang,
      outcome: { reads: 0 },
      beforeSearch: async (criteria) => {
        const { counts, sampleModel } = await this.inventory.matchesByRooftop(
          grant,
          scope.searchable,
          criteria as never,
        );
        const d = decideDisambiguation({
          namedVehicle: !!(criteria.make || criteria.model),
          matchesByTenant: counts,
          members: grant.members,
          state: gr,
        });
        if (!d.ask) return null;
        scope.outcome.asked = d.ask;
        const make = typeof criteria.make === 'string' ? criteria.make : null;
        const what = criteria.model
          ? c.lang === 'es'
            ? `el ${sampleModel ?? String(criteria.model)}`
            : `the ${sampleModel ?? String(criteria.model)}`
          : make
            ? c.lang === 'es'
              ? `vehículos ${make}`
              : `${make} vehicles`
            : null;
        return copy.searchStoreAsk(
          this.members(grant, d.ask.options),
          d.ask.style,
          what,
          c.lang,
        );
      },
    };
    const { rooftopRef: _r, ...plain } = c.input;
    void _r;
    const res = await this.inventory.runScoped(scope, () =>
      c.engine({
        ...plain,
        language: plain.language ?? c.lang,
        ...(opts.resume ? { resumeSearch: true } : {}),
      }),
    );
    if (res.type === 'staff_handling') return res;

    const fresh = await this.store.load(
      grant.groupSiteTenantId,
      c.input.locationId,
      c.input.userId,
    );
    const st = fresh.state;
    const g2: GroupRoutingState = { ...gr, ...(st.groupRouting ?? {}), v: 1 };
    g2.prefer = gr.prefer;
    g2.bound = gr.bound;
    g2.lastSurface = 'group';
    g2.lang = res.conversation.language ?? c.lang;
    if (scope.outcome.asked) {
      g2.pending = {
        kind: 'search_store',
        options: scope.outcome.asked.options,
      };
      g2.asked = [
        ...new Set([...(g2.asked ?? []), scope.outcome.asked.signature]),
      ].slice(-12);
    } else g2.pending = undefined;

    let out = res;
    const vehicles = res.vehicles ?? [];
    if (vehicles.length) {
      const rows = await this.inventory.owners(grant, {
        vins: vehicles.map((v) => v.vin),
      });
      const ownerOf = (v: InventoryVehicle): OwnedVehicleRow | undefined =>
        rows.find(
          (r) => r.vin === v.vin && r.locationId === (v.locationId ?? null),
        ) ?? rows.find((r) => r.vin === v.vin);
      const labelled: InventoryVehicle[] = [];
      const shown: ShownVehicle[] = [];
      for (const v of vehicles) {
        const row = ownerOf(v);
        const m = memberOf(grant, row?.tenantId);
        if (!row || !m) continue; // never show a vehicle whose rooftop cannot be named
        labelled.push({
          ...this.label(c, v, m),
          // Facts that came from the GROUP tenant's own configuration say nothing here.
          vdpUrl: null,
          priceIncludesDealerFees: null,
        });
        shown.push({
          vin: v.vin,
          tenantId: m.tenantId,
          year: v.year,
          make: v.make,
          model: v.model,
          trim: v.trim,
          color: v.color,
          price: v.price,
        });
      }
      const stores = new Set(shown.map((s) => s.tenantId)).size;
      const note = stores > 1 ? copy.multiStoreNote(stores, c.lang) : null;
      out = {
        ...res,
        vehicles: labelled,
        ...(note
          ? { reply: `${res.reply} ${note}`, segments: [...res.segments, note] }
          : {}),
      };
      g2.shown = shown;
      g2.listSurface = 'group';
    }

    // The group conversation never keeps contact details or a lead of its own.
    if (!grant.handoffQueue) {
      st.contact = {};
      st.leadId = undefined;
    }
    // A single result is "selected" by the engine: hand that selection to its rooftop.
    if (st.selectedVin) {
      const sel = (g2.shown ?? []).find((s) => s.vin === st.selectedVin);
      const m = memberOf(grant, sel?.tenantId);
      if (m) {
        const session = await this.openOwner(c, m);
        session.state.selectedVin = st.selectedVin;
        session.state.selectedLabel = st.selectedLabel;
        session.state.selectedStock = st.selectedStock;
        session.state.selectedStatus = st.selectedStatus;
        session.state.visibleVins = [st.selectedVin];
        session.state.visibleModels = st.visibleModels;
        session.state.department = 'sales';
        session.state.language = st.language ?? c.lang;
        session.state.lastOffer = st.lastOffer
          ? { ...st.lastOffer, turn: session.state.turnCount }
          : undefined;
        await this.store.save(session);
        g2.bound = {
          tenantId: m.tenantId,
          locationId: m.primaryLocationId,
          at: new Date().toISOString(),
        };
        g2.linked = [...new Set([...(g2.linked ?? []), m.tenantId])];
        g2.lastSurface = 'owner';
      }
      st.selectedVin = undefined;
      st.selectedLabel = undefined;
      st.selectedStock = undefined;
      st.selectedStatus = undefined;
      st.lastOffer = undefined;
    }
    st.groupRouting = g2;
    await this.store.save(fresh);
    return out;
  }

  // ───────────────────────────────────────── a rooftop's own conversation

  /** Load (or open) the rooftop conversation and mark where it came from. */
  private async openOwner(c: Ctx, m: GroupMember): Promise<TurnSession> {
    const session = await this.ownerSession(c.grant, c.key, c.group, m);
    if (!session.state.groupOrigin) {
      session.state.groupOrigin = {
        v: 1,
        groupSlug: c.grant.groupSlug,
        groupName: c.grant.groupName,
      };
      session.state.language = session.state.language ?? c.lang;
      await this.store.save(session);
      await this.audit(
        m.tenantId,
        'group_site.rooftop_conversation_opened',
        'Conversation',
        session.conversationId,
        c.grant,
      );
    }
    return session;
  }

  private async bind(c: Ctx, m: GroupMember): Promise<TurnSession> {
    const session = await this.openOwner(c, m);
    const isNew = c.gr.bound?.tenantId !== m.tenantId;
    c.gr.bound = {
      tenantId: m.tenantId,
      locationId: m.primaryLocationId,
      at: isNew ? new Date().toISOString() : (c.gr.bound?.at ?? ''),
    };
    c.gr.linked = [...new Set([...(c.gr.linked ?? []), m.tenantId])];
    c.gr.pending = undefined;
    if (isNew) {
      this.metrics.increment('group_routing.bound');
      await this.store.appendMessage(
        c.group,
        'SYSTEM',
        `[continued with ${copy.rooftopLabel(m, 'en')}]`,
        { groupRouting: true },
      );
    }
    return session;
  }

  /** Run the turn in the owning rooftop's tenant with the unmodified engine. */
  private async delegate(
    c: Ctx,
    m: GroupMember,
    opts: {
      vin?: string;
      pinned?: boolean;
      action?: string;
      message?: string;
    } = {},
  ): Promise<ChatResponse> {
    const from = c.bound;
    const fromContact = c.owner?.state.contact;
    const sw = switchDecision({
      fromTenantId: from?.tenantId,
      toTenantId: m.tenantId,
      fromHasContact: !!(
        fromContact?.firstName &&
        (fromContact.phone || fromContact.email)
      ),
      alreadyLinkedTo: (c.gr.linked ?? []).includes(m.tenantId),
    });
    const session = await this.bind(c, m);
    if (opts.pinned && opts.vin) {
      // So the rooftop's engine reads "the second one" as a selection of THIS vehicle.
      session.state.visibleVins = [opts.vin];
      await this.store.save(session);
    }
    c.gr.lastSurface = 'owner';
    await this.saveGroup(c);

    const turnStart = new Date(Date.now() - 1000);
    const { rooftopRef: _r, ...plain } = c.input;
    void _r;
    const res = await c.engine({
      ...plain,
      linkedConversationIds: [c.group.conversationId],
      linkedTenantIds: [c.grant.groupSiteTenantId],
      message: opts.message ?? plain.message,
      action: opts.action ?? plain.action,
      vin: opts.vin ?? plain.vin,
      ...(opts.pinned && opts.vin ? { pinnedVin: opts.vin } : {}),
      language: plain.language ?? c.lang,
      tenantId: m.tenantId,
      locationId: m.primaryLocationId,
      userId: session.externalKey,
    });
    await this.recordCreated(c.grant, m, session, turnStart);
    if (res.type === 'staff_handling') return res;

    const name = copy.rooftopLabel(m, res.conversation.language ?? c.lang);
    const lc: Ctx = { ...c, lang: res.conversation.language ?? c.lang };
    let out: ChatResponse = {
      ...res,
      vehicles: res.vehicles?.map((v) => this.label(lc, v, m)),
      cards: res.cards.map((card) =>
        'rooftopName' in card && card.rooftopName
          ? { ...card, rooftopName: name }
          : card,
      ),
    };
    if (sw.notice && from) {
      const notice = copy.switchNotice(from, m, lc.lang);
      out = {
        ...out,
        reply: `${notice} ${out.reply}`,
        segments: [notice, ...out.segments],
      };
    }
    c.gr.lang = lc.lang;
    if ((res.vehicles?.length ?? 0) > 1) c.gr.listSurface = 'owner';
    const fresh = await this.store.load(
      c.grant.groupSiteTenantId,
      c.input.locationId,
      c.input.userId,
    );
    await this.saveGroup(c, fresh);
    return out;
  }

  /**
   * Trace every customer record this turn created in the rooftop's tenant (ids only, no
   * customer data), and tag appointments with where the request came from.
   */
  private async recordCreated(
    grant: GroupGrant,
    m: GroupMember,
    session: TurnSession,
    since: Date,
  ) {
    try {
      const where = { tenantId: m.tenantId, createdAt: { gte: since } };
      const [leads, appointments, consents] = await Promise.all([
        this.prisma.lead.findMany({
          where: { ...where, conversationId: session.conversationId },
          select: { id: true },
        }),
        this.prisma.appointment.findMany({
          where: { ...where, conversationId: session.conversationId },
          select: { id: true, provenance: true },
        }),
        this.prisma.consentRecord.findMany({
          where: { ...where, conversationExternalKey: session.externalKey },
          select: { id: true },
        }),
      ]);
      for (const l of leads)
        await this.audit(
          m.tenantId,
          'group_site.lead_created',
          'Lead',
          l.id,
          grant,
        );
      for (const k of consents)
        await this.audit(
          m.tenantId,
          'group_site.consent_recorded',
          'ConsentRecord',
          k.id,
          grant,
        );
      for (const a of appointments) {
        const prov =
          a.provenance &&
          typeof a.provenance === 'object' &&
          !Array.isArray(a.provenance)
            ? (a.provenance as Record<string, unknown>)
            : {};
        await this.prisma.appointment.updateMany({
          where: { id: a.id, tenantId: m.tenantId },
          data: {
            provenance: {
              ...prov,
              origin: 'group_site',
            } as Prisma.InputJsonValue,
          },
        });
        await this.audit(
          m.tenantId,
          'group_site.appointment_created',
          'Appointment',
          a.id,
          grant,
        );
      }
      if (leads.length || appointments.length)
        this.metrics.increment('group_routing.rooftop_record_created');
    } catch (e) {
      // The records exist and are correctly owned; only the trace failed.
      this.logger.error(
        `group-site audit trace failed: ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }
}
