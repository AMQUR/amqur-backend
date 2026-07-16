import { Injectable } from '@nestjs/common';

import { ChatIntent } from './intents/intent.types';
import { IntentDetector } from './intents/intent.detector';

import { InventoryEngine } from './engines/inventory.engine';
import { InventoryExtractor } from './engines/inventory.extractor';

import { AppointmentExtractor } from './appointment-extractor';
import { VinExtractor } from './vin-extractor';
import { VinExplainerService } from './vin/vin-explainer.service';

import { PaymentExtractor } from './payment-extractor';
import { PaymentService } from '../payment/payment.service';

import { VinDecoderService } from './vin/vin-decoder.service';
import { VinProfile } from './vin/vin.types';
import { CompareExtractor } from './compare-extractor';
import { inventoryResponseByStage } from './response-strategy';
import { summarizeDefaultStoreHours } from './utils/store-hours';

import { ConversationStore } from './memory/conversation.store';
import { InventoryVehicle } from './types/vehicle.types';

import { CrmWebhookService } from './crm-webhook.service';
import { LeadExtractor } from './lead-extractor';
import { normalizeDate } from './utils/date-normalizer';
import { DEFAULT_STORE_HOURS } from './utils/store-hours';
import { toMinutes } from './utils/time-utils';
import { PaymentExplainer } from './payment-explainer';
import { MediaEngine } from './media/media.engine';
import { IntelligentRouter } from './intelligence/intelligent.router';
import { IntelligentService } from './intelligence/intelligent.service';
import { FollowupEngine } from './followup/followup.engine';
import { ClaudeConversationService } from './claude/claude-conversation.service';
import type { DealerReplyMode } from './claude/claude-conversation.service';

import { scoreLeadEvent, stageFromScore } from './lead-intelligence';
import { EscalationsService } from '../escalations/escalations.service';
import { LeadsService } from '../leads/leads.service';
import { EscalationUrgency } from '@prisma/client';
import { MetricsService } from '../observability/metrics.service';
import { inventoryFreshnessDisclaimer } from './engines/inventory-freshness';
import { CapabilityService } from '../capability/capability.service';

/** Machine-readable truth metadata for clients and audits */
export type ChatProvenance = {
    sources: string[];
    inventoryAsOf?: string | null;
    disclaimer?: string;
    verifiedFactsOnly: boolean;
};

type ChatResponse =
    | { reply: string; provenance?: ChatProvenance }
    | {
        type: 'vehicle_detail';
        vehicle: VinProfile;
        reply: string;
        provenance?: ChatProvenance;
    }
    | {
        type: 'vehicle_carousel';
        vehicles: InventoryVehicle[];
        reply: string;
        provenance?: ChatProvenance;
    }
    | {
        type: 'vehicle_compare';
        vehicles: InventoryVehicle[];
        reply: string;
        provenance?: ChatProvenance;
    }
    | {
        type: 'payment_summary';
        reply: string;
        monthlyPayment: number;
        termMonths: number;
        apr: number;
        downPayment: number;
        vehicleVin?: string;
        price?: number;
        provenance?: ChatProvenance;
    };

@Injectable()
export class ChatOrchestrator {
    constructor(
        private readonly inventoryEngine: InventoryEngine,
        private readonly memory: ConversationStore,
        private readonly appointmentExtractor: AppointmentExtractor,
        private readonly vinExtractor: VinExtractor,
        private readonly vinDecoder: VinDecoderService,
        private readonly compareExtractor: CompareExtractor,
        private readonly crmWebhook: CrmWebhookService,
        private readonly leadExtractor: LeadExtractor,
        private readonly paymentExplainer: PaymentExplainer,
        private readonly mediaEngine: MediaEngine,
        private readonly intelligentRouter: IntelligentRouter,
        private readonly intelligentService: IntelligentService,
        private readonly vinExplainer: VinExplainerService,
        private readonly followup: FollowupEngine,
        private readonly paymentService: PaymentService,
        private readonly claude: ClaudeConversationService,
        private readonly escalations: EscalationsService,
        private readonly leadsService: LeadsService,
        private readonly metrics: MetricsService,
        private readonly capabilities: CapabilityService,
    ) { }

    private inventoryProvenance(
        vehicles: InventoryVehicle[],
    ): ChatProvenance {
        const timestamps = vehicles
            .map((v) => (v.lastSeenAt ? Date.parse(v.lastSeenAt) : NaN))
            .filter((n) => Number.isFinite(n)) as number[];
        const newest = timestamps.length
            ? new Date(Math.max(...timestamps)).toISOString()
            : null;
        const anyStaleDisclaimer = inventoryFreshnessDisclaimer(vehicles);
        return {
            sources: ['inventory_db'],
            inventoryAsOf: newest,
            verifiedFactsOnly: true,
            disclaimer: anyStaleDisclaimer,
        };
    }

    private paymentProvenance(vehicleVin?: string): ChatProvenance {
        return {
            sources: vehicleVin
                ? ['inventory_db', 'payment_calculator']
                : ['payment_calculator'],
            verifiedFactsOnly: false,
            disclaimer:
                'Educational payment estimate only — not a credit decision or official dealership offer. APR, fees, taxes, and incentives must be verified with the dealership.',
        };
    }

    private async polish(
        draft: string,
        mode: DealerReplyMode,
        opts?: { facts?: string; userMessage?: string },
    ): Promise<string> {
        return this.claude.polishDealerReply({
            draft,
            mode,
            facts: opts?.facts,
            userMessage: opts?.userMessage,
        });
    }

    private async polishGuarded(
        userId: string,
        draft: string,
        mode: DealerReplyMode,
        opts?: { facts?: string; userMessage?: string },
    ): Promise<string> {
        const out = await this.polish(draft, mode, opts);
        return this.guardDuplicateReply(userId, out);
    }

    private guardDuplicateReply(userId: string, text: string): string {
        const norm = text
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .slice(0, 240);
        const prev =
            this.memory.getInventoryState(userId).lastAssistantReplySignature;
        if (prev === norm) {
            const alt = `${text} What should we focus on next — inventory, service, or payments?`;
            const norm2 = alt
                .trim()
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .slice(0, 240);
            this.memory.setInventoryState(userId, {
                lastAssistantReplySignature: norm2,
            });
            return alt;
        }
        this.memory.setInventoryState(userId, {
            lastAssistantReplySignature: norm,
        });
        return text;
    }

    private intentBucket(intent: ChatIntent): 'sales' | 'service' | 'parts' | 'general' {
        switch (intent) {
            case ChatIntent.SERVICE_APPOINTMENT:
                return 'service';
            case ChatIntent.PARTS_INQUIRY:
                return 'parts';
            case ChatIntent.INVENTORY_SEARCH:
            case ChatIntent.INVENTORY_AVAILABILITY:
            case ChatIntent.PRICING_REQUEST:
            case ChatIntent.PAYMENT_ESTIMATE:
            case ChatIntent.HOLD_VEHICLE:
                return 'sales';
            default:
                return 'general';
        }
    }

