import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { OpenAiLlmProvider } from './openai-llm.provider';
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
} from './llm.provider';
import { MetricsService } from '../observability/metrics.service';
import { ConfigCacheService } from '../cache/config-cache.service';
import { redactForLlm } from '../common/security/sensitive-data';

type BreakerState = { failures: number; openUntil: number };

export type LlmFailureReason =
  | 'no_provider_configured'
  | 'all_circuits_open'
  | 'timeout'
  | 'provider_error'
  | 'empty_completion'
  | 'budget_exhausted'
  | 'rate_limited';

export type LlmRouteResult =
  | { ok: true; result: LlmGenerateResult; attempts: number }
  | { ok: false; reason: LlmFailureReason; attempts: number };

const FAILURE_THRESHOLD = 4;
const OPEN_MS = 45_000;
const BREAKER_TTL_S = 120;

/**
 * primary configured LLM → healthy fallback → (caller) deterministic dealership flow.
 *
 * - per-provider hard timeout
 * - circuit breaker shared across API replicas through Redis when available
 *   (falls back to in-process state; Redis loss only degrades, never corrupts)
 * - latency / token / failure-reason metrics
 * - egress minimization: contact PII, credentials and tokens are redacted before send
 */
/**
 * Spend and load controls (optional env):
 *  - LLM_DAILY_TOKEN_BUDGET   hard daily cap on input+output tokens across replicas (Redis);
 *                             defaults to 2,000,000 so spend is never unbounded
 *  - LLM_MAX_CONCURRENCY      in-process concurrent provider calls (excess → deterministic)
 *  - LLM_COST_INPUT_PER_MTOK / LLM_COST_OUTPUT_PER_MTOK  USD per million tokens, from the
 *    owner's contract/price sheet — used only for metering; no prices are hard-coded
 */
