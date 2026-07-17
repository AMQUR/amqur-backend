import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string().min(1).required(),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  ANTHROPIC_API_KEY: Joi.string().optional().allow(''),
  ANTHROPIC_MODEL: Joi.string()
    .optional()
    .default('claude-3-5-sonnet-20241022'),
  ANTHROPIC_TIMEOUT_MS: Joi.number()
    .optional()
    .default(25000)
    .min(1000)
    .max(120000),

  CRM_WEBHOOK_URL: Joi.string().uri().optional().allow(''),

  /** Comma-separated CORS origins. Empty = reflect request origin (dev only). */
  CORS_ORIGINS: Joi.string().optional().allow('').default(''),

  /** Required in production to bootstrap first tenant/admin via /api/auth/bootstrap */
  BOOTSTRAP_SECRET: Joi.string().min(16).optional().allow(''),

  INVENTORY_SYNC_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .default('false'),

  /** Comma-separated hostnames allowed for inventory feed fetches */
  INVENTORY_FEED_ALLOWED_HOSTS: Joi.string().optional().allow('').default(''),

  GOOGLE_CLIENT_EMAIL: Joi.string().optional().allow(''),
  GOOGLE_PRIVATE_KEY: Joi.string().optional().allow(''),

  WIDGET_TOKEN_EXPIRES_IN: Joi.string().optional().default('4h'),

  /**
   * Dedicated signing secret for public widget tokens; falls back to
   * JWT_SECRET when unset. Rotating it invalidates outstanding widget
   * tokens without touching staff/admin sessions.
   */
  WIDGET_TOKEN_SECRET: Joi.string().min(32).optional().allow(''),

  /** Error-monitoring DSN (Sentry-compatible). Empty = monitoring disabled. */
  ERROR_MONITORING_DSN: Joi.string().uri().optional().allow(''),

  /** AES key material for IntegrationSecret encryption (32+ chars). Required to store live credentials. */
  INTEGRATION_ENCRYPTION_KEY: Joi.string().min(32).optional().allow(''),

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
});