    private isAppointmentContinuationMessage(message: string): boolean {
        if (
            this.appointmentExtractor.extractDate(message) ||
            this.appointmentExtractor.extractTime(message)
        ) {
            return true;
        }
        const t = message.trim().toLowerCase();
        return (
            /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.test(
                t,
            ) ||
            /\b(tomorrow|today|tonight|this morning|this afternoon|next week)\b/.test(
                t,
            )
        );
    }

    private isLikelyServiceLeadReply(message: string): boolean {
        const ex = this.leadExtractor.extract(message);
        if (ex.firstName || ex.phone || ex.email) return true;
        const t = message.trim().toLowerCase();
        if (t.length > 120) return false;
        return /\b(call|phone|email|text|reach me|contact me)\b/.test(t);
    }

    private clearAppointmentFields(userId: string) {
        this.memory.setInventoryState(userId, {
            appointment: {
                requested: undefined,
                date: undefined,
                time: undefined,
                confirmed: undefined,
            },
        });
    }

    /** Ends service appointment routing; clears slot state so sales/other intents can run cleanly. */
    private markServiceFlowCompleted(userId: string) {
        this.memory.setInventoryState(userId, {
            serviceFlowStep: 'completed',
            awaitingSoftLeadYes: false,
            softLeadCaptureActive: false,
        });
        this.clearAppointmentFields(userId);
    }

    /**
     * When date + time are already in memory (e.g. lead completed on a message with no new date/time),
     * validate hours and confirm — otherwise the flow falls through to "what day" incorrectly.
     */
    private async tryConfirmAppointmentSlotFromMemory(
        userId: string,
        tenantId: string,
        locationId: string | null | undefined,
        message: string,
    ): Promise<ChatResponse | null> {
        const final = this.memory.getInventoryState(userId);
        const apt = final.appointment;
        if (!apt?.date || !apt?.time) {
            return null;
        }

        const day = new Date(apt.date).getDay();
        const hours = DEFAULT_STORE_HOURS[day];

        if (!hours) {
            return {
                reply: 'We’re closed that day. Would another day work better?',
            };
        }

        const mins = toMinutes(apt.time);
        const open = toMinutes(hours.open + ' AM');
        const close = toMinutes(hours.close + ' PM');

        if (mins < open || mins > close) {
            return {
                reply: `We’re open from ${hours.open}–${hours.close}. Would an earlier time work?`,
            };
        }

        this.memory.setInventoryState(userId, {
            appointment: {
                ...apt,
                confirmed: true,
            },
        });

        const confirmedState = this.memory.getInventoryState(userId);
        const appointment = confirmedState.appointment!;

        await this.crmWebhook.send(
            this.buildCrmPayload({
                tenantId,
                locationId,
                userId,
                intent: 'APPOINTMENT_CONFIRMED',
                appointment,
                selected: confirmedState.selectedVin
                    ? {
                        vin: confirmedState.selectedVin,
                        status: 'VIEWED',
                    }
                    : undefined,
            }),
        );

        this.markServiceFlowCompleted(userId);

        return {
            reply: this.guardDuplicateReply(
                userId,
                `I’ve noted your preferred time: ${appointment.date} at ${appointment.time}. ` +
                    `A team member will confirm availability shortly — this is not a final booking until confirmed.`,
            ),
        };
    }

    private async enforceCapabilityGate(params: {
        tenantId: string;
        locationId?: string | null;
        userId: string;
        intent: ChatIntent;
    }): Promise<ChatResponse | null> {
        const { tenantId, locationId, userId, intent } = params;
        type Cap =
            | 'inventory'
            | 'payments'
            | 'service'
            | 'parts'
            | 'vehicleCompare';
        let needed: Cap | null = null;
        if (
            intent === ChatIntent.INVENTORY_SEARCH ||
            intent === ChatIntent.INVENTORY_AVAILABILITY ||
            intent === ChatIntent.HOLD_VEHICLE ||
            intent === ChatIntent.PRICING_REQUEST
        ) {
            needed = 'inventory';
        } else if (intent === ChatIntent.PAYMENT_ESTIMATE) {
            needed = 'payments';
        } else if (intent === ChatIntent.SERVICE_APPOINTMENT) {
            needed = 'service';
        } else if (intent === ChatIntent.PARTS_INQUIRY) {
            needed = 'parts';
        }

        if (!needed) return null;
        const result = await this.capabilities.check(
            tenantId,
            locationId,
            needed,
        );
        if (result.allowed) return null;
        const reply =
            result.customerMessage ??
            'That information is unavailable from verified dealership sources right now. I can connect you with a team member instead.';
        await this.memory.appendMessage({
            userId,
            role: 'ASSISTANT',
            content: reply,
            metadata: {
                type: 'capability_blocked',
                capability: needed,
                reason: result.reason,
            },
        });
        return { reply };
    }

    private async handleHumanHandoff(params: {
        tenantId: string;
        locationId?: string | null;
        userId: string;
        message: string;
        inventoryState: ReturnType<ConversationStore['getInventoryState']>;
    }): Promise<ChatResponse> {
        const { tenantId, locationId, userId, message, inventoryState } = params;
        const lead = inventoryState.lead;
        const summaryParts = [
            `Customer requested a human: "${message.slice(0, 280)}"`,
            inventoryState.selectedVin
                ? `Selected VIN: ${inventoryState.selectedVin}`
                : null,
            lead?.firstName ? `Name: ${lead.firstName}` : null,
            lead?.phone ? `Phone: ${lead.phone}` : null,
            lead?.email ? `Email: ${lead.email}` : null,
        ].filter(Boolean);

        const handoffCap = await this.capabilities.check(
            tenantId,
            locationId,
            'handoff',
        );
        if (!handoffCap.allowed) {
            const reply =
                handoffCap.customerMessage ??
                'I cannot complete a staff handoff right now. Please call the dealership directly.';
            await this.memory.appendMessage({
                userId,
                role: 'ASSISTANT',
                content: reply,
            });
            return { reply };
        }

        const { escalation, notified, queued } = await this.escalations.create({
            tenantId,
            locationId,
            externalKey: userId,
            reason: 'Customer requested human assistance',
            urgency: EscalationUrgency.HIGH,
            summary: summaryParts.join(' | '),
            metadata: {
                selectedVin: inventoryState.selectedVin,
                leadStage: inventoryState.leadStage,
                leadScore: inventoryState.leadScore,
            },
        });
        this.metrics.increment('escalations.created');
        if (notified) this.metrics.increment('escalations.notified');
        if (queued) this.metrics.increment('escalations.queued');

        this.memory.setInventoryState(userId, {
            handoffRequested: true,
            handoffEscalationId: escalation.id,
        });

        // Best-effort secondary CRM event; durable delivery is via escalation outbox.
        await this.crmWebhook.send(
            this.buildCrmPayload({
                tenantId,
                locationId,
                userId,
                intent: 'HUMAN_HANDOFF',
                selected: inventoryState.selectedVin
                    ? { vin: inventoryState.selectedVin, status: 'VIEWED' }
                    : undefined,
            }),
        );

        // Only claim notified/queued when delivery was accepted or durably enqueued.
        const draft = notified
            ? 'I’ve notified our team and shared this conversation. Someone will follow up with you shortly. Meanwhile I can still help with questions.'
            : queued
              ? 'I’ve recorded your request and queued a notification for our team. A staff member will follow up. Meanwhile I can still help with questions.'
              : 'I’ve saved your request for a team member in our system, but live staff notification could not be confirmed yet. Please call the dealership if your need is urgent — I will not claim someone was notified until delivery is confirmed.';

        const reply = await this.polishGuarded(userId, draft, 'general', {
            userMessage: message,
        });
        await this.memory.appendMessage({
            userId,
            role: 'ASSISTANT',
            content: reply,
            metadata: { type: 'human_handoff', escalationId: escalation.id, notified },
        });
        return { reply };
    }

