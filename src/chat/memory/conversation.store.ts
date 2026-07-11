import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VinProfile } from '../vin/vin.types';
import { InventoryUpdate } from '../engines/inventory.extractor';
import { applyInventoryUpdate } from './inventory.merge';
import { PaymentPreferences } from '../payment/payment.types';

export type LeadState = {
  requested?: boolean;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  preferredContact?: 'phone' | 'email';
  consentToText?: boolean;
  completed?: boolean;
};

export type AppointmentState = {
  requested?: boolean;
  date?: string;
  time?: string;
  /** Preference captured — not a verified calendar booking */
  confirmed?: boolean;
};

export type ConversationInventoryState = {
  query?: string;
  year?: number;
  maxPrice?: number;
  maxMonthlyPayment?: number;
  downPayment?: number;
  termMonths?: number;
  apr?: number;
  lastEstimatedPayment?: number;
  visibleVins?: string[];
  selectedVin?: string;
  compareVins?: string[];
  color?: string;
  drivetrain?: string;
  bodyType?: string;
  sortBy?: 'price_asc' | 'price_desc';
  lead?: LeadState;
  appointment?: AppointmentState;
  leadScore?: number;
  leadStage?: 'cold' | 'warm' | 'hot';
  leadEvents?: string[];
  leadPrompted?: boolean;
  testDriveSuggested?: boolean;
  lastActivityAt?: number;
  inventorySalesGuideStep?: 'none' | 'asked_clarify' | 'ready';
  conversationTurnCount?: number;
  softLeadPromptShown?: boolean;
  awaitingSoftLeadYes?: boolean;
  softLeadCaptureActive?: boolean;
  buyingVisitPrompted?: boolean;
  activeFlowBucket?: 'sales' | 'service' | 'parts' | 'general';
  serviceFlowStep?:
    | null
    | 'intent_detected'
    | 'clarified'
    | 'scheduling'
    | 'capturing_info'
    | 'completed';
  lastAssistantReplySignature?: string;
  handoffRequested?: boolean;
  handoffEscalationId?: string;
};

type RequestContext = {
  tenantId: string;
  locationId?: string | null;
};

const CONVERSATION_TTL_MS = 4 * 60 * 60 * 1000;
const VIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EVICTION_INTERVAL_MS = 30 * 60 * 1000;

