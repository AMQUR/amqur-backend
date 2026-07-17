/**
 * Error-monitoring bootstrap. Import FIRST in main.ts and worker.ts.
 *
 * Inactive unless ERROR_MONITORING_DSN is set — safe in local dev and in
 * environments where the owner has not yet provisioned a DSN.
 *
 * Redaction: request headers/cookies/user context are never sent; message
 * and stack values that look like secrets, tokens, connection strings, or
 * customer contact details are scrubbed before transmission.
 */
import * as Sentry from '@sentry/node';

const SCRUB_PATTERNS: RegExp[] = [
  /postgres(ql)?:\/\/\S+/gi,
  /redis:\/\/\S+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /eyJ[A-Za-z0-9._-]{20,}/g, // JWT-like
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // emails
  /\+?\d[\d\s().-]{8,}\d/g, // phone-like sequences
  /(secret|password|token|api[_-]?key)\s*[=:]\s*\S+/gi,
];

function scrub(value: string): string {
  let out = value;
  for (const re of SCRUB_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  // Never send request bodies, headers, cookies, or user identity.
  delete event.request;
  delete event.user;

  if (event.message) event.message = scrub(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrub(ex.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrub(crumb.message);
    delete crumb.data;
  }
  return event;
}

const dsn = process.env.ERROR_MONITORING_DSN?.trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
      process.env.NODE_ENV ||
      'development',
    release: process.env.APP_COMMIT_SHA?.trim() || undefined,
    // Errors only for the pilot — no performance/tracing payloads.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: (crumb) => {
      if (crumb.message) crumb.message = scrub(crumb.message);
      delete crumb.data;
      return crumb;
    },
    initialScope: {
      tags: { processRole: process.env.PROCESS_ROLE ?? 'api' },
    },
  });
}

export const errorMonitoringEnabled = Boolean(dsn);

/** Report an exception to the error monitor (no-op without a DSN). */
export function captureError(
  error: unknown,
  context?: Record<string, string>,
): void {
  if (!errorMonitoringEnabled) return;
  Sentry.captureException(error, context ? { tags: context } : undefined);
}

export { scrub as scrubForMonitoring };
