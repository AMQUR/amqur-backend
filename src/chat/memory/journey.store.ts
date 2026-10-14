import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { PendingQuestion } from '../understanding/turn-understanding';
import type { LeadSignal } from '../../leads/lead-scoring';

export type Department = 'sales' | 'service' | 'parts' | 'finance';

export type JourneyState = {
  v: 2;
  language?: 'en' | 'es';
  languageLocked?: boolean;
  department?: Department | null;
  pending?: PendingQuestion;
  criteria: {
    make?: string;
    model?: string;
    year?: number;
    yearMin?: number;
    maxPrice?: number;
    maxMileage?: number;
    color?: string;
    bodyType?: string;
    drivetrain?: string;
    condition?: 'new' | 'used' | 'certified';
    fuel?: 'electric' | 'hybrid' | 'gas' | 'diesel';
    features?: string[];
  };
  visibleVins: string[];
  selectedVin?: string;
  /** Human label for the selected vehicle (e.g. "black 2024 Jeep Wrangler Sport S") */
  selectedLabel?: string;
  compareVins: string[];
  savedVins: string[];
  payment: {
    maxMonthly?: number;
    downPayment?: number;
    termMonths?: number;
    customerApr?: number;
    leaseOrPurchase?: 'lease' | 'purchase';
    lastEstimate?: {
      vin: string;
      monthly: number;
      apr: number;
      aprSource: string;
      termMonths: number;
      downPayment: number;
      tradeEquity: number;
      includesTaxAndFees: boolean;
      policyVersion: string;
    };
  };
  trade?: {
    requestId?: string;
    year?: number;
    make?: string;
    model?: string;
    mileage?: number;
    payoff?: number;
  };
  contact: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    preferredContact?: 'phone' | 'email' | 'sms';
    consentToText?: boolean;
  };
  leadId?: string;
  appointment?: {
    id: string;
    type: string;
    status: string;
    requestedDate?: string | null;
    requestedTime?: string | null;
    outcome: string;
  };
  /** appointment being collected (missing date/time) */
  draftAppointment?: {
    type: 'SALES' | 'TEST_DRIVE' | 'SERVICE' | 'PARTS' | 'FINANCE';
    serviceNeed?: string;
    note?: string;
  };
  service?: { need?: string; vin?: string; amenityAsked?: string };
  parts?: {
    inquiryId?: string;
    need?: string;
    vin?: string;
    partNumber?: string;
    vehicle?: { year?: number; make?: string; model?: string };
  };
  finance?: { requestId?: string; creditLinkOffered?: boolean };
  handoff?: { escalationId?: string; notified?: boolean; queued?: boolean };
  /** customer questions we could not answer yet — resolved before pushing a CTA */
  openQuestions: string[];
  recentOpeners: string[];
  lastReplySig?: string;
  /** last follow-up question asked (key + turn number) — used to avoid nagging */
  lastAsked?: { key: PendingQuestion; turn: number };
  turnCount: number;
  signals: LeadSignal[];
  attribution?: {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    referrerClass?: string;
    pageType?: string;
    landingVin?: string;
  };
  timeline?: string;
};

export function emptyJourney(): JourneyState {
  return {
    v: 2,
    criteria: {},
    visibleVins: [],
    compareVins: [],
    savedVins: [],
    payment: {},
    contact: {},
    openQuestions: [],
    recentOpeners: [],
    turnCount: 0,
    signals: [],
  };
}

/** Upgrade legacy (v1 ConversationInventoryState) rows without losing customer context. */
export function upgradeState(raw: unknown): JourneyState {
  const base = emptyJourney();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  if (r.v === 2) {
    return {
      ...base,
      ...(r as Partial<JourneyState>),
      criteria: { ...(r.criteria as object) },
      payment: { ...(r.payment as object) },
      contact: { ...(r.contact as object) },
    } as JourneyState;
  }
  const lead = (r.lead ?? {}) as Record<string, unknown>;
  return {
    ...base,
    selectedVin: typeof r.selectedVin === 'string' ? r.selectedVin : undefined,
    visibleVins: Array.isArray(r.visibleVins)
      ? (r.visibleVins as string[])
      : [],
    compareVins: Array.isArray(r.compareVins)
      ? (r.compareVins as string[])
      : [],
    criteria: {
      year: typeof r.year === 'number' ? r.year : undefined,
      maxPrice: typeof r.maxPrice === 'number' ? r.maxPrice : undefined,
      color: typeof r.color === 'string' ? r.color : undefined,
      bodyType: typeof r.bodyType === 'string' ? r.bodyType : undefined,
      drivetrain: typeof r.drivetrain === 'string' ? r.drivetrain : undefined,
    },
    payment: {
      maxMonthly:
        typeof r.maxMonthlyPayment === 'number'
          ? r.maxMonthlyPayment
          : undefined,
      downPayment:
        typeof r.downPayment === 'number' ? r.downPayment : undefined,
      termMonths: typeof r.termMonths === 'number' ? r.termMonths : undefined,
    },
    contact: {
      firstName:
        typeof lead.firstName === 'string' ? lead.firstName : undefined,
      lastName: typeof lead.lastName === 'string' ? lead.lastName : undefined,
      phone: typeof lead.phone === 'string' ? lead.phone : undefined,
      email: typeof lead.email === 'string' ? lead.email : undefined,
    },
    language: r.language === 'es' ? 'es' : undefined,
    turnCount:
      typeof r.conversationTurnCount === 'number' ? r.conversationTurnCount : 0,
  };
}

