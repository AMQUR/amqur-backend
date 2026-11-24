import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { OpenAiLlmProvider } from './openai-llm.provider';
import { CompatibleLlmProviders } from './compatible-llm.providers';
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
  | 'spend_cap_exhausted'
  | 'spend_cap_unpriced'
  | 'spend_store_unavailable'
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
 *   (non-production falls back to in-process state; production model calls stop
 *   if the shared spend counter is missing or down)
 * - latency / token / failure-reason metrics
 * - egress minimization: contact PII, credentials and tokens are redacted before send
 */
/**
 * Spend and load controls (optional env):
 *  - LLM_DAILY_TOKEN_BUDGET   hard daily cap on input+output tokens across replicas (Redis);
 *                             defaults to 2,000,000 so spend is never unbounded
 *  - LLM_MAX_CONCURRENCY      in-process concurrent provider calls (excess → deterministic)
 *  - LLM_COST_INPUT_PER_MTOK / LLM_COST_OUTPUT_PER_MTOK  USD per million tokens, from the
 *    owner's contract/price sheet — no prices are hard-coded
 *  - LLM_DAILY_BUDGET_USD          hard daily dollar cap across all stores
 *  - LLM_TENANT_DAILY_BUDGET_USD   hard daily dollar cap per tenant (one store cannot spend
 *                                  the group's budget)
 *  A dollar cap without both prices fails CLOSED (no model calls) — an unpriced cap could
 *  not be enforced. Caps are checked before each call, so the overshoot is bounded by the
 *  calls already in flight (≤ LLM_MAX_CONCURRENCY × one reply). Counters are atomic in Redis
 *  (shared by replicas) and per-replica without it.
 */
