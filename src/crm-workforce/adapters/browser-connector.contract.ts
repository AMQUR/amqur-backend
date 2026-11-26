import { CrmOperation } from './crm-adapter';

/**
 * Contract for an AUTHORIZED browser-based CRM connector (Mode C).
 *
 * This file is types and rules only. It contains no browser driver, no URL, no selector and no
 * session handling, and nothing imports a browser library. It exists so that, on the day
 * written vendor and dealership permission is recorded, the worker is built to a contract that
 * was reviewed in advance rather than improvised.
 *
 * Fixed rules — part of the contract, not options:
 *  1. The model never drives the browser. A worker executes only `BrowserActionHandler`s, each
 *     for one typed `CrmOperation`, each with its own permission check.
 *  2. Visible, supported CRM screens only. No private endpoints, no captured tokens, no
 *     stealth or fingerprint-masking plugins, no disguising automation.
 *  3. MFA, CAPTCHA, re-authentication prompts and rate limits are never bypassed: they move the
 *     session to AUTH_REQUIRED / THROTTLED and page an operator.
 *  4. One isolated, persistent browser context per rooftop, on dedicated infrastructure, with a
 *     dedicated least-privilege CRM identity. Never an employee's personal browser or laptop.
 *  5. Every handler states the screen it expects (`expects`). If the screen does not match, the
 *     workflow is SUSPENDED — the handler never guesses.
 *  6. A write is VERIFIED only by `readBack`, a separate read of the CRM after the write.
 *     A click, a toast or a timeout proves nothing; an unknown result is UNCERTAIN and is
 *     reconciled before any retry.
 *  7. Screenshots and traces are redacted before they are stored, and never leave the worker
 *     unredacted.
 *  8. The kill switches in `CrmWfControl` and CRM_WORKFORCE_EMERGENCY_STOP are checked before
 *     every action; a stop closes the context at the next safe point.
 */
export type BrowserSessionState =
  | 'STOPPED'
  | 'STARTING'
  /** An operator must sign in (first login, MFA, expired session). The worker waits. */
  | 'AUTH_REQUIRED'
  | 'READY'
  /** Read-only: handlers with sideEffect EXTERNAL are refused. */
  | 'READY_READ_ONLY'
  | 'THROTTLED'
  /** The interface differs from the verified state. Nothing runs until re-verified. */
  | 'SUSPENDED_UI_CHANGED'
  | 'SESSION_EXPIRED'
  | 'STOPPING';

export type BrowserSessionHealth = {
  rooftop: { tenantId: string; locationId: string };
  state: BrowserSessionState;
  /** CRM identity the context is signed in as (an id, never a credential). */
  crmIdentityRef: string | null;
  /** Store the CRM itself reports as selected — must equal the rooftop before any action. */
  verifiedStoreRef: string | null;
  lastCheckedAt: string;
  lastAuthenticatedAt: string | null;
  reason?: string;
};

/** What a handler must find on screen before it may act. Semantic, not positional. */
export type ScreenExpectation = {
  /** Human name of the screen, for the suspension message. */
  screen: string;
  /** Accessible roles / names that must be present. No CSS paths, no coordinates. */
  landmarks: Array<{ role: string; name: string }>;
  /** Version of the verified mapping these landmarks came from. */
  mappingVersion: string;
};

export type BrowserActionContext = {
  rooftop: { tenantId: string; locationId: string };
  /** The CRM's own id for the record being acted on. */
  crmRecordId: string;
  idempotencyKey: string;
  /** Present only for EXTERNAL operations; already approved and compliance-checked. */
  input?: {
    channel?: 'SMS' | 'EMAIL';
    body?: string;
    data?: Record<string, unknown>;
  };
};

export type BrowserActionResult =
  | { outcome: 'DONE'; observed: Record<string, unknown> }
  /** Submitted, but the result on screen was not conclusive. */
  | { outcome: 'UNCERTAIN'; detail: string }
  | {
      outcome: 'REFUSED';
      reason:
        | 'SCREEN_MISMATCH'
        | 'WRONG_STORE'
        | 'WRONG_RECORD'
        | 'READ_ONLY'
        | 'NOT_PERMITTED'
        | 'HALTED';
    }
  | { outcome: 'FAILED'; detail: string };

/** One typed, permission-controlled CRM operation. The only thing a worker can execute. */
export interface BrowserActionHandler {
  readonly operation: CrmOperation;
  readonly sideEffect: 'READ_ONLY' | 'EXTERNAL';
  readonly expects: ScreenExpectation;
  /** Recorded permission this handler needs (document reference category). */
  readonly requiresPermission:
    | 'READ'
    | 'WRITE_MESSAGE'
    | 'WRITE_NOTE_TASK'
    | 'WRITE_APPOINTMENT';
  execute(ctx: BrowserActionContext): Promise<BrowserActionResult>;
  /** Independent re-read of the CRM proving the write is there. Required for EXTERNAL. */
  readBack?(
    ctx: BrowserActionContext,
  ): Promise<{ found: boolean; observedAt: string; ref?: string }>;
}

/** The worker a deployment would run, one per rooftop. Not implemented. */
export interface BrowserConnectorWorker {
  health(): Promise<BrowserSessionHealth>;
  /** Opens the sign-in screen for an operator. Never types a credential or an MFA code. */
  requestOperatorSignIn(): Promise<void>;
  run(
    operation: CrmOperation,
    ctx: BrowserActionContext,
  ): Promise<BrowserActionResult>;
  /** Immediate, safe shutdown: finish nothing, close the context, report STOPPED. */
  stop(reason: string): Promise<void>;
}

/** Evidence that must be on record before a Mode C worker may be enabled for a rooftop. */
export const BROWSER_CONNECTOR_PREREQUISITES = [
  'Tekion customer agreement reviewed: automated access to the CRM interface is permitted, or a written exception is granted',
  'Written permission from Tekion (or its authorized representative) naming the dealership and the scope of automation',
  'Written authorization from the dealership principal for the rooftop',
  'A dedicated CRM identity for the worker with least-privilege permissions, created by the dealership',
  'Dedicated, access-controlled infrastructure for the browser context (not an employee device)',
  'A verified screen mapping (mappingVersion) for each handler, recorded against the current CRM interface',
  'Rate limits agreed with the vendor, configured in the worker',
] as const;