export type TurnSession = {
  conversationId: string;
  externalKey: string;
  tenantId: string;
  locationId: string | null;
  state: JourneyState;
  version: number;
  aiPaused: boolean;
  handoffState: string;
  isNew: boolean;
};

/**
 * PostgreSQL is the source of truth for conversation state. Every turn loads fresh state
 * (correct across API replicas) and saves with optimistic concurrency on `stateVersion`.
 * Message writes are awaited and throw — a failed write must never be acknowledged.
 */
@Injectable()
export class JourneyStore {
  private readonly logger = new Logger(JourneyStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async load(
    tenantId: string,
    locationId: string | null | undefined,
    externalKey: string,
  ): Promise<TurnSession> {
    let row = await this.prisma.conversation.findUnique({
      where: { tenantId_externalKey: { tenantId, externalKey } },
    });
    let isNew = false;
    if (!row) {
      try {
        row = await this.prisma.conversation.create({
          data: {
            tenantId,
            locationId: locationId ?? null,
            externalKey,
            channel: 'WIDGET',
            state: emptyJourney() as unknown as Prisma.InputJsonValue,
          },
        });
        isNew = true;
      } catch (e: unknown) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          row = await this.prisma.conversation.findUniqueOrThrow({
            where: { tenantId_externalKey: { tenantId, externalKey } },
          });
        } else throw e;
      }
    }
    return {
      conversationId: row.id,
      externalKey,
      tenantId,
      locationId: row.locationId ?? locationId ?? null,
      state: upgradeState(row.state),
      version: row.stateVersion,
      aiPaused: row.aiPaused,
      handoffState: row.handoffState,
      isNew,
    };
  }

  /** Persist state; on a concurrent write from another replica, merge and retry once. */
  async save(
    s: TurnSession,
    extra: Prisma.ConversationUpdateManyMutationInput = {},
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await this.prisma.conversation.updateMany({
        where: { id: s.conversationId, stateVersion: s.version },
        data: {
          ...extra,
          state: s.state as unknown as Prisma.InputJsonValue,
          stateVersion: { increment: 1 },
          lastActivityAt: new Date(),
          language: s.state.language ?? undefined,
        },
      });
      if (res.count === 1) {
        s.version += 1;
        return;
      }
      const fresh = await this.prisma.conversation.findUniqueOrThrow({
        where: { id: s.conversationId },
      });
      const theirs = upgradeState(fresh.state);
      // Merge: our turn's values win, but keep durable ids/signals the other writer added.
      s.state = {
        ...theirs,
        ...s.state,
        signals: [...new Set([...theirs.signals, ...s.state.signals])],
        savedVins: [...new Set([...theirs.savedVins, ...s.state.savedVins])],
        leadId: s.state.leadId ?? theirs.leadId,
      };
      s.version = fresh.stateVersion;
      s.aiPaused = fresh.aiPaused;
      this.logger.warn(
        `conversation ${s.conversationId} concurrent update — merged (attempt ${attempt + 1})`,
      );
    }
    throw new Error('conversation_state_conflict');
  }

  async appendMessage(
    s: Pick<TurnSession, 'conversationId'>,
    role: 'USER' | 'ASSISTANT' | 'SYSTEM',
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.prisma.message.create({
      data: {
        conversationId: s.conversationId,
        role,
        content: content.slice(0, 20_000),
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async recentMessages(conversationId: string, take = 12) {
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { role: true, content: true, createdAt: true },
    });
    return rows.reverse();
  }
}