    private clearFlowStateOnBucketChange(
        userId: string,
        prev: 'sales' | 'service' | 'parts' | 'general',
        next: 'sales' | 'service' | 'parts' | 'general',
    ): void {
        if (prev === 'sales') {
            this.memory.setInventoryState(userId, {
                inventorySalesGuideStep: 'none',
                softLeadPromptShown: false,
                awaitingSoftLeadYes: false,
                softLeadCaptureActive: false,
                buyingVisitPrompted: false,
                lastAssistantReplySignature: undefined,
            });
        }
        if (prev === 'service') {
            this.memory.setInventoryState(userId, {
                serviceFlowStep: undefined,
                lastAssistantReplySignature: undefined,
            });
            this.clearAppointmentFields(userId);
        }
        if (prev === 'parts') {
            this.memory.setInventoryState(userId, {
                lastAssistantReplySignature: undefined,
            });
        }

        if (next === 'service' && prev !== 'service') {
            this.memory.setInventoryState(userId, {
                serviceFlowStep: undefined,
                lastAssistantReplySignature: undefined,
            });
            this.clearAppointmentFields(userId);
        }
        if (next === 'sales' && prev !== 'sales') {
            this.memory.setInventoryState(userId, {
                inventorySalesGuideStep: 'none',
                lastAssistantReplySignature: undefined,
            });
        }
    }

    private applyIntentBucketChange(
        userId: string,
        intent: ChatIntent,
        message: string,
    ): void {
        let next = this.intentBucket(intent);
        const s = this.memory.getInventoryState(userId);
        const prev = s.activeFlowBucket;

        if (
            prev === 'service' &&
            next !== 'service' &&
            (s.serviceFlowStep === 'scheduling' ||
                s.serviceFlowStep === 'capturing_info' ||
                s.serviceFlowStep === 'clarified' ||
                s.serviceFlowStep === 'intent_detected' ||
                s.appointment?.requested) &&
            (this.isAppointmentContinuationMessage(message) ||
                this.isLikelyServiceLeadReply(message))
        ) {
            next = 'service';
        }

        if (prev === undefined) {
            this.memory.setInventoryState(userId, { activeFlowBucket: next });
            return;
        }
        if (prev === next) return;

        this.clearFlowStateOnBucketChange(userId, prev, next);
        this.memory.setInventoryState(userId, { activeFlowBucket: next });
    }

    private isServiceScheduleIntent(message: string): boolean {
        return this.appointmentExtractor.wantsScheduling(message);
    }

    private isServicePricingIntent(message: string): boolean {
        const t = message.trim().toLowerCase();
        return (
            /\b(price|pricing|cost|quote|ballpark|estimate)\b/.test(t) ||
            /\b(just|only)\s+(a\s+)?(price|quote|estimate|number)\b/.test(t)
        );
    }

    private vehicleFactsLine(vehicles: InventoryVehicle[]): string {
        return vehicles
            .slice(0, 6)
            .map(
                (v) =>
                    `${v.year ?? ''} ${v.make ?? ''} ${v.model ?? ''}`.trim() +
                    (v.vin ? ` VIN ${v.vin}` : '') +
                    (v.price != null ? ` price ${v.price} USD` : ''),
            )
            .join(' | ');
    }

    // ─────────────────────────────
    // Lead intelligence scoring
    // ─────────────────────────────

    private trackLeadEvent(userId: string, event: string) {
        const state = this.memory.getInventoryState(userId);

        const currentScore = state.leadScore ?? 0;
        const events = state.leadEvents ?? [];

        const newScore = scoreLeadEvent(currentScore, event);
        const newStage = stageFromScore(newScore);

        this.memory.setInventoryState(userId, {
            leadScore: newScore,
            leadStage: newStage,
            leadEvents: [...events, event],
        });
    }

    private getLeadIntelligence(userId: string) {
        const s = this.memory.getInventoryState(userId);
        const events = s.leadEvents ?? [];

        return {
            score: s.leadScore ?? 0,
            stage: s.leadStage ?? 'cold',
            events,
            lastEvent: events.length
                ? events[events.length - 1]
                : undefined,
        };
    }

    // ─────────────────────────────
    // E5.5 — lead completion detector
    // ─────────────────────────────

    private handleLeadCompletion(
        userId: string,
        opts?: { tenantId?: string; locationId?: string | null },
    ) {
        const state = this.memory.getInventoryState(userId);
        const lead = state.lead;

        if (!lead) return;
        if (lead.completed) return;

        if (this.memory.leadIsComplete(lead)) {
            this.memory.setLead(userId, { completed: true });
            this.trackLeadEvent(userId, 'lead_completed');

            if (opts?.tenantId) {
                void this.leadsService
                    .upsertFromConversation({
                        tenantId: opts.tenantId,
                        locationId: opts.locationId,
                        externalKey: userId,
                        firstName: lead.firstName,
                        lastName: lead.lastName,
                        phone: lead.phone,
                        email: lead.email,
                        interestedVin: state.selectedVin,
                        score: state.leadScore,
                        stage: state.leadStage,
                        consentToText: lead.consentToText,
                        preferredContact: lead.preferredContact,
                    })
                    .catch(() => undefined);
            }
        }
    }

    // ─────────────────────────────
    // Lead gate
    // ─────────────────────────────

    private async ensureLead(
        userId: string,
        message: string,
        opts?: { conversionCopy?: boolean },
    ): Promise<{ ok: true } | { ok: false; reply: string }> {

        const extracted = this.leadExtractor.extract(message);

        if (
            extracted.firstName ||
            extracted.lastName ||
            extracted.phone ||
            extracted.email
        ) {
            this.memory.setLead(userId, extracted);
        }

        const state = this.memory.getInventoryState(userId);

        if (state.lead?.completed) {
            return { ok: true };
        }

        if (this.memory.leadIsComplete(state.lead)) {
            this.memory.setLead(userId, { completed: true });
            return { ok: true };
        }

        const missing =
            this.memory.missingLeadFields(state.lead);

        const stage = state.leadStage ?? 'cold';
        const conv = opts?.conversionCopy === true;

        if (missing.includes('firstName')) {
            return {
                ok: false,
                reply: conv
                    ? 'Perfect — what’s your first name?'
                    : stage === 'hot'
                        ? 'Quick one — what’s your first name so I can lock this in?'
                        : 'What’s your first name?',
            };
        }

        return {
            ok: false,
            reply: conv
                ? 'Great — best phone number or email to reach you?'
                : stage === 'hot'
                    ? 'Perfect — what’s the best phone number or email to reach you?'
                    : 'What’s the best phone number or email to contact you?',
        };
    }

