/**
 * Per-rooftop integration capability matrix.
 *
 * One row per capability, one of exactly five status words, derived only from evidence that
 * is in the database for that rooftop. Code existing is never evidence:
 *
 *   LIVE VERIFIED     a real provider acknowledged a real transaction for THIS rooftop
 *   SANDBOX VERIFIED  the vendor's own official sandbox acknowledged it (needs an explicit
 *                     recorded attestation; nothing in this build can produce one by itself)
 *   DEMO              works against synthetic data, a local sink or the labelled demo scheduler
 *   BLOCKED           a named prerequisite is missing (credential, verified recipient, opt-in…)
 *   NOT TESTED        configured, but no acceptance evidence has been recorded
 */
export const CAPABILITY_STATUSES = [
  'LIVE VERIFIED',
  'SANDBOX VERIFIED',
  'DEMO',
  'BLOCKED',
  'NOT TESTED',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITY_KEYS = [
  'websiteAssistant',
  'inventory',
  'leadDelivery',
  'crmConfirmation',
  'appointmentBooking',
  'tekion',
  'textMessaging',
  'email',
  'voice',
  'groupListing',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  websiteAssistant: 'Assistant on the store website',
  inventory: 'Inventory',
  leadDelivery: 'Lead delivery to the store CRM (ADF)',
  crmConfirmation: 'CRM confirmation of delivered leads',
  appointmentBooking: 'Appointment booking with a scheduler',
  tekion: 'Tekion connection',
  textMessaging: 'Text messaging',
  email: 'Email to customers',
  voice: 'Voice',
  groupListing: 'Listed in group-site search',
};

export type CapabilityCell = { status: CapabilityStatus; reason: string };

/** Everything the matrix is allowed to look at for one rooftop. Counts and booleans only. */
export type CapabilityEvidence = {
  allowedOriginCount: number;
  flags: Record<string, boolean>;
  vehicles: { real: number; synthetic: number };
  leadRoutes: {
    sandboxEnabled: number;
    production: number;
    productionVerified: number;
    productionLive: number; // verified AND production-enabled AND enabled
  };
  deliveries: {
    acceptedOnProductionRoute: number;
    crmMatchedOnProductionRoute: number;
    acceptedOnSandboxRoute: number;
  };
  scheduler: {
    /** An enabled, live-ready appointments connection that is not the demo scheduler. */
    realConnection: boolean;
    providerConfirmedReceipts: number; // CONFIRMED and not sandbox
    sandboxConfirmedReceipts: number;
  };
  tekion: { connection: boolean; enabledLiveReady: boolean };
  messaging: { smsConnection: boolean };
};

const cell = (status: CapabilityStatus, reason: string): CapabilityCell => ({
  status,
  reason,
});

export function capabilityMatrix(
  e: CapabilityEvidence,
): Record<CapabilityKey, CapabilityCell> {
  const f = (k: string) => e.flags[k] === true;

  const websiteAssistant =
    e.allowedOriginCount === 0
      ? cell('BLOCKED', 'No website origin is allowlisted for this store.')
      : cell(
          'NOT TESTED',
          'An origin is allowlisted. No install check has been recorded.',
        );

  const inventory =
    e.vehicles.real > 0
      ? cell(
          'NOT TESTED',
          'Vehicles from a feed are present. Feed accuracy has not been accepted by the store.',
        )
      : e.vehicles.synthetic > 0
        ? cell('DEMO', 'Synthetic demo vehicles only. No store feed.')
        : cell('BLOCKED', 'No inventory feed is connected.');

  const leadDelivery =
    e.deliveries.crmMatchedOnProductionRoute > 0
      ? cell(
          'LIVE VERIFIED',
          'A lead sent on the live route was matched to a CRM record.',
        )
      : e.leadRoutes.productionLive > 0
        ? cell(
            'NOT TESTED',
            e.deliveries.acceptedOnProductionRoute > 0
              ? 'The mail server accepted leads on the live route. No CRM match has been recorded.'
              : 'A live route is approved. No lead has been confirmed by the CRM.',
          )
        : e.leadRoutes.production > 0
          ? cell(
              'BLOCKED',
              e.leadRoutes.productionVerified > 0
                ? 'The destination is verified but not approved for live sending.'
                : 'The destination has not been verified with the store’s CRM administrator.',
            )
          : e.leadRoutes.sandboxEnabled > 0
            ? cell(
                'DEMO',
                'Test route to a reserved address only. Nothing reaches the store.',
              )
            : cell('BLOCKED', 'No destination is set up for this store.');

  const crmConfirmation =
    e.deliveries.crmMatchedOnProductionRoute > 0
      ? cell('LIVE VERIFIED', 'Staff recorded a CRM record for a live lead.')
      : cell(
          'BLOCKED',
          'No CRM read-back exists. Staff can record a match by hand once live leads flow.',
        );

  const appointmentBooking =
    e.scheduler.providerConfirmedReceipts > 0
      ? cell(
          'LIVE VERIFIED',
          'A scheduling provider confirmed a booking for this store.',
        )
      : e.scheduler.realConnection
        ? cell(
            'NOT TESTED',
            'A scheduler connection is enabled. No provider confirmation has been recorded.',
          )
        : f('sandboxScheduler')
          ? cell(
              'DEMO',
              'Labelled demo scheduler only. No real appointment is made.',
            )
          : cell(
              'BLOCKED',
              'No scheduler access. Customers can request a time; staff confirm it.',
            );

  const tekion = e.tekion.enabledLiveReady
    ? cell(
        'NOT TESTED',
        'A Tekion connection is enabled. No verified transaction has been recorded.',
      )
    : cell(
        'BLOCKED',
        e.tekion.connection
          ? 'A Tekion connection exists but is not authorized for use.'
          : 'No Tekion API access has been granted.',
      );

  const textMessaging = !f('sms')
    ? cell('BLOCKED', 'Text messaging is switched off for this store.')
    : e.messaging.smsConnection
      ? cell(
          'NOT TESTED',
          'Switched on with a provider connection. No delivery evidence is recorded here.',
        )
      : cell('BLOCKED', 'Switched on, but no messaging provider is connected.');

  const email = f('email')
    ? cell('NOT TESTED', 'Switched on. No delivery evidence is recorded here.')
    : cell('BLOCKED', 'Email to customers is switched off for this store.');

  const voice = f('voiceAi')
    ? cell('NOT TESTED', 'Switched on. No call evidence is recorded here.')
    : cell('BLOCKED', 'Voice is switched off for this store.');

  const groupListing = !f('groupInventoryListed')
    ? cell(
        'BLOCKED',
        'This store has not opted in to group-site search. It is never searched.',
      )
    : e.vehicles.real > 0
      ? cell(
          'NOT TESTED',
          'Opted in with feed vehicles. Not accepted on a deployed site.',
        )
      : e.vehicles.synthetic > 0
        ? cell('DEMO', 'Opted in with synthetic demo vehicles only.')
        : cell('BLOCKED', 'Opted in, but there is no inventory to list.');

  return {
    websiteAssistant,
    inventory,
    leadDelivery,
    crmConfirmation,
    appointmentBooking,
    tekion,
    textMessaging,
    email,
    voice,
    groupListing,
  };
}
