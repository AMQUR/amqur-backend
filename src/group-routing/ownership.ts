import type {
  GroupGrant,
  GroupMember,
  ShownVehicle,
} from './group-routing.types';
import { memberOf } from './membership';
import { norm, sideIn } from './store-choice';

export type OwnerLookupRow = { vin: string; tenantId: string };

export type OwnerResolution =
  | { kind: 'owner'; member: GroupMember }
  /** No listed rooftop of this group holds the vehicle (or it belongs to another tenant). */
  | { kind: 'not_found' }
  /** The same VIN is listed by more than one rooftop — never guessed. */
  | { kind: 'conflict'; members: GroupMember[] }
  /** The reference the client echoed does not match the rooftop that holds the vehicle. */
  | { kind: 'ref_mismatch' };

/**
 * Ownership follows the vehicle: the rooftop that holds the VIN, among the group's listed
 * members only. `claimedTenantId` is the rooftop a verified reference named, if one was sent.
 */
export function resolveOwner(
  grant: GroupGrant,
  rows: readonly OwnerLookupRow[],
  claimedTenantId?: string | null,
): OwnerResolution {
  const members = [
    ...new Map(
      rows
        .map((r) => memberOf(grant, r.tenantId))
        .filter((m): m is GroupMember => !!m)
        .map((m) => [m.tenantId, m]),
    ).values(),
  ];
  if (!members.length) return { kind: 'not_found' };
  if (claimedTenantId) {
    const claimed = members.find((m) => m.tenantId === claimedTenantId);
    return claimed
      ? { kind: 'owner', member: claimed }
      : { kind: 'ref_mismatch' };
  }
  if (members.length > 1) return { kind: 'conflict', members };
  return { kind: 'owner', member: members[0] };
}

// An ordinal followed by a noun that is not a vehicle ("my first question", "last time",
// "second opinion") is not a pick from the list.
const NOT_A_LIST_PICK =
  '(?!\\s+(?:real\\s+|actual\\s+|ever\\s+)?(?:questions?|things?|messages?|times?|names?|steps?|words?|topics?|points?|parts?|opinions?|thoughts?|payments?|visits?|appointments?|owners?|weeks?|months?|years?|nights?|days?|of all|and foremost|pregunta|cosa|mensaje|vez|nombre|paso|semana|mes|año))';
const ORDINAL_RE = new RegExp(
  `\\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|last|primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|[uú]ltim[oa])\\b${NOT_A_LIST_PICK}|(?:#|\\bnumber |\\boption |\\bn[uú]mero |\\bopci[oó]n )([1-6])\\b`,
  'i',
);

export function ordinalIndex(message: string, length: number): number | null {
  const m = ORDINAL_RE.exec(message);
  if (!m || length === 0) return null;
  if (m[2]) return Number(m[2]) - 1;
  const w = m[1].toLowerCase();
  if (/^(last|[uú]ltim)/.test(w)) return length - 1;
  const table: Array<[RegExp, number]> = [
    [/^(first|1st|primer)/, 0],
    [/^(second|2nd|segund)/, 1],
    [/^(third|3rd|tercer)/, 2],
    [/^(fourth|4th|cuart)/, 3],
    [/^(fifth|5th|quint)/, 4],
    [/^(sixth|6th|sext)/, 5],
  ];
  return table.find(([re]) => re.test(w))?.[1] ?? null;
}

export type ShownReference =
  | { kind: 'one'; vehicle: ShownVehicle }
  | { kind: 'ambiguous'; vehicles: ShownVehicle[] }
  | { kind: 'none' };

/**
 * Which of the vehicles the GROUP search listed does the customer mean? Resolved here — on
 * the mixed-rooftop list, in the order shown — because "the second one" means nothing inside
 * a single rooftop's conversation. Never guesses: several fits → `ambiguous`.
 */
export function resolveShownReference(
  message: string,
  shown: readonly ShownVehicle[],
  grant: GroupGrant,
  want?: { model?: string; trim?: string; color?: string; year?: number },
): ShownReference {
  if (!shown.length) return { kind: 'none' };
  const idx = ordinalIndex(message, shown.length);
  if (idx !== null)
    return shown[idx] ? { kind: 'one', vehicle: shown[idx] } : { kind: 'none' };

  let cands = [...shown];
  let narrowed = false;
  const side = sideIn(message);
  if (side && side !== 'both') {
    cands = cands.filter((v) => memberOf(grant, v.tenantId)?.side === side);
    narrowed = true;
  }
  const msg = norm(message);
  const has = (s?: string) => !!s && msg.includes(norm(s));
  const byColor = cands.filter((v) => has(v.color));
  if (byColor.length) {
    cands = byColor;
    narrowed = true;
  } else if (want?.color) {
    cands = cands.filter((v) =>
      (v.color ?? '').toLowerCase().includes(want.color!.toLowerCase()),
    );
    narrowed = true;
  }
  if (want?.model) {
    cands = cands.filter((v) =>
      (v.model ?? '').toLowerCase().includes(want.model!.toLowerCase()),
    );
    narrowed = true;
  }
  if (want?.trim) {
    const byTrim = cands.filter((v) =>
      (v.trim ?? '').toLowerCase().includes(want.trim!.toLowerCase()),
    );
    if (byTrim.length) cands = byTrim;
    narrowed = true;
  }
  if (want?.year) {
    cands = cands.filter((v) => v.year === want.year);
    narrowed = true;
  }
  if (!narrowed) return { kind: 'none' };
  if (cands.length === 1) return { kind: 'one', vehicle: cands[0] };
  if (cands.length > 1)
    return { kind: 'ambiguous', vehicles: cands.slice(0, 6) };
  return { kind: 'none' };
}

/**
 * Moving from one rooftop to another inside a conversation. Contact details and consent are
 * NEVER carried over: the second rooftop starts with nothing and must be given them again by
 * the customer through its own form, which records consent in that rooftop. `notice` says
 * whether the customer should be told so (they already gave details to the first rooftop).
 */
export function switchDecision(input: {
  fromTenantId: string | null | undefined;
  toTenantId: string;
  fromHasContact: boolean;
  alreadyLinkedTo: boolean;
}): { switching: boolean; carryContact: false; notice: boolean } {
  const switching =
    !!input.fromTenantId && input.fromTenantId !== input.toTenantId;
  return {
    switching,
    carryContact: false,
    notice: switching && input.fromHasContact && !input.alreadyLinkedTo,
  };
}