    // ─────────────────────────────
    // Lead prompt logic (E3)
    // ─────────────────────────────
    private shouldPromptLead(userId: string): boolean {
        const state = this.memory.getInventoryState(userId);
        if (state.leadPrompted) return false;

        const stage = state.leadStage ?? 'cold';

        if (stage === 'hot') return true;

        const events = state.leadEvents ?? [];

        const triggers = [
            'payment',
            'payment_followup',
            'vehicle_view',
            'appointment',
            'hold',
        ];

        const triggerCount = events.filter(e =>
            triggers.includes(e),
        ).length;

        return triggerCount >= 2;
    }
    // ─────────────────────────────
    // Test-drive trigger logic (E4)
    // ─────────────────────────────
    private shouldSuggestTestDrive(userId: string): boolean {
        const state = this.memory.getInventoryState(userId);

        // never repeat
        if (state.testDriveSuggested) return false;

        // must have a selected vehicle
        if (!state.selectedVin) return false;

        const stage = state.leadStage ?? 'cold';
        if (stage === 'cold') return false;

        const events = state.leadEvents ?? [];

        const intentSignals = [
            'vehicle_view',
            'payment',
            'payment_followup',
            'compare',
        ];

        const signalCount = events.filter(e =>
            intentSignals.includes(e),
        ).length;

        return signalCount >= 2;
    }

    // ─────────────────────────────
    // CRM payload builder
    // ─────────────────────────────

    private buildCrmPayload(params: {
        tenantId: string;
        locationId?: string | null;
        userId: string;
        intent: string;
        selected?: { vin: string; status?: string };
        appointment?: any;
    }) {
        const final = this.memory.getInventoryState(params.userId);

        return {
            source: 'website-chatbot',
            tenantId: params.tenantId,
            locationId: params.locationId,
            timestamp: new Date().toISOString(),

            intent: params.intent,
            lead: final.lead,

            leadIntelligence: this.getLeadIntelligence(params.userId),

            selectedVehicle: params.selected,
            appointment: params.appointment,

            searchContext: {
                query: final.query,
                year: final.year,
                maxPrice: final.maxPrice,

                vehicle: final.selectedVin
                    ? { vin: final.selectedVin }
                    : undefined,

                payment: {
                    estimatedMonthly: final.lastEstimatedPayment,
                    maxMonthlyPayment: final.maxMonthlyPayment,
                    downPayment: final.downPayment,
                    termMonths: final.termMonths,
                    apr: final.apr,
                },

                filters: {
                    color: final.color,
                    drivetrain: final.drivetrain,
                    bodyType: final.bodyType,
                    sortBy: final.sortBy,
                },
            },

            conversationSummary: {
                leadStage: final.leadStage,
                leadScore: final.leadScore,
                events: final.leadEvents,
            },
        };

    }

    // ─────────────────────────────
    // Main handler
    // ─────────────────────────────

    async handleMessage(input: {
        message?: string;

        action?: string;
        vin?: string;
        conversationId?: string;
        role?: string;

        tenantId: string;
        userId: string;
        locationId?: string | null;
    }): Promise<ChatResponse> {
        return this.memory.runWithContext(
            { tenantId: input.tenantId, locationId: input.locationId },
            () => this.handleMessageInner(input),
        );
    }