@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);
  private readonly local = new Map<string, BreakerState>();
  private inFlight = 0;
  private localSpend = { day: '', tokens: 0 };

  private num(k: string): number | null {
    const v = Number(this.config.get<string>(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  private dailyBudget(): number {
    return this.num('LLM_DAILY_TOKEN_BUDGET') ?? 2_000_000;
  }

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  private async spentToday(): Promise<number> {
    const day = this.today();
    const shared = await this.cache
      .getJson<{ tokens: number }>(`llm:spend:${day}`)
      .catch(() => null);
    const local = this.localSpend.day === day ? this.localSpend.tokens : 0;
    return Math.max(shared?.tokens ?? 0, local);
  }

  private async addSpend(tokens: number) {
    const day = this.today();
    if (this.localSpend.day !== day) this.localSpend = { day, tokens: 0 };
    this.localSpend.tokens += tokens;
    const prev = await this.spentToday();
    await this.cache
      .setJson(
        `llm:spend:${day}`,
        { tokens: Math.max(prev, this.localSpend.tokens) },
        2 * 86_400,
      )
      .catch(() => undefined);
  }

  /** Configured/missing per provider, models, circuits, today's spend vs cap — never keys. */
  async status() {
    const budget = this.dailyBudget();
    const used = await this.spentToday();
    return {
      primary: this.config.get<string>('LLM_PRIMARY_PROVIDER') ?? 'anthropic',
      providers: (await this.health()).map((h) => ({
        ...h,
        model:
          h.provider === 'anthropic'
            ? (this.config.get<string>('ANTHROPIC_MODEL') ??
              'claude-sonnet-5-5')
            : (this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini'),
      })),
      dailyTokenBudget: budget,
      tokensUsedToday: used,
      budgetExhausted: used >= budget,
      maxConcurrency: this.num('LLM_MAX_CONCURRENCY'),
      inFlight: this.inFlight,
      costMetering:
        this.num('LLM_COST_INPUT_PER_MTOK') !== null &&
        this.num('LLM_COST_OUTPUT_PER_MTOK') !== null,
    };
  }

  constructor(
    private readonly anthropic: AnthropicLlmProvider,
    private readonly openai: OpenAiLlmProvider,
    private readonly metrics: MetricsService,
    private readonly cache: ConfigCacheService,
    private readonly config: ConfigService,
  ) {}

  private ordered(): LlmProvider[] {
    const primary = (
      this.config.get<string>('LLM_PRIMARY_PROVIDER') ?? 'anthropic'
    ).toLowerCase();
    const all: LlmProvider[] = [this.anthropic, this.openai];
    all.sort((a, b) =>
      a.providerId === primary ? -1 : b.providerId === primary ? 1 : 0,
    );
    return all.filter((p) => p.isAvailable());
  }

  isAvailable(): boolean {
    return this.ordered().length > 0;
  }

  private key(id: string) {
    return `llm:breaker:${id}`;
  }

  private async state(id: string): Promise<BreakerState> {
    const shared = await this.cache
      .getJson<BreakerState>(this.key(id))
      .catch(() => null);
    return shared ?? this.local.get(id) ?? { failures: 0, openUntil: 0 };
  }

  private async save(id: string, s: BreakerState) {
    this.local.set(id, s);
    await this.cache
      .setJson(this.key(id), s, BREAKER_TTL_S)
      .catch(() => undefined);
  }

  async health(): Promise<
    Array<{
      provider: string;
      configured: boolean;
      circuitOpen: boolean;
      failures: number;
    }>
  > {
    const out: Array<{
      provider: string;
      configured: boolean;
      circuitOpen: boolean;
      failures: number;
    }> = [];
    for (const p of [this.anthropic, this.openai]) {
      const s = await this.state(p.providerId);
      out.push({
        provider: p.providerId,
        configured: p.isAvailable(),
        circuitOpen: s.openUntil > Date.now(),
        failures: s.failures,
      });
    }
    return out;
  }

  /** Back-compat: returns null on any failure (callers fall back to deterministic text). */
  async generate(params: LlmGenerateParams): Promise<LlmGenerateResult | null> {
    const r = await this.route(params);
    return r.ok ? r.result : null;
  }

  async route(params: LlmGenerateParams): Promise<LlmRouteResult> {
    const providers = this.ordered();
    if (providers.length === 0) {
      this.metrics.increment('ai.llm.unavailable');
      return { ok: false, reason: 'no_provider_configured', attempts: 0 };
    }
    const budget = this.dailyBudget();
    if ((await this.spentToday()) >= budget) {
      this.metrics.increment('ai.llm.budget_exhausted');
      return { ok: false, reason: 'budget_exhausted', attempts: 0 };
    }
    const maxConc = this.num('LLM_MAX_CONCURRENCY');
    if (maxConc !== null && this.inFlight >= maxConc) {
      this.metrics.increment('ai.llm.rate_limited');
      return { ok: false, reason: 'rate_limited', attempts: 0 };
    }
    this.inFlight += 1;
    try {
      return await this.routeInner(providers, params);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async routeInner(
    providers: LlmProvider[],
    params: LlmGenerateParams,
  ): Promise<LlmRouteResult> {
    const safe: LlmGenerateParams = {
      ...params,
      system: params.system,
      messages: params.messages.map((m) => ({
        ...m,
        content: redactForLlm(m.content),
      })),
    };
    const timeoutMs = Math.min(params.timeoutMs ?? 12_000, 30_000);
    let attempts = 0;
    let lastReason: LlmFailureReason = 'all_circuits_open';
    for (const provider of providers) {
      const st = await this.state(provider.providerId);
      if (st.openUntil > Date.now()) {
        this.metrics.increment(`ai.llm.circuit_open.${provider.providerId}`);
        continue;
      }
      attempts += 1;
      const started = Date.now();
      try {
        const result = await withTimeout(
          provider.generate({ ...safe, timeoutMs }),
          timeoutMs,
        );
        if (!result.text?.trim()) throw new EmptyCompletion();
        await this.save(provider.providerId, { failures: 0, openUntil: 0 });
        this.metrics.increment('ai.llm.success');
        this.metrics.increment(`ai.llm.success.${provider.providerId}`);
        this.metrics.increment('ai.llm.latency_ms_total', Date.now() - started);
        if (result.inputTokens)
          this.metrics.increment('ai.llm.tokens_in', result.inputTokens);
        if (result.outputTokens)
          this.metrics.increment('ai.llm.tokens_out', result.outputTokens);
        const used = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
        if (used) await this.addSpend(used);
        const cin = this.num('LLM_COST_INPUT_PER_MTOK');
        const cout = this.num('LLM_COST_OUTPUT_PER_MTOK');
        if (cin !== null && cout !== null) {
          const micro = Math.round(
            (result.inputTokens ?? 0) * cin + (result.outputTokens ?? 0) * cout,
          ); // USD per MTok × tokens = micro-USD
          this.metrics.increment('ai.llm.cost_microusd', micro);
          result.costMicroUsd = micro;
        }
        return { ok: true, result, attempts };
      } catch (e: unknown) {
        lastReason =
          e instanceof TimeoutError
            ? 'timeout'
            : e instanceof EmptyCompletion
              ? 'empty_completion'
              : 'provider_error';
        const failures = st.failures + 1;
        await this.save(provider.providerId, {
          failures,
          openUntil: failures >= FAILURE_THRESHOLD ? Date.now() + OPEN_MS : 0,
        });
        this.metrics.increment('ai.llm.failure');
        this.metrics.increment(
          `ai.llm.failure.${provider.providerId}.${lastReason}`,
        );
        this.logger.warn(
          `LLM provider=${provider.providerId} failed reason=${lastReason}`,
        );
      }
    }
    return { ok: false, reason: lastReason, attempts };
  }
}

class TimeoutError extends Error {}
class EmptyCompletion extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new TimeoutError('timeout')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}