@Injectable()
export class ConversationStore implements OnModuleInit {
  private readonly logger = new Logger(ConversationStore.name);
  private readonly als = new AsyncLocalStorage<RequestContext>();
  private inventoryState = new Map<string, ConversationInventoryState>();
  private vinCache = new Map<
    string,
    { profile: VinProfile; cachedAt: number }
  >();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private hydrated = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.evictionTimer = setInterval(() => this.evict(), EVICTION_INTERVAL_MS);
    if (this.evictionTimer.unref) this.evictionTimer.unref();
  }

  /**
   * Bind tenant context for the duration of a chat turn (safe under concurrency).
   */
  async runWithContext<T>(
    ctx: RequestContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.als.run(ctx, fn);
  }

  private ctx(): RequestContext {
    const c = this.als.getStore();
    if (!c?.tenantId) {
      throw new Error('ConversationStore used outside runWithContext');
    }
    return c;
  }

  private mapKey(userId: string): string {
    return `${this.ctx().tenantId}::${userId}`;
  }

  private evict(): void {
    const now = Date.now();
    for (const [k, state] of this.inventoryState.entries()) {
      if (now - (state.lastActivityAt ?? 0) > CONVERSATION_TTL_MS) {
        this.inventoryState.delete(k);
        this.hydrated.delete(k);
      }
    }
    for (const [vin, entry] of this.vinCache.entries()) {
      if (now - entry.cachedAt > VIN_CACHE_TTL_MS) {
        this.vinCache.delete(vin);
      }
    }
  }

  private defaultState(): ConversationInventoryState {
    return {
      lead: {},
      appointment: {},
      leadScore: 0,
      leadEvents: [],
      leadStage: 'cold',
      lastActivityAt: Date.now(),
    };
  }

  async ensureHydrated(userId: string): Promise<void> {
    const { tenantId, locationId } = this.ctx();
    const k = `${tenantId}::${userId}`;
    if (this.hydrated.has(k) || this.inventoryState.has(k)) {
      this.hydrated.add(k);
      return;
    }

    try {
      const row = await this.prisma.conversation.findUnique({
        where: {
          tenantId_externalKey: { tenantId, externalKey: userId },
        },
      });
      if (row?.state && typeof row.state === 'object') {
        this.inventoryState.set(k, {
          ...this.defaultState(),
          ...(row.state as ConversationInventoryState),
          lastActivityAt: row.lastActivityAt?.getTime() ?? Date.now(),
        });
      } else if (!row) {
        await this.prisma.conversation.create({
          data: {
            tenantId,
            locationId: locationId ?? null,
            externalKey: userId,
            channel: 'WIDGET',
            state: {},
          },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Conversation hydrate failed: ${msg}`);
    }
    this.hydrated.add(k);
  }

  private persist(userId: string, state: ConversationInventoryState) {
    const { tenantId } = this.ctx();
    void this.prisma.conversation
      .upsert({
        where: {
          tenantId_externalKey: { tenantId, externalKey: userId },
        },
        create: {
          tenantId,
          externalKey: userId,
          channel: 'WIDGET',
          state: state as unknown as Prisma.InputJsonValue,
          lastActivityAt: new Date(),
        },
        update: {
          state: state as unknown as Prisma.InputJsonValue,
          lastActivityAt: new Date(),
        },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Conversation persist failed: ${msg}`);
      });
  }

  getInventoryState(userId: string): ConversationInventoryState {
    return this.inventoryState.get(this.mapKey(userId)) ?? this.defaultState();
  }

  setInventoryState(
    userId: string,
    input: Partial<ConversationInventoryState> | InventoryUpdate,
  ) {
    const k = this.mapKey(userId);
    const current = this.getInventoryState(userId);

    let next: ConversationInventoryState;
    if ('patch' in input && 'remove' in input) {
      next = applyInventoryUpdate(current, input);
    } else {
      const partial = input as Partial<ConversationInventoryState>;
      next = {
        ...current,
        ...partial,
        lead: { ...current.lead, ...partial.lead },
        appointment: { ...current.appointment, ...partial.appointment },
        lastActivityAt: Date.now(),
      };
    }

    this.inventoryState.set(k, next);
    this.persist(userId, next);
  }

  clearInventoryState(userId: string) {
    const k = this.mapKey(userId);
    this.inventoryState.delete(k);
    this.hydrated.delete(k);
  }

  getLead(userId: string): LeadState {
    return this.getInventoryState(userId).lead ?? {};
  }

  setLead(userId: string, patch: Partial<LeadState>) {
    const current = this.getInventoryState(userId);
    this.setInventoryState(userId, {
      lead: { ...current.lead, ...patch },
    });
  }

  leadIsComplete(lead?: LeadState): boolean {
    if (!lead) return false;
    return !!lead.firstName && (!!lead.phone || !!lead.email);
  }

  missingLeadFields(lead?: LeadState): Array<'firstName' | 'phoneOrEmail'> {
    const out: Array<'firstName' | 'phoneOrEmail'> = [];
    if (!lead?.firstName) out.push('firstName');
    if (!(lead?.phone || lead?.email)) out.push('phoneOrEmail');
    return out;
  }

  mergePayment(userId: string, prefs: PaymentPreferences) {
    const current = this.getInventoryState(userId);
    const newMax =
      prefs.maxMonthlyPayment ?? prefs.maxMonthly ?? current.maxMonthlyPayment;
    this.setInventoryState(userId, {
      maxMonthlyPayment: newMax,
      downPayment: prefs.downPayment ?? current.downPayment,
      termMonths: prefs.termMonths ?? current.termMonths,
      apr: prefs.apr ?? current.apr,
    });
  }

  getVinProfile(vin: string): VinProfile | undefined {
    const entry = this.vinCache.get(vin);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > VIN_CACHE_TTL_MS) {
      this.vinCache.delete(vin);
      return undefined;
    }
    return entry.profile;
  }

  setVinProfile(vin: string, profile: VinProfile): void {
    this.vinCache.set(vin, { profile, cachedAt: Date.now() });
  }

  async appendMessage(params: {
    userId: string;
    role: 'USER' | 'ASSISTANT' | 'SYSTEM';
    content: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const { tenantId } = this.ctx();
    try {
      const conv = await this.prisma.conversation.findUnique({
        where: {
          tenantId_externalKey: {
            tenantId,
            externalKey: params.userId,
          },
        },
        select: { id: true },
      });
      if (!conv) return;
      await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          role: params.role,
          content: params.content.slice(0, 20_000),
          metadata: params.metadata,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Message append failed: ${msg}`);
    }
  }
}