    private async handleMessageInner(input: {
        message?: string;
        action?: string;
        vin?: string;
        conversationId?: string;
        role?: string;
        tenantId: string;
        userId: string;
        locationId?: string | null;
    }): Promise<ChatResponse> {

        const { tenantId, userId, locationId } = input;
        let message = input.message ?? '';

        await this.memory.ensureHydrated(userId);
        this.metrics.increment('chat.requests');

        // Structured widget actions take precedence over free-text intent
        if (input.vin) {
            const vin = input.vin.toUpperCase().trim();
            this.memory.setInventoryState(userId, { selectedVin: vin });
            if (input.action === 'hold_vehicle') {
                message = message || `hold ${vin}`;
            } else if (input.action === 'payment_estimate') {
                message = message || `payment estimate for ${vin}`;
            } else if (input.action === 'vehicle_detail') {
                message = message || vin;
            }
        }

        await this.memory.appendMessage({
            userId,
            role: 'USER',
            content: message,
            metadata: input.action
                ? { action: input.action, vin: input.vin }
                : undefined,
        });

        const prior = this.memory.getInventoryState(userId);
        const nextTurn = (prior.conversationTurnCount ?? 0) + 1;
        this.memory.setInventoryState(userId, {
            lastActivityAt: Date.now(),
            conversationTurnCount: nextTurn,
        });

        let intent = IntentDetector.detect(message);
        if (input.action === 'hold_vehicle') {
            intent = ChatIntent.HOLD_VEHICLE;
        } else if (input.action === 'payment_estimate') {
            intent = ChatIntent.PAYMENT_ESTIMATE;
        }
        this.applyIntentBucketChange(userId, intent, message);
        const inventoryState =
            this.memory.getInventoryState(userId);

        const chatCap = await this.capabilities.check(
            tenantId,
            locationId,
            'chat',
        );
        if (!chatCap.allowed) {
            const reply =
                chatCap.customerMessage ??
                'Chat is unavailable for this dealership right now.';
            await this.memory.appendMessage({
                userId,
                role: 'ASSISTANT',
                content: reply,
            });
            return { reply };
        }

        // Fail-closed capability gates before dealership-specific work
        const gated = await this.enforceCapabilityGate({
            tenantId,
            locationId,
            userId,
            intent,
        });
        if (gated) return gated;

        if (intent === ChatIntent.HUMAN_HANDOFF) {
            return this.handleHumanHandoff({
                tenantId,
                locationId,
                userId,
                message,
                inventoryState,
            });
        }

        if (this.isHesitationMessage(message)) {
            const draft =
                'Totally — most people start that way. I can at least narrow it down so you’re not wasting time when you’re ready. ' +
                'Do you want me to focus more on budget or type of car?';
            const reply = await this.polishGuarded(userId, draft, 'sales', {
                userMessage: message,
            });
            return { reply };
        }

        if (
            inventoryState.softLeadCaptureActive &&
            !inventoryState.lead?.completed
        ) {
            const gate = await this.ensureLead(userId, message, {
                conversionCopy: true,
            });
            if (!gate.ok) {
                return { reply: gate.reply };
            }
            await this.crmWebhook.send(
                this.buildCrmPayload({
                    tenantId,
                    locationId,
                    userId,
                    intent: 'SOFT_LEAD_CAPTURE',
                    selected: inventoryState.selectedVin
                        ? {
                            vin: inventoryState.selectedVin,
                            status: 'LEAD',
                        }
                        : undefined,
                }),
            );
            this.handleLeadCompletion(userId, { tenantId, locationId });
            this.memory.setInventoryState(userId, {
                softLeadCaptureActive: false,
            });
            const draft =
                'You’re set — someone will reach out with exact numbers and availability.';
            const reply = await this.polishGuarded(userId, draft, 'sales', {
                userMessage: message,
            });
            return { reply };
        }

        if (
            inventoryState.awaitingSoftLeadYes &&
            !inventoryState.lead?.completed
        ) {
            if (this.isNegativeReply(message)) {
                this.memory.setInventoryState(userId, {
                    awaitingSoftLeadYes: false,
                });
                const draft =
                    'All good — I’m here when you want to pick it back up.';
                const reply = await this.polishGuarded(userId, draft, 'sales', {
                    userMessage: message,
                });
                return { reply };
            }
            if (
                this.isAffirmativeReply(message) ||
                !!this.leadExtractor.extract(message).firstName
            ) {
                this.memory.setInventoryState(userId, {
                    awaitingSoftLeadYes: false,
                    softLeadCaptureActive: true,
                });
                const gate = await this.ensureLead(userId, message, {
                    conversionCopy: true,
                });
                if (!gate.ok) {
                    return { reply: gate.reply };
                }
                await this.crmWebhook.send(
                    this.buildCrmPayload({
                        tenantId,
                        locationId,
                        userId,
                        intent: 'SOFT_LEAD_CAPTURE',
                        selected: inventoryState.selectedVin
                            ? {
                                vin: inventoryState.selectedVin,
                                status: 'LEAD',
                            }
                            : undefined,
                    }),
                );
                this.handleLeadCompletion(userId, { tenantId, locationId });
                this.memory.setInventoryState(userId, {
                    softLeadCaptureActive: false,
                });
                const draft =
                    'You’re set — someone will reach out with exact numbers and availability.';
                const reply = await this.polishGuarded(userId, draft, 'sales', {
                    userMessage: message,
                });
                return { reply };
            }
        }

        if (
            this.detectsBuyingVisitIntent(message) &&
            !inventoryState.buyingVisitPrompted &&
            (inventoryState.selectedVin ||
                (inventoryState.visibleVins?.length ?? 0) > 0)
        ) {
            this.memory.setInventoryState(userId, {
                buyingVisitPrompted: true,
                appointment: {
                    ...inventoryState.appointment,
                    requested: true,
                },
            });
            await this.crmWebhook.send(
                this.buildCrmPayload({
                    tenantId,
                    locationId,
                    userId,
                    intent: 'SALES_VISIT_INTENT',
                    selected: inventoryState.selectedVin
                        ? { vin: inventoryState.selectedVin, status: 'VIEWED' }
                        : undefined,
                }),
            );
            const draft =
                'Good choice — that one moves quick. Want me to check if it’s still available and set you up to see it today or tomorrow — which works better?';
            const reply = await this.polishGuarded(userId, draft, 'sales', {
                userMessage: message,
            });
            return { reply };
        }

        if (inventoryState.inventorySalesGuideStep === 'asked_clarify') {
            const invUp = InventoryExtractor.extract(message);
            const payment = PaymentExtractor.extract(message);

            if (
                intent === ChatIntent.INVENTORY_SEARCH ||
                intent === ChatIntent.GENERAL_QUESTION
            ) {
                if (invUp.resetAll) {
                    this.memory.setInventoryState(userId, invUp);
                    this.memory.setInventoryState(userId, {
                        inventorySalesGuideStep: 'none',
                    });
                    const draft =
                        'No problem — tell me what you want to look at and we’ll start fresh.';
                    const reply = await this.polishGuarded(userId, draft, 'sales', {
                        userMessage: message,
                    });
                    return { reply };
                }
                this.memory.mergePayment(userId, payment);
                this.memory.setInventoryState(userId, invUp);
                this.memory.setInventoryState(userId, {
                    inventorySalesGuideStep: 'ready',
                });
                this.trackLeadEvent(userId, 'inventory_search');
                return this.runInventorySearchFlow(
                    tenantId,
                    userId,
                    locationId,
                    message,
                );
            }

            this.memory.setInventoryState(userId, {
                inventorySalesGuideStep: 'ready',
            });
        }

        /**
         * Conversational continuation
         * Example:
         *  user: "yes"
         *  user: "ok"
         *  user: "show me more"
         */
        if (
            intent === ChatIntent.GENERAL_QUESTION &&
            inventoryState.visibleVins?.length
        ) {
            const draft =
                'Want me to break down payments on one of these, check availability, or narrow by miles or price?';
            const reply = await this.polishGuarded(userId, draft, 'sales', {
                userMessage: message,
            });
            return { reply };
        }

        // 🧠 Intelligent Mode routing
        if (
            intent === ChatIntent.INTELLIGENT_QUERY &&
            this.intelligentRouter.shouldRoute(intent)
        ) {
            const raw = await this.intelligentService.answer({
                question: message,
                context: [],
            });
            const reply = await this.polishGuarded(userId, raw, 'general', {
                userMessage: message,
            });
            return { reply };
        }

        if (intent === ChatIntent.PARTS_INQUIRY) {
            const draft =
                'For parts, I’ll need your 17-character VIN or an exact part number. ' +
                'Our parts team verifies fitment before we order — want a specialist to confirm availability and pricing?';
            const reply = await this.polishGuarded(userId, draft, 'parts', {
                userMessage: message,
            });
            return { reply };
        }

        if (intent === ChatIntent.HOURS_LOCATION) {
            const draft =
                `Typical store hours: ${summarizeDefaultStoreHours()} ` +
                'Service lane hours can differ — tell me if you’re planning a visit and I’ll help you connect with the team.';
            const reply = await this.polishGuarded(userId, draft, 'general', {
                userMessage: message,
            });
            return { reply };
        }

        if (intent === ChatIntent.SERVICE_APPOINTMENT) {
            if (
                this.memory.getInventoryState(userId).serviceFlowStep ===
                'completed'
            ) {
                this.memory.setInventoryState(userId, {
                    serviceFlowStep: undefined,
                });
            }
            const svcState = this.memory.getInventoryState(userId);
            const step = svcState.serviceFlowStep ?? undefined;

            if (!step) {
                if (this.isServiceScheduleIntent(message)) {
                    this.memory.setInventoryState(userId, {
                        serviceFlowStep: 'scheduling',
                        appointment: {
                            ...svcState.appointment,
                            requested: true,
                        },
                    });
                    await this.crmWebhook.send(
                        this.buildCrmPayload({
                            tenantId,
                            locationId,
                            userId,
                            intent: 'APPOINTMENT_REQUEST',
                            appointment: { requested: true },
                            selected: svcState.selectedVin
                                ? {
                                    vin: svcState.selectedVin,
                                    status: 'VIEWED',
                                }
                                : undefined,
                        }),
                    );
                    this.trackLeadEvent(userId, 'appointment');
                    const reply = await this.polishGuarded(userId, 'Perfect — what day works best for you?', 'service', {
                        userMessage: message,
                    });
                    return { reply };
                }
                this.memory.setInventoryState(userId, {
                    serviceFlowStep: 'intent_detected',
                });
                const reply = await this.polishGuarded(userId, 'Got it — are you looking to schedule it or just check pricing?', 'service', {
                    userMessage: message,
                });
                return { reply };
            }

            if (step === 'intent_detected') {
                if (this.isServiceScheduleIntent(message)) {
                    this.memory.setInventoryState(userId, {
                        serviceFlowStep: 'scheduling',
                        appointment: {
                            ...svcState.appointment,
                            requested: true,
                        },
                    });
                    await this.crmWebhook.send(
                        this.buildCrmPayload({
                            tenantId,
                            locationId,
                            userId,
                            intent: 'APPOINTMENT_REQUEST',
                            appointment: { requested: true },
                            selected: svcState.selectedVin
                                ? {
                                    vin: svcState.selectedVin,
                                    status: 'VIEWED',
                                }
                                : undefined,
                        }),
                    );
                    this.trackLeadEvent(userId, 'appointment');
                    const reply = await this.polishGuarded(userId, 'Perfect — what day works best for you?', 'service', {
                        userMessage: message,
                    });
                    return { reply };
                }
                if (this.isServicePricingIntent(message)) {
                    this.memory.setInventoryState(userId, {
                        serviceFlowStep: 'clarified',
                    });
                    const reply = await this.polishGuarded(userId, 'Got it — I can have service follow up with pricing. Prefer a quick call or email?', 'service', {
                        userMessage: message,
                    });
                    return { reply };
                }
                const reply = await this.polishGuarded(userId, 'Quick check — are we booking a visit or ballparking cost?', 'service', {
                    userMessage: message,
                });
                return { reply };
            }
        }

        const state = this.memory.getInventoryState(userId);
        const visibleVins = state.visibleVins ?? [];

        // HOLD VEHICLE
        if (intent === ChatIntent.HOLD_VEHICLE && state.selectedVin) {
            const gate = await this.ensureLead(userId, message);
            if (!gate.ok) return { reply: gate.reply };

            this.trackLeadEvent(userId, 'hold');

            await this.inventoryEngine.holdVehicle(
                tenantId,
                state.selectedVin,
            );

            await this.crmWebhook.send(
                this.buildCrmPayload({
                    tenantId,
                    locationId,
                    userId,
                    intent: 'HOLD_VEHICLE',
                    selected: {
                        vin: state.selectedVin,
                        status: 'HOLD',
                    },
                }),
            );

            return {
                reply:
                    'I’ve marked that vehicle as held in our system — a team member will verify availability and follow up shortly. Holds are not final until staff confirms.',
            };
        }

        // ─────────────────────────────
        // APPOINTMENT FLOW (E6)
        // ─────────────────────────────
        if (
            (this.appointmentExtractor.wantsScheduling(message) ||
                state.appointment?.requested) &&
            state.serviceFlowStep !== 'completed'
        ) {
            const gate = await this.ensureLead(userId, message);
            if (!gate.ok) {
                const st0 = this.memory.getInventoryState(userId);
                if (st0.serviceFlowStep === 'scheduling') {
                    this.memory.setInventoryState(userId, {
                        serviceFlowStep: 'capturing_info',
                    });
                }
                return {
                    reply: this.guardDuplicateReply(userId, gate.reply),
                };
            }

            this.trackLeadEvent(userId, 'appointment');

            // ensure appointment flow started
            if (!state.appointment?.requested) {
                this.memory.setInventoryState(userId, {
                    appointment: { requested: true },
                });

                await this.crmWebhook.send(
                    this.buildCrmPayload({
                        tenantId,
                        locationId,
                        userId,
                        intent: 'APPOINTMENT_REQUEST',
                        appointment: { requested: true },
                        selected: state.selectedVin
                            ? { vin: state.selectedVin, status: 'VIEWED' }
                            : undefined,
                    }),
                );

                return {
                    reply:
                        'I can take your preferred day and time — appointments are requested until the team confirms. What day works best?',
                };
            }

            // extract date/time
            const rawDate = this.appointmentExtractor.extractDate(message);
            const date = rawDate
                ? normalizeDate(rawDate)
                : undefined;
            const time = this.appointmentExtractor.extractTime(message);

            if (date || time) {
                this.memory.setInventoryState(userId, {
                    appointment: {
                        ...state.appointment,
                        ...(date ? { date } : {}),
                        ...(time ? { time } : {}),
                    },
                });

                const final = this.memory.getInventoryState(userId);

                await this.crmWebhook.send(
                    this.buildCrmPayload({
                        tenantId,
                        locationId,
                        userId,
                        intent: 'APPOINTMENT_DETAILS',
                        appointment: final.appointment,
                        selected: final.selectedVin
                            ? { vin: final.selectedVin, status: 'VIEWED' }
                            : undefined,
                    }),
                );

                // confirm appointment when complete
                if (final.appointment?.date && final.appointment?.time) {
                    const confirmed = await this.tryConfirmAppointmentSlotFromMemory(
                        userId,
                        tenantId,
                        locationId,
                        message,
                    );
                    if (confirmed) return confirmed;
                }

                // ask what's missing
                if (!final.appointment?.date) {
                    return { reply: 'What day works best for you?' };
                }

                if (!final.appointment?.time) {
                    return { reply: 'What time works best?' };
                }
            }

            // Lead completed on a message without new date/time — confirm if slot already fully saved.
            const maybeConfirm = await this.tryConfirmAppointmentSlotFromMemory(
                userId,
                tenantId,
                locationId,
                message,
            );
            if (maybeConfirm) return maybeConfirm;

            const stHandoff = this.memory.getInventoryState(userId);
            if (
                this.memory.leadIsComplete(stHandoff.lead) &&
                (stHandoff.serviceFlowStep === 'capturing_info' ||
                    stHandoff.serviceFlowStep === 'scheduling') &&
                (!stHandoff.appointment?.date ||
                    !stHandoff.appointment?.time)
            ) {
                await this.crmWebhook.send(
                    this.buildCrmPayload({
                        tenantId,
                        locationId,
                        userId,
                        intent: 'APPOINTMENT_DETAILS',
                        appointment: stHandoff.appointment,
                        selected: stHandoff.selectedVin
                            ? { vin: stHandoff.selectedVin, status: 'VIEWED' }
                            : undefined,
                    }),
                );
                this.markServiceFlowCompleted(userId);
                const reply = await this.polishGuarded(
                    userId,
                    'Perfect — I’ve got everything. I’ve logged your appointment request; our team will reach out to confirm availability. This is not a final booking until confirmed.',
                    'service',
                    { userMessage: message },
                );
                return { reply };
            }

            const cur = this.memory.getInventoryState(userId);
            if (!cur.appointment?.date) {
                return {
                    reply: this.guardDuplicateReply(
                        userId,
                        'What day works best for you?',
                    ),
                };
            }

            if (!cur.appointment?.time) {
                return {
                    reply: this.guardDuplicateReply(
                        userId,
                        'What time works best?',
                    ),
                };
            }

            return {
                reply: this.guardDuplicateReply(
                    userId,
                    'What day and time work best for you?',
                ),
            };
        }


        // VIN VIEW
        const selectedVin =
            this.vinExtractor.extract(
                message,
                visibleVins,
            ) ||
            inventoryState?.selectedVin;


        if (selectedVin) {
            this.memory.setInventoryState(userId, { selectedVin });

            const vehicle =
                await this.inventoryEngine.getVehicleByVin(
                    tenantId,
                    selectedVin,
                );

            if (!vehicle) {
                return {
                    reply: "Sorry — I couldn't find that vehicle. Want me to search for similar options?",
                };
            }

            // Track only once, after confirming vehicle exists
            this.trackLeadEvent(userId, 'vehicle_view');

            const enriched =
                await this.enrichVehiclesWithVin([vehicle]);

            const draft =
                "Here's what we have on this vehicle — want payments, availability checked, or a time to see it?";
            const reply = await this.polishGuarded(userId, draft, 'sales', {
                facts: this.vehicleFactsLine(enriched),
                userMessage: message,
            });

            return {
                type: 'vehicle_carousel',
                reply,
                vehicles: enriched,
            };
        }
        // ─────────────────────────────
        // PAYMENT ESTIMATE (E1)
        // ─────────────────────────────
        if (intent === ChatIntent.PAYMENT_ESTIMATE) {
            this.trackLeadEvent(userId, 'payment_followup');

            const payment = PaymentExtractor.extract(message);
            this.memory.mergePayment(userId, payment);

            const vinFromMessage = this.vinExtractor.extract(
                message,
                visibleVins,
            );
            if (vinFromMessage) {
                this.memory.setInventoryState(userId, {
                    selectedVin: vinFromMessage,
                });
                this.trackLeadEvent(userId, 'vehicle_view');
            }

            const final = this.memory.getInventoryState(userId);

            if (!final.selectedVin) {
                const illustrationPrice = 28000;
                const ballpark = this.paymentService.estimateFinance({
                    price: illustrationPrice,
                    downPayment: final.downPayment ?? 0,
                    apr: final.apr ?? 9.99,
                    termMonths: final.termMonths ?? 72,
                });
                const mo = Math.round(ballpark.monthlyPayment).toLocaleString();
                let draft =
                    'I can ballpark it, but if you want exact numbers I can run it properly for you — want me to do that? ' +
                    `Rough idea: about $${mo}/mo on a typical $${illustrationPrice.toLocaleString()} with your term settings (illustration only, not a specific vehicle).`;
                const facts =
                    `Illustrative payment only (example price ${illustrationPrice} USD). Not a vehicle-specific quote.`;
                if (!final.lead?.completed) {
                    this.memory.setInventoryState(userId, {
                        awaitingSoftLeadYes: true,
                        softLeadPromptShown: true,
                    });
                }
                const reply = await this.polishGuarded(userId, draft, 'sales', {
                    facts,
                    userMessage: message,
                });
                return { reply };
            }

            const vehicle = await this.inventoryEngine.getVehicleByVin(
                tenantId,
                final.selectedVin,
            );
            if (!vehicle) {
                const draft =
                    'Sorry — this vehicle is no longer available. Want me to show similar options?';
                const reply = await this.polishGuarded(userId, draft, 'sales', {
                    userMessage: message,
                });
                return { reply };
            }

            const estimate = this.paymentService.estimateFinance({
                price: Number(vehicle.price ?? 0),
                downPayment: final.downPayment,
                apr: final.apr ?? 9.99,
                termMonths: final.termMonths ?? 72,
            });

            const formatted = estimate.monthlyPayment.toLocaleString();
            this.memory.setInventoryState(userId, {
                lastEstimatedPayment: estimate.monthlyPayment,
            });

            let draft =
                `Estimated payment is $${formatted}/month ` +
                `(${estimate.breakdown.termMonths} mo, $${final.downPayment || 0} down, ${estimate.breakdown.apr}% APR). ` +
                `Estimate only — taxes and fees vary. ` +
                'This one would be a strong fit to dig into — want me to check if it’s still available or walk through locking the numbers with someone?';

            if (this.shouldPromptLead(userId)) {
                this.memory.setInventoryState(userId, {
                    leadPrompted: true,
                });

                draft +=
                    ' Would you like me to send this info to you or have a specialist reach out?';
            }
            if (this.shouldSuggestTestDrive(userId)) {
                this.memory.setInventoryState(userId, {
                    testDriveSuggested: true,
                });

                draft +=
                    ' Want to schedule a test drive for this vehicle?';
            }

            const facts =
                `Vehicle VIN ${vehicle.vin}. Price ${vehicle.price} USD. ` +
                `Monthly ${estimate.monthlyPayment}, term ${estimate.breakdown.termMonths}, APR ${estimate.breakdown.apr}%, down ${final.downPayment ?? 0}.`;

            const reply = await this.polishGuarded(userId, draft, 'sales', {
                facts,
                userMessage: message,
            });

            return {
                type: 'payment_summary',
                reply,
                monthlyPayment: estimate.monthlyPayment,
                termMonths: estimate.breakdown.termMonths,
                apr: estimate.breakdown.apr,
                downPayment: final.downPayment ?? 0,
                vehicleVin: final.selectedVin,
                price: Number(vehicle.price ?? 0),
                provenance: this.paymentProvenance(final.selectedVin),
            };
        }
        // INVENTORY SEARCH
        if (intent === ChatIntent.INVENTORY_SEARCH) {
            const invUpdate = InventoryExtractor.extract(message);
            const payment = PaymentExtractor.extract(message);
            const s0 = this.memory.getInventoryState(userId);

            if (invUpdate.resetAll) {
                this.memory.setInventoryState(userId, invUpdate);
                this.memory.setInventoryState(userId, {
                    inventorySalesGuideStep: 'none',
                });
                this.memory.mergePayment(userId, payment);
                this.trackLeadEvent(userId, 'inventory_search');
                return this.runInventorySearchFlow(
                    tenantId,
                    userId,
                    locationId,
                    message,
                );
            }

            this.memory.setInventoryState(userId, invUpdate);
            this.memory.mergePayment(userId, payment);

            const s1 = this.memory.getInventoryState(userId);
            const step = s1.inventorySalesGuideStep ?? 'none';

            if (step === 'none') {
                this.memory.setInventoryState(userId, {
                    inventorySalesGuideStep: 'asked_clarify',
                });
                const draft =
                    'Got you — are you trying to stay under a certain budget, or just looking for the strongest deal we can find?';
                const reply = await this.polishGuarded(userId, draft, 'sales', {
                    userMessage: message,
                });
                return { reply };
            }

            this.trackLeadEvent(userId, 'inventory_search');
            if (
                payment.maxMonthlyPayment ||
                payment.apr ||
                payment.termMonths ||
                payment.downPayment
            ) {
                this.trackLeadEvent(userId, 'payment');
            }

            return this.runInventorySearchFlow(
                tenantId,
                userId,
                locationId,
                message,
            );
        }
        if (this.followup.shouldFollowUp(state)) {
            const raw = this.followup.buildMessage(state);
            const reply = await this.polishGuarded(userId, raw, 'sales', {
                userMessage: message,
            });
            return { reply };
        }
        const fallback = await this.polishGuarded(userId,
            'What are you shopping for today — something in stock, or a payment target I should aim at?',
            'general',
            { userMessage: message },
        );
        return { reply: fallback };
    }

