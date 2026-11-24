import * as Joi from 'joi';
import { DEPLOYMENT_TIERS, deploymentTierProblem } from './deployment-tier';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  /**
   * Which deployment this is (config/deployment-tier.ts). Optional: unset derives the tier from
   * NODE_ENV exactly as before (production ⇒ production). `staging` is valid with
   * NODE_ENV=production (hosted staging). `production` requires NODE_ENV=production, and
   * `development` / `test` are refused with NODE_ENV=production — both checked below.
   */
  DEPLOYMENT_TIER: Joi.string()
    .valid(...DEPLOYMENT_TIERS)
    .optional(),

  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string().min(1).required(),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  ANTHROPIC_API_KEY: Joi.string().optional().allow(''),
  ANTHROPIC_MODEL: Joi.string().optional().default('claude-sonnet-5-5'),
  ANTHROPIC_TIMEOUT_MS: Joi.number()
    .optional()
    .default(25000)
    .min(1000)
    .max(120000),

  /** Model for the general conversation lane (strongest suitable; default claude-opus-5-5). */
  LLM_CONVERSATION_MODEL: Joi.string().optional().allow(''),
  LLM_CONVERSATION_EFFORT: Joi.string()
    .valid('low', 'medium', 'high')
    .optional(),
  /** Small fast model that decides conversation vs dealership-tool lane. */
  LLM_ROUTER_MODEL: Joi.string().optional().allow(''),
  /** OpenAI model per task tier (default: OPENAI_MODEL for both). */
  OPENAI_CONVERSATION_MODEL: Joi.string().optional().allow(''),
  OPENAI_ROUTER_MODEL: Joi.string().optional().allow(''),
  /** Kill switch for the conversation lane ('false' restores tool-lane-only behaviour). */
  OPEN_CONVERSATION_ENABLED: Joi.string().valid('true', 'false').optional(),

  /** Optional OpenAI-compatible fallbacks: active only when BOTH key and model are set. */
  GEMINI_API_KEY: Joi.string().optional().allow(''),
  GEMINI_MODEL: Joi.string().optional().allow(''),
  GEMINI_BASE_URL: Joi.string().uri().optional().allow(''),
  XAI_API_KEY: Joi.string().optional().allow(''),
  XAI_MODEL: Joi.string().optional().allow(''),
  XAI_BASE_URL: Joi.string().uri().optional().allow(''),
  DEEPSEEK_API_KEY: Joi.string().optional().allow(''),
  DEEPSEEK_MODEL: Joi.string().optional().allow(''),
  DEEPSEEK_BASE_URL: Joi.string().uri().optional().allow(''),
  OPENROUTER_API_KEY: Joi.string().optional().allow(''),
  OPENROUTER_MODEL: Joi.string().optional().allow(''),
  OPENROUTER_BASE_URL: Joi.string().uri().optional().allow(''),
  /** Fallback order after LLM_PRIMARY_PROVIDER, e.g. "openai,gemini,openrouter". */
  LLM_FALLBACK_ORDER: Joi.string().optional().allow(''),

  OPENAI_API_KEY: Joi.string().optional().allow(''),
  OPENAI_MODEL: Joi.string().optional().default('gpt-4o-mini'),
  OPENAI_BASE_URL: Joi.string().uri().optional().allow(''),
  OPENAI_TIMEOUT_MS: Joi.number()
    .optional()
    .default(25000)
    .min(1000)
    .max(120000),

  CRM_WEBHOOK_URL: Joi.string().uri().optional().allow(''),
  /** HMAC-SHA256 signing secret for outbound CRM webhooks (x-amqur-signature). */
  CRM_WEBHOOK_SIGNING_SECRET: Joi.string().min(16).optional().allow(''),

  /** anthropic | openai — primary LLM; the other (if configured) is the fallback. */
  LLM_PRIMARY_PROVIDER: Joi.string()
    .valid('anthropic', 'openai')
    .optional()
    .default('anthropic'),

  /** LLM spend/load controls (see llm-router.service.ts). Unset budget → 2,000,000 tokens/day. */
  LLM_DAILY_TOKEN_BUDGET: Joi.number().integer().min(1000).optional(),
  LLM_MAX_CONCURRENCY: Joi.number().integer().min(1).max(200).optional(),
  LLM_COST_INPUT_PER_MTOK: Joi.number().min(0).optional(),
  LLM_COST_OUTPUT_PER_MTOK: Joi.number().min(0).optional(),
  /** Dollar caps per UTC day (group-wide / per tenant). A cap needs both prices above — an
   *  unpriced cap is rejected here, and the router fails closed if it ever sees one. */
  LLM_DAILY_BUDGET_USD: Joi.number().greater(0).optional(),
  LLM_TENANT_DAILY_BUDGET_USD: Joi.number().greater(0).optional(),

  /** Comma-separated staff roles that must complete TOTP MFA (production default SUPER_ADMIN,ADMIN). */
  STAFF_MFA_REQUIRED_ROLES: Joi.string().optional().allow(''),
  MFA_ISSUER: Joi.string().optional().default('AMQUR Command Center'),

  /** Dedicated secrets (fall back to domain-separated derivations of JWT_SECRET). */
  CONVERSATION_ID_SECRET: Joi.string().min(32).optional().allow(''),
  CREDIT_LINK_SIGNING_SECRET: Joi.string().min(32).optional().allow(''),

  /** local (dev/test only) | s3 — production uploads fail closed while local. */
  UPLOAD_STORAGE: Joi.string().valid('local', 's3').optional().default('local'),
  UPLOAD_TENANT_QUOTA_BYTES: Joi.number().integer().min(1).optional(),

  /** Test-only override for the Twilio REST host; ignored in production. */
  TWILIO_API_BASE: Joi.string().uri().optional().allow(''),

  /** Comma-separated CORS origins. Empty = reflect request origin (dev only). REQUIRED in production. */
  CORS_ORIGINS: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(8).required(),
    otherwise: Joi.string().optional().allow('').default(''),
  }),

  /** Required in production to bootstrap first tenant/admin via /api/auth/bootstrap */
  BOOTSTRAP_SECRET: Joi.string().min(16).optional().allow(''),

  INVENTORY_SYNC_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),

  /** Comma-separated hostnames allowed for inventory feed fetches */
  INVENTORY_FEED_ALLOWED_HOSTS: Joi.string().optional().allow('').default(''),

  /**
   * Dial Difference SFTPGo (read-only amqur_inventory_reader). Default off.
   * Password must come from the server-side secret store — never commit it.
   */
  AMQUR_VAUTO_SFTP_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),
  AMQUR_VAUTO_SFTP_HOST: Joi.string().hostname().optional().allow(''),
  AMQUR_VAUTO_SFTP_PORT: Joi.number().integer().min(1).max(65535).optional(),
  AMQUR_VAUTO_SFTP_USER: Joi.string().optional().allow(''),
  AMQUR_VAUTO_SFTP_PASSWORD: Joi.string().optional().allow(''),
  AMQUR_VAUTO_SFTP_HOST_FINGERPRINT: Joi.string().optional().allow(''),
  AMQUR_VAUTO_SFTP_MAX_BYTES: Joi.number().integer().min(1024).optional(),
  /** Customer-facing advertised price from SFTP feeds — off until dealership approval. */
  AMQUR_VAUTO_PUBLISH_PRICES: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),
  /** Vendor photos — off until image rights are documented. */
  AMQUR_VAUTO_PUBLISH_PHOTOS: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),

  /** Optional HTTPS webhook for ops alerts (SFTP/freshness/lead). Empty = skip. */
  OPS_ALERT_WEBHOOK_URL: Joi.string().uri().optional().allow(''),

  GOOGLE_CLIENT_EMAIL: Joi.string().optional().allow(''),
  GOOGLE_PRIVATE_KEY: Joi.string().optional().allow(''),

  WIDGET_TOKEN_EXPIRES_IN: Joi.string().optional().default('4h'),

  /** Concurrent open POST /chat/stream turns (docs/operations/rate-limits.md). */
  CHAT_STREAM_MAX_CONCURRENT_PER_IP: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .optional()
    .default(10),
  CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .optional()
    .default(4),
  /** Test stacks only: `production` applies the production rate-limit numbers under NODE_ENV=test. */
  RATE_LIMIT_PROFILE: Joi.string().valid('production', 'test').optional(),

  /**
   * Dedicated signing secret for public widget tokens; falls back to
   * JWT_SECRET when unset. Rotating it invalidates outstanding widget
   * tokens without touching staff/admin sessions.
   */
  WIDGET_TOKEN_SECRET: Joi.string().min(32).optional().allow(''),

  /** Error-monitoring DSN (Sentry-compatible). Empty = monitoring disabled. */
  ERROR_MONITORING_DSN: Joi.string().uri().optional().allow(''),

  /**
   * AES key material for IntegrationSecret + MFA secret encryption (32+ chars).
   * REQUIRED in production (admins must enroll MFA; credentials must be storable).
   */
  INTEGRATION_ENCRYPTION_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).optional().allow(''),
  }),

  /**
   * Master switch for employee canary redeem/eligibility.
   * When false, all canary employee sessions fail closed.
   */
  CANARY_EMPLOYEE_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),

  /** Optional dedicated signing secret for canary cookies; falls back to JWT_SECRET. */
  CANARY_EMPLOYEE_SECRET: Joi.string().min(32).optional().allow(''),

  /** Cookie / invite TTL defaults */
  CANARY_SESSION_EXPIRES_IN: Joi.string().optional().default('2h'),
  CANARY_INVITE_EXPIRES_IN: Joi.string().optional().default('15m'),

  /** Claimed deployment environment for canary tokens (staging|production|test) */
  CANARY_ENVIRONMENT: Joi.string()
    .valid('staging', 'production', 'test')
    .optional()
    .default('staging'),

  /**
   * Origins that must present a valid employee canary session to mint widget tokens
   * when CANARY_EMPLOYEE_ENABLED=true. Exact match only; empty = none (staging widget host stays usable).
   */
  CANARY_STRICT_ORIGINS: Joi.string().optional().allow('').default(''),

  /** Optional Redis for widget-config cache / multi-instance coordination */
  REDIS_URL: Joi.string().optional().allow(''),

  /** Outbox processor (default on). Set false on pure API replicas if a worker handles it. */
  OUTBOX_PROCESSOR_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('true'),

  /** Process role: api | worker | all */
  PROCESS_ROLE: Joi.string()
    .valid('api', 'worker', 'all')
    .optional()
    .default('all'),

  /** Public HTTPS URLs for this deployment (tenant/env config — not hardcoded branding). */
  PUBLIC_API_URL: Joi.string().uri().optional().allow(''),
  PUBLIC_WIDGET_URL: Joi.string().uri().optional().allow(''),

  /**
   * Per-rooftop ADF/XML lead delivery (docs/ADF_LEAD_DELIVERY.md). Every switch is fail-closed.
   * ADF_SEND_ENABLED is the master switch (default false: nothing is handed to any transport).
   */
  ADF_SEND_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),
  /**
   * sandbox (default) | live. `live` only takes effect when NODE_ENV=production AND
   * ADF_SEND_ENABLED=true AND the route is a verified, production-enabled PRODUCTION route;
   * otherwise the transport is forced to the sandbox sink / loopback mock SMTP.
   */
  LEAD_DELIVERY_MODE: Joi.string()
    .valid('sandbox', 'live')
    .optional()
    .default('sandbox'),
  /** Sandbox transport: in-process sink (default) or the loopback mock SMTP server. */
  ADF_SANDBOX_TRANSPORT: Joi.string()
    .valid('sink', 'smtp')
    .optional()
    .default('sink'),
  /** SMTP relay. Outside fully-gated live mode only a loopback host is accepted. */
  ADF_SMTP_HOST: Joi.when('LEAD_DELIVERY_MODE', {
    is: 'live',
    then: Joi.string().hostname().required(),
    otherwise: Joi.string().optional().allow('').default('127.0.0.1'),
  }),
  ADF_SMTP_PORT: Joi.number().port().optional().default(11025),
  ADF_SMTP_SECURE: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),
  ADF_SMTP_USER: Joi.string().optional().allow(''),
  ADF_SMTP_PASS: Joi.string().optional().allow(''),
  /** Envelope/From address (needs SPF/DKIM/DMARC alignment before any live send). */
  ADF_FROM_ADDRESS: Joi.when('LEAD_DELIVERY_MODE', {
    is: 'live',
    then: Joi.string().email().required(),
    otherwise: Joi.string()
      .optional()
      .allow('')
      .default('adf-sandbox@amqur.example.invalid'),
  }),
  /** `<provider><name>` in the ADF document. */
  ADF_PROVIDER_NAME: Joi.string()
    .max(60)
    .optional()
    .allow('')
    .default('AMQUR AI'),
  /** Interval of the SSE comment heartbeat on POST /chat/stream while a turn runs, ms. */
  CHAT_STREAM_HEARTBEAT_MS: Joi.number()
    .integer()
    .min(25)
    .max(60000)
    .optional()
    .default(15000),
  /**
   * Explicit opt-in for the SANDBOX (demo) scheduler. Default off. It is additionally refused
   * outright in production — setting it to `true` there fails validation at boot.
   */
  SANDBOX_SCHEDULER_ENABLED: Joi.when('NODE_ENV', {
    is: 'production',
    // Production tier (DEPLOYMENT_TIER unset or `production`): `true` fails boot, as before.
    // Hosted staging (NODE_ENV=production + DEPLOYMENT_TIER=staging) may opt in.
    then: Joi.when('DEPLOYMENT_TIER', {
      is: 'staging',
      then: Joi.string().valid('true', 'false').optional().default('false'),
      otherwise: Joi.string().valid('false').optional().default('false'),
    }),
    otherwise: Joi.string().valid('true', 'false').optional().default('false'),
  }),
  /**
   * Hard overall deadline for one lead hand-off (connect to final reply), ms. Capped at 60 s so
   * the 90 s stale-SENT window always exceeds it by a 30 s margin.
   */
  ADF_SEND_DEADLINE_MS: Joi.number()
    .integer()
    .min(250)
    .max(60000)
    .optional()
    .default(30000),
  /** Hard cap on one ADF document, bytes. */
  ADF_MAX_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(1048576)
    .optional()
    .default(65536),
  /** Optional local directory for sandbox-sink .eml files (never used in production). */
  ADF_SANDBOX_SINK_DIR: Joi.string().optional().allow(''),
})
  .with('LLM_DAILY_BUDGET_USD', [
    'LLM_COST_INPUT_PER_MTOK',
    'LLM_COST_OUTPUT_PER_MTOK',
  ])
  .with('LLM_TENANT_DAILY_BUDGET_USD', [
    'LLM_COST_INPUT_PER_MTOK',
    'LLM_COST_OUTPUT_PER_MTOK',
  ])
  .custom((value: Record<string, unknown>, helpers) => {
    const problem = deploymentTierProblem({
      NODE_ENV: typeof value.NODE_ENV === 'string' ? value.NODE_ENV : undefined,
      DEPLOYMENT_TIER:
        typeof value.DEPLOYMENT_TIER === 'string'
          ? value.DEPLOYMENT_TIER
          : undefined,
    });
    return problem ? helpers.message({ custom: problem }) : value;
  });
