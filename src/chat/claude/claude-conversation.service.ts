import {
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

export type DealerReplyMode = 'sales' | 'service' | 'parts' | 'general';

@Injectable()
export class ClaudeConversationService implements OnModuleInit {
    private readonly logger = new Logger(ClaudeConversationService.name);
    private readonly client: Anthropic | null;
    private readonly model: string;
    private readonly timeoutMs: number;
    private readonly isDevelopment: boolean;

    constructor(private readonly config: ConfigService) {
        this.isDevelopment =
            this.config.get<string>('NODE_ENV') === 'development';

        const keyRaw = this.config.get<string>('ANTHROPIC_API_KEY');
        const key =
            typeof keyRaw === 'string' ? keyRaw.trim() : '';
        this.client =
            key.length > 0 ? new Anthropic({ apiKey: key }) : null;

        this.model =
            this.config.get<string>('ANTHROPIC_MODEL') ??
            'claude-3-5-sonnet-20241022';

        const timeoutFromConfig = this.config.get<number>(
            'ANTHROPIC_TIMEOUT_MS',
        );
        this.timeoutMs =
            typeof timeoutFromConfig === 'number' &&
            !Number.isNaN(timeoutFromConfig)
                ? timeoutFromConfig
                : 25000;
    }

    onModuleInit(): void {
        if (!this.client) {
            this.logger.warn(
                'Claude disabled: ANTHROPIC_API_KEY not set',
            );
            return;
        }
        if (this.isDevelopment) {
            this.logger.debug(`Claude enabled (model=${this.model})`);
        }
    }

    isEnabled(): boolean {
        return this.client !== null;
    }

    /**
     * Rephrases a backend-authored draft. Never invent inventory, pricing, or promises.
     */
    async polishDealerReply(params: {
        draft: string;
        mode: DealerReplyMode;
        facts?: string;
        userMessage?: string;
    }): Promise<string> {
        if (!this.client) {
            return params.draft;
        }

        try {
            const system = [
                'You rewrite text for a dealership website chat assistant.',
                'Sound like a capable sales consultant closing naturally: conversational, confident, never pushy or scripted.',
                'Prioritize clarity and a sensible next step (one question or offer). Keep 2–4 short sentences total. No emojis.',
                'Do not use stiff phrases like: "How can I assist you", "Please select", "Here are some options", "I would be happy to".',
                'Prefer natural openers: "Got you", "Let\'s narrow that down", "Quick question".',
                'Preserve every factual claim from DRAFT and FACTS — never add vehicles, prices, stock, or payment numbers not given.',
                'If FACTS are provided, treat them as the only ground truth about inventory or numbers.',
                'Output plain text only.',
            ].join('\n');

            const user = [
                `MODE: ${params.mode}`,
                `DRAFT:\n${params.draft}`,
                params.facts
                    ? `VERIFIED FACTS (only these are true):\n${params.facts}`
                    : '',
                params.userMessage
                    ? `CUSTOMER MESSAGE:\n${params.userMessage}`
                    : '',
            ]
                .filter(Boolean)
                .join('\n\n');

            return await this.completeText(system, user, params.draft);
        } catch (e) {
            this.logger.warn(
                `polishDealerReply failed: ${e instanceof Error ? e.message : e}`,
            );
            return params.draft;
        }
    }

    /**
     * General knowledge / reasoning — must not assert dealership-specific facts.
     */
    async answerIntelligentQuestion(question: string): Promise<string> {
        const fallback =
            'I’m having a quick hiccup on my side — what vehicle are you leaning toward and I’ll pull what we actually have on the lot?';

        if (!this.client) {
            return fallback;
        }

        try {
            const system = [
                'You help shoppers on a dealership website chat. Sound human and brief (2–4 sentences).',
                'CRITICAL TRUTH RULES:',
                '- Never invent or guess dealership-specific facts: inventory, VINs, stock numbers, prices, MSRP, rebates, incentives, APR, fees, taxes, hours, staff names, policies, warranties, appointments, or parts availability.',
                '- If the customer asks about dealership-specific data you were not given as VERIFIED FACTS, say you cannot verify it from current systems and offer to search inventory, collect contact info, or connect them with a person.',
                '- General automotive education is allowed only when clearly labeled as general guidance, not this store\'s offer.',
                'No emojis. Output plain text only.',
            ].join('\n');

            return await this.completeText(
                system,
                `QUESTION:\n${question}`,
                'I can’t verify dealership-specific details without checking our systems — want me to search inventory, take your contact info, or connect you with someone?',
            );
        } catch (e) {
            this.logger.warn(
                `answerIntelligentQuestion failed: ${e instanceof Error ? e.message : e}`,
            );
            return fallback;
        }
    }

    private async completeText(
        system: string,
        user: string,
        fallback: string,
    ): Promise<string> {
        if (!this.client) {
            return fallback;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const res = await this.client.messages.create(
                {
                    model: this.model,
                    max_tokens: 320,
                    system,
                    messages: [{ role: 'user', content: user }],
                },
                { signal: controller.signal },
            );

            const block = res.content.find((b) => b.type === 'text');
            if (block?.type === 'text' && block.text.trim()) {
                let out = block.text.trim();
                if (out.length > 900) {
                    out = `${out.slice(0, 897)}…`;
                }
                return out;
            }
        } catch (e) {
            if (this.isDevelopment) {
                this.logger.debug(
                    `Claude request error: ${e instanceof Error ? e.message : e}`,
                );
            } else {
                this.logger.warn(
                    'Claude request failed (fallback in use)',
                );
            }
        } finally {
            clearTimeout(timer);
        }

        return fallback;
    }
}