    private async runInventorySearchFlow(
        tenantId: string,
        userId: string,
        locationId: string | null | undefined,
        message: string,
    ): Promise<ChatResponse> {
        const criteria = this.memory.getInventoryState(userId);

        let vehicles = await this.inventoryEngine.searchVehicles({
            tenantId,
            locationId,
            ...criteria,
        });

        if (criteria.maxMonthlyPayment) {
            vehicles = vehicles
                .map((v) => {
                    const estimate = this.paymentService.estimateFinance({
                        price: Number(v.price ?? 0),
                        downPayment: criteria.downPayment,
                        apr: criteria.apr ?? 9.99,
                        termMonths: criteria.termMonths ?? 72,
                    });

                    return {
                        ...v,
                        estimatedPayment: estimate.monthlyPayment,
                        paymentExplanation: this.paymentExplainer.explain({
                            price: Number(v.price ?? 0),
                            estimatedPayment: estimate.monthlyPayment,
                            downPayment: criteria.downPayment,
                            apr: estimate.breakdown.apr,
                            termMonths: estimate.breakdown.termMonths,
                        }),
                    };
                })
                .filter(
                    (v) =>
                        (v.estimatedPayment ?? Infinity) <=
                        criteria.maxMonthlyPayment!,
                );
        }

        const enriched = await this.enrichVehiclesWithVin(vehicles);

        this.memory.setInventoryState(userId, {
            visibleVins: enriched.map((v) => v.vin),
        });

        const stage =
            this.memory.getInventoryState(userId).leadStage ?? 'cold';

        const base = inventoryResponseByStage(stage);
        const follow =
            'Want me to narrow to lowest miles, best payment, or a specific trim?';
        const st2 = this.memory.getInventoryState(userId);
        let outreach = '';
        if (
            !st2.softLeadPromptShown &&
            !st2.lead?.completed &&
            (st2.conversationTurnCount ?? 0) >= 3
        ) {
            this.memory.setInventoryState(userId, {
                softLeadPromptShown: true,
                awaitingSoftLeadYes: true,
            });
            outreach =
                ' I can get exact numbers and check availability for you — want me to have someone reach out?';
        }
        const draft = `${base} ${follow}${outreach}`;
        const facts = `${enriched.length} vehicle(s). ${this.vehicleFactsLine(enriched)}`;
        const provenance = this.inventoryProvenance(enriched);
        let draftOut = draft;
        if (provenance.disclaimer && enriched.length > 0) {
            // Keep disclaimer in reply when inventory may be stale
            const stale =
                provenance.disclaimer.includes('day behind') ||
                enriched.some((v) => !v.lastSeenAt);
            if (stale) {
                draftOut = `${draft} ${provenance.disclaimer}`;
            }
        }
        if (enriched.length === 0) {
            this.metrics.increment('inventory.miss');
            const emptyDraft =
                'I couldn’t verify matching vehicles in our current inventory for those filters. ' +
                'Want to broaden the search, leave your contact for a callback, or talk to someone on the floor?';
            const emptyReply = await this.polishGuarded(userId, emptyDraft, 'sales', {
                userMessage: message,
                facts: '0 verified inventory matches',
            });
            return {
                type: 'vehicle_carousel',
                vehicles: [],
                reply: emptyReply,
                provenance: {
                    sources: ['inventory_db'],
                    inventoryAsOf: null,
                    verifiedFactsOnly: true,
                    disclaimer:
                        'No matching vehicles found in verified inventory — I will not invent listings.',
                },
            };
        }

        this.metrics.increment('inventory.hit');
        const reply = await this.polishGuarded(userId, draftOut, 'sales', {
            facts,
            userMessage: message,
        });

        return {
            type: 'vehicle_carousel',
            vehicles: enriched,
            reply,
            provenance,
        };
    }

