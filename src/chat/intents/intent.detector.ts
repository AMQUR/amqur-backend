import { ChatIntent } from './intent.types';

export class IntentDetector {
  static detect(message: string): ChatIntent {
    const text = message.toLowerCase();

    // ─────────────────────────────
    // HOLD / RESERVE — must come before GENERAL to avoid false match
    // ─────────────────────────────
    if (
      text.includes('hold') ||
      text.includes('reserve') ||
      text.includes('lock this')
    ) {
      return ChatIntent.HOLD_VEHICLE;
    }

    // ─────────────────────────────
    // 💳 PAYMENT / FINANCE — check before inventory keywords
    // ─────────────────────────────
    if (
      text.includes('monthly') ||
      text.includes('per month') ||
      text.includes('a month') ||
      text.includes('payment') ||
      text.includes('finance') ||
      text.includes('financing') ||
      text.includes('loan') ||
      text.includes('apr') ||
      text.includes('down payment') ||
      text.includes('down pay') ||
      /\bhow much (would|will|is)\b/.test(text) ||
      /\b(36|48|60|72|84)\s*(month|mo)\b/.test(text)
    ) {
      return ChatIntent.PAYMENT_ESTIMATE;
    }

    // ─────────────────────────────
    // 🔹 PARTS
    // ─────────────────────────────
    if (
      /\bparts?\b/.test(text) ||
      text.includes('part number') ||
      text.includes('part #') ||
      text.includes('brake pad') ||
      text.includes('brake pads') ||
      text.includes('rotor') ||
      text.includes('oem part') ||
      text.includes('aftermarket') ||
      text.includes('filter') ||
      text.includes('wiper blade') ||
      text.includes('oil filter')
    ) {
      return ChatIntent.PARTS_INQUIRY;
    }

    // ─────────────────────────────
    // 🔧 SERVICE / APPOINTMENT
    // ─────────────────────────────
    if (
      text.includes('service') ||
      /\boil\b/.test(text) ||
      text.includes('oil change') ||
      text.includes('schedule') ||
      text.includes('appointment') ||
      text.includes('maintenance') ||
      text.includes('recall') ||
      text.includes('repair') ||
      text.includes('technician') ||
      text.includes('inspection') ||
      text.includes('tune up') ||
      text.includes('tune-up')
    ) {
      return ChatIntent.SERVICE_APPOINTMENT;
    }

    // ─────────────────────────────
    // 💲 PRICING
    // ─────────────────────────────
    if (
      text.includes('price') ||
      text.includes('how much') ||
      text.includes('cost') ||
      text.includes('msrp') ||
      text.includes('sticker')
    ) {
      return ChatIntent.PRICING_REQUEST;
    }

    // ─────────────────────────────
    // 🧠 INTELLIGENT MODE — knowledge questions
    // ─────────────────────────────
    if (
      text.startsWith('what is') ||
      text.startsWith('what are') ||
      text.startsWith('how does') ||
      text.startsWith('how do') ||
      text.startsWith('why') ||
      text.startsWith('explain') ||
      text.includes('difference between') ||
      text.includes('compare ') ||
      text.startsWith('tell me about') ||
      text.startsWith('can you tell')
    ) {
      return ChatIntent.INTELLIGENT_QUERY;
    }

    // ─────────────────────────────
    // 📍 HOURS / LOCATION
    // ─────────────────────────────
    if (
      text.includes('hours') ||
      text.includes('open') ||
      text.includes('close') ||
      text.includes('location') ||
      text.includes('address') ||
      text.includes('direction') ||
      text.includes('how far') ||
      text.includes('near me') ||
      text.includes('where are you')
    ) {
      return ChatIntent.HOURS_LOCATION;
    }

    // ─────────────────────────────
    // 👤 HUMAN HANDOFF
    // ─────────────────────────────
    if (
      text.includes('human') ||
      text.includes('person') ||
      text.includes('representative') ||
      text.includes('agent') ||
      text.includes('talk to someone') ||
      text.includes('speak to') ||
      text.includes('real person')
    ) {
      return ChatIntent.HUMAN_HANDOFF;
    }

    // ─────────────────────────────
    // 🚗 INVENTORY SEARCH — broad vehicle/buying intent
    // ─────────────────────────────
    const inventorySignals = [
      // buying intent
      'looking for',
      'looking at',
      'interested in',
      'searching for',
      'want to buy',
      'want a',
      'need a',
      'find me',
      'show me',
      'do you have',
      'do you carry',
      'in stock',
      'available',
      'inventory',
      // vehicle body types
      'suv',
      'truck',
      'pickup',
      'sedan',
      'coupe',
      'hatchback',
      'van',
      'minivan',
      'convertible',
      'wagon',
      'crossover',
      // generic vehicle words
      'car',
      'vehicle',
      'used',
      'new',
      'certified',
      'pre-owned',
      'cpo',
      // drivetrain
      '4x4',
      '4wd',
      'awd',
      'fwd',
      'rwd',
      'all wheel',
      'four wheel',
    ];

    if (inventorySignals.some((k) => text.includes(k))) {
      return ChatIntent.INVENTORY_SEARCH;
    }

    return ChatIntent.GENERAL_QUESTION;
  }
}
