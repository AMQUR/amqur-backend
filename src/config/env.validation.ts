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
});