    private isHesitationMessage(message: string): boolean {
        const t = message.trim().toLowerCase();
        return (
            /^(just looking|just browsing|not sure yet|maybe later)\b/.test(t) ||
            /\b(only browsing|just looking around|not ready to buy)\b/.test(t)
        );
    }

    private isAffirmativeReply(message: string): boolean {
        const t = message.trim().toLowerCase();
        if (t.length > 96) return false;
        return (
            /^(yes|yeah|yep|sure|ok|okay|please|absolutely)\b/.test(t) ||
            /^(sounds good|let'?s do it|do it)\b/.test(t) ||
            t === 'y'
        );
    }

    private isNegativeReply(message: string): boolean {
        const t = message.trim().toLowerCase();
        return (
            /^(no|nope|nah|not now)\b/.test(t) ||
            /\b(no thanks|not interested)\b/.test(t)
        );
    }

    private detectsBuyingVisitIntent(message: string): boolean {
        const t = message.toLowerCase();
        return (
            /\b(i like|i love|i want this|interested in this|that one)\b/.test(
                t,
            ) ||
            /\b(is it available|still available|can i see it|come see it|test drive)\b/.test(
                t,
            )
        );
    }

    private async enrichVehiclesWithVin(
        vehicles: InventoryVehicle[],
    ): Promise<InventoryVehicle[]> {
        const enriched: InventoryVehicle[] = [];

        for (const v of vehicles) {
            let profile = this.memory.getVinProfile(v.vin);

            if (!profile) {
                profile = await this.vinDecoder.decode(v.vin);
                this.memory.setVinProfile(v.vin, profile);
            }

            const media = await this.mediaEngine.enrich(
                v.make ?? '',
                v.vin,
            );

            enriched.push({
                ...v,
                trim: v.trim ?? profile.trim,
                engine: profile.engine,
                drivetrain: profile.drivetrain,
                fuelType: profile.fuelType,
                doors: profile.doors,
                bodyType: profile.bodyType,

                photos: media.photos,
                windowStickerUrl: media.windowStickerUrl,
            });

        }

        return enriched;
    }
}