@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);
  private readonly local = new Map<string, BreakerState>();
  private inFlight = 0;

  private num(k: string): number | null {
    const v = Number(this.config.get<string>(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  private dailyBudget(): number {
    return this.num('LLM_DAILY_TOKEN_BUDGET') ?? 2_000_000;
  }

  private prices(): { cin: number; cout: number } | null {
    const cin = this.num('LLM_COST_INPUT_PER_MTOK');
    const cout = this.num('LLM_COST_OUTPUT_PER_MTOK');
    return cin !== null && cout !== null ? { cin, cout } : null;
  }

  /** Caps in micro-USD (null = not set). */
  private usdCaps() {
    const g = this.num('LLM_DAILY_BUDGET_USD');
    const t = this.num('LLM_TENANT_DAILY_BUDGET_USD');
    return {
      group: g === null ? null : Math.round(g * 1_000_000),
      tenant: t === null ? null : Math.round(t * 1_000_000),
    };
  }

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  private keys(tenantId?: string) {
    const day = this.today();
    return {
      tokens: `llm:spend:tokens:${day}`,
      usd: `llm:spend:microusd:${day}`,
      tenantUsd: tenantId ? `llm:spend:microusd:${day}:${tenantId}` : null,
    };
  }

  private async counter(key: string): Promise<number> {
    return this.cache.getCounter(key).catch(() => 0);
  }

  /** Why a call must not be made right now (spend controls), or null. */
  private async spendBlock(
    tenantId?: string,
  ): Promise<LlmFailureReason | null> {
    // Production spend limits are only real if the shared counter is reachable.
    // Missing Redis, or Redis configured but down, stops model calls (deterministic
    // replies continue) rather than letting each replica count on its own.
    if (process.env.NODE_ENV === 'production') {
      const configured = !!process.env.REDIS_URL?.trim();
      // Call the method ON the cache: it reads `this.redis`, so an extracted reference throws.
      const cache = this.cache as { isRedisHealthy?: () => boolean };
      const healthy =
        typeof cache.isRedisHealthy === 'function'
          ? cache.isRedisHealthy()
          : false;
      if (!configured || !healthy) return 'spend_store_unavailable';
    }
    const k = this.keys(tenantId);
    if ((await this.counter(k.tokens)) >= this.dailyBudget())
      return 'budget_exhausted';
    const caps = this.usdCaps();
    if (caps.group === null && caps.tenant === null) return null;
    if (!this.prices()) return 'spend_cap_unpriced';
    if (caps.group !== null && (await this.counter(k.usd)) >= caps.group)
      return 'spend_cap_exhausted';
    if (
      caps.tenant !== null &&
      k.tenantUsd &&
      (await this.counter(k.tenantUsd)) >= caps.tenant
    )
      return 'spend_cap_exhausted';
    return null;
  }

  private async addSpend(tokens: number, microUsd: number, tenantId?: string) {
    const k = this.keys(tenantId);
    const ttl = 2 * 86_400;
    const inc = (key: string, by: number) =>
      this.cache.incrBy(key, by, ttl).catch(() => 0);
    if (tokens) await inc(k.tokens, tokens);
    if (microUsd) {
      await inc(k.usd, microUsd);
      if (k.tenantUsd) await inc(k.tenantUsd, microUsd);
    }
  }

  /** Spend today for one tenant (micro-USD), for the Command Center. */
  async tenantSpendToday(tenantId: string) {
    const k = this.keys(tenantId);
    const caps = this.usdCaps();
    const used = k.tenantUsd ? await this.counter(k.tenantUsd) : 0;
    return {
      microUsdUsedToday: used,
      capMicroUsd: caps.tenant,
      capExhausted: caps.tenant !== null && used >= caps.tenant,
    };
  }

  /** Configured/missing per provider, models, circuits, today's spend vs cap — never keys. */
  async status() {
    const budget = this.dailyBudget();
    const k = this.keys();
    const used = await this.counter(k.tokens);
    const caps = this.usdCaps();
    const usdUsed = await this.counter(k.usd);
    const priced = this.prices() !== null;
    return {
      primary: this.config.get<string>('LLM_PRIMARY_PROVIDER') ?? 'anthropic',
      providers: (await this.health()).map((h) => ({
        ...h,
        model:
          h.provider === 'anthropic'
            ? (this.config.get<string>('ANTHROPIC_MODEL') ??
              'claude-sonnet-5-5')
            : h.provider === 'openai'
              ? (this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini')
              : (this.compatible
                  ?.list()
                  .find((c) => c.providerId === h.provider)
                  ?.modelId() ?? null),
      })),
      conversationModel:
        this.config.get<string>('LLM_CONVERSATION_MODEL')?.trim() ||
        'claude-opus-5-5',
      routerModel:
        this.config.get<string>('LLM_ROUTER_MODEL')?.trim() ||
        'claude-haiku-5-5',
      order: this.ordered().map((p) => p.providerId),
      dailyTokenBudget: budget,
      tokensUsedToday: used,
      budgetExhausted: used >= budget,
      maxConcurrency: this.num('LLM_MAX_CONCURRENCY'),
      inFlight: this.inFlight,
      costMetering: priced,
      spend: {
        microUsdUsedToday: priced ? usdUsed : null,
        dailyCapUsd: caps.group === null ? null : caps.group / 1_000_000,
        tenantDailyCapUsd:
          caps.tenant === null ? null : caps.tenant / 1_000_000,
        // a dollar cap that cannot be enforced (no prices) blocks all model calls
        capUnpriced: (caps.group !== null || caps.tenant !== null) && !priced,
        groupCapExhausted: caps.group !== null && usdUsed >= caps.group,
      },
    };
  }

  constructor(
    private readonly anthropic: AnthropicLlmProvider,
    private readonly openai: OpenAiLlmProvider,
    private readonly metrics: MetricsService,
    private readonly cache: ConfigCacheService,
    private readonly config: ConfigService,
    @Optional() private readonly compatible?: CompatibleLlmProviders,
  ) {}

  private allProviders(): LlmProvider[] {
    return [this.anthropic, this.openai, ...(this.compatible?.list() ?? [])];
  }

  /**
   * Primary first, then LLM_FALLBACK_ORDER (comma-separated provider ids) when set, then the
   * remaining configured providers in their declared order. Unconfigured providers never appear.
   */
  private ordered(): LlmProvider[] {
    const primary = (
      this.config.get<string>('LLM_PRIMARY_PROVIDER') ?? 'anthropic'
    ).toLowerCase();
    const wanted = (this.config.get<string>('LLM_FALLBACK_ORDER') ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const all = this.allProviders();
    const rank = (p: LlmProvider) => {
      if (p.providerId === primary) return -1;
      const i = wanted.indexOf(p.providerId);
      return i === -1 ? wanted.length + all.indexOf(p) : i;
    };
    return [...all]
      .sort((a, b) => rank(a) - rank(b))
      .filter((p) => p.isAvailable());
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
    for (const p of this.allProviders()) {
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
    const blocked = await this.spendBlock(params.tenantId);
    if (blocked) {
      this.metrics.increment(`ai.llm.${blocked}`);
      return { ok: false, reason: blocked, attempts: 0 };
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
        content:
          params.redactRoles === 'user' && m.role !== 'user'
            ? m.content
            : redactForLlm(m.content),
      })),
    };
    // Streaming conversation replies may legitimately run long; everything else stays ≤ 30 s.
    const timeoutMs = Math.min(
      params.timeoutMs ?? 12_000,
      params.onTextDelta ? 120_000 : 30_000,
    );
    let attempts = 0;
    let emitted = false;
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
        // A second provider starts the reply over: tell the listener to drop what it has.
        if (attempts > 1 && emitted) {
          emitted = false;
          try {
            params.onTextDelta?.('', true);
          } catch {
            // ignore
          }
        }
        const result = await withTimeout(
          provider.generate({
            ...safe,
            timeoutMs,
            // A model id belongs to one vendor; the fallback provider uses its own default.
            model:
              provider.providerId === 'anthropic' &&
              safe.model?.startsWith('claude')
                ? safe.model
                : undefined,
            onTextDelta: params.onTextDelta
              ? (d, reset) => {
                  if (d) emitted = true;
                  params.onTextDelta?.(d, reset);
                }
              : undefined,
          }),
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
        const price = this.prices();
        let micro = 0;
        if (price) {
          micro = Math.round(
            (result.inputTokens ?? 0) * price.cin +
              (result.outputTokens ?? 0) * price.cout,
          ); // USD per MTok × tokens = micro-USD
          this.metrics.increment('ai.llm.cost_microusd', micro);
          result.costMicroUsd = micro;
        }
        await this.addSpend(used, micro, params.tenantId);
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
