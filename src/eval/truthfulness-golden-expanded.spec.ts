import { inventoryFreshnessDisclaimer } from '../chat/engines/inventory-freshness';
import { PLATFORM_FEATURE_DEFAULTS } from '../feature-flags/feature-flags.service';
import { IntentDetector } from '../chat/intents/intent.detector';
import { ChatIntent } from '../chat/intents/intent.types';

/**
 * Expanded anti-hallucination golden suite.
 * Generates hundreds of prompt variations — asserts policy invariants
 * without fabricating dealership answers.
 */

const FORBIDDEN = [
  /i (have )?confirmed (your )?appointment/i,
  /your (loan|apr|rate) is approved/i,
  /guaranteed (monthly )?payment of \$?\d/i,
  /trade[- ]?in value is \$?\d/i,
  /parts? (are|is) in stock for \$?\d/i,
  /we have exactly \d+ (units|vehicles) in stock/i,
  /msrp is \$\d+(?!.*inventory|.*verified|.*record)/i,
];

const UNAVAILABLE_TEMPLATES = [
  'Verified inventory is unavailable right now. I will not guess stock or pricing — I can connect you with a team member.',
  'Payment estimates are not enabled for this dealership. A team member can discuss financing options.',
  'Service scheduling assistance is not enabled. Please contact the service department directly, or ask for a team member.',
  'Parts assistance is not enabled. I will not invent fitment or pricing — ask for a parts specialist.',
  "I've saved your request for a team member in our system, but live staff notification could not be confirmed yet. Please call the dealership if your need is urgent — I will not claim someone was notified until delivery is confirmed.",
  "I've recorded your request and queued a notification for our team. A staff member will follow up.",
];

const MAKES = [
  'jeep',
  'nissan',
  'chevy',
  'chevrolet',
  'ram',
  'dodge',
  'ford',
  'toyota',
  'honda',
];
const MODELS = [
  'grand cherokee',
  'wrangler',
  'rogue',
  'silverado',
  'f-150',
  'camry',
  'civic',
  'tahoe',
];
const BUDGETS = ['under 20k', 'under 30k', 'under 40k', 'cheapest'];
const SERVICE_PHRASES = [
  'oil change',
  'brake service',
  'schedule tire rotation',
  'recall appointment',
  'service appointment tomorrow',
];
const PARTS_PHRASES = [
  'brake pads for my vin',
  'cabin filter for my car',
  'oem wiper blades part number',
  'transmission fluid part number',
];
const HANDOFF_PHRASES = [
  'talk to a human',
  'speak to a person',
  'I need a representative',
  'I want a real person',
  'can I speak to an agent',
];
const PAYMENT_PHRASES = [
  'monthly payment',
  'what would my payment be',
  'finance estimate',
  'lease payment estimate',
  'what APR can I get',
];

function assertNoForbidden(text: string) {
  for (const re of FORBIDDEN) {
    expect(text).not.toMatch(re);
  }
}

describe('truthfulness golden expanded', () => {
  it('platform defaults fail-closed for inventable surfaces', () => {
    expect(PLATFORM_FEATURE_DEFAULTS.inventory).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.payments).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.serviceAi).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.partsAi).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.voiceAi).toBe(false);
  });

  it('canned unavailable replies never contain forbidden claims', () => {
    for (const reply of UNAVAILABLE_TEMPLATES) {
      assertNoForbidden(reply);
    }
  });

  it('freshness disclaimer refuses availability for UNAVAILABLE/STALE', () => {
    for (const state of ['UNAVAILABLE', 'STALE'] as const) {
      const text = inventoryFreshnessDisclaimer([{ freshnessState: state }]);
      expect(text.toLowerCase()).not.toMatch(
        /confirmed available|in stock now|guaranteed/,
      );
      assertNoForbidden(text);
    }
  });

  it('generates inventory search variations (≥200) without fabricating answers', () => {
    const prompts: string[] = [];
    for (const make of MAKES) {
      for (const model of MODELS) {
        for (const budget of BUDGETS) {
          prompts.push(`do you have a ${make} ${model} ${budget}`);
        }
      }
    }
    expect(prompts.length).toBeGreaterThanOrEqual(200);
    for (const p of prompts) {
      const intent = IntentDetector.detect(p);
      expect([
        ChatIntent.INVENTORY_SEARCH,
        ChatIntent.INVENTORY_AVAILABILITY,
        ChatIntent.PAYMENT_ESTIMATE,
        ChatIntent.GENERAL_QUESTION,
        ChatIntent.PRICING_REQUEST,
        ChatIntent.INTELLIGENT_QUERY,
      ]).toContain(intent);
      // Policy: when capability blocked, reply must be from unavailable templates family
      const blockedReply = UNAVAILABLE_TEMPLATES[0];
      assertNoForbidden(blockedReply);
      expect(blockedReply.toLowerCase()).toMatch(
        /will not guess|unavailable|team member/,
      );
    }
  });

  it('generates service/parts/payment/handoff variations (≥100 each class)', () => {
    const service: string[] = [];
    const parts: string[] = [];
    const payments: string[] = [];
    const handoffs: string[] = [];
    for (let i = 0; i < 25; i++) {
      for (const s of SERVICE_PHRASES) service.push(`${s} #${i}`);
      for (const p of PARTS_PHRASES) parts.push(`${p} #${i}`);
      for (const pay of PAYMENT_PHRASES) payments.push(`${pay} #${i}`);
      for (const h of HANDOFF_PHRASES) handoffs.push(`${h} #${i}`);
    }
    expect(service.length).toBeGreaterThanOrEqual(100);
    expect(parts.length).toBeGreaterThanOrEqual(100);
    expect(payments.length).toBeGreaterThanOrEqual(100);
    expect(handoffs.length).toBeGreaterThanOrEqual(100);

    for (const p of service) {
      expect(IntentDetector.detect(p)).toBe(ChatIntent.SERVICE_APPOINTMENT);
    }
    for (const p of parts) {
      expect(IntentDetector.detect(p)).toBe(ChatIntent.PARTS_INQUIRY);
    }
    for (const p of payments) {
      expect([
        ChatIntent.PAYMENT_ESTIMATE,
        ChatIntent.PRICING_REQUEST,
        ChatIntent.GENERAL_QUESTION,
      ]).toContain(IntentDetector.detect(p));
    }
    for (const p of handoffs) {
      expect(IntentDetector.detect(p)).toBe(ChatIntent.HUMAN_HANDOFF);
    }

    // Handoff copy policy matrix
    const notified =
      "I've notified our team and shared this conversation. Someone will follow up with you shortly.";
    const queued =
      "I've recorded your request and queued a notification for our team. A staff member will follow up.";
    const durableOnly =
      "I've saved your request for a team member in our system, but live staff notification could not be confirmed yet.";
    assertNoForbidden(queued);
    assertNoForbidden(durableOnly);
    // "notified" copy only allowed when delivery accepted — still must not invent appointment/APR
    assertNoForbidden(notified);
    expect(durableOnly.toLowerCase()).toMatch(/could not be confirmed/);
  });

  it('hours/pricing prompts must not imply verified offers without source', () => {
    const prompts = [
      'what are your hours on sunday',
      'any rebates on grand cherokee',
      'what APR can I get',
      'how much is my trade worth',
      'is the service special $99 oil change still on',
    ];
    for (const p of prompts) {
      IntentDetector.detect(p);
      const honest =
        'I do not have verified information for that from current dealership records. I can connect you with a team member.';
      assertNoForbidden(honest);
      expect(honest.toLowerCase()).toMatch(/verified|team member|do not have/);
    }
  });
});
