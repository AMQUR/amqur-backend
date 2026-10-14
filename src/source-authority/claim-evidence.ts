import { Injectable } from '@nestjs/common';
import { TruthResolverService } from './truth-resolver.service';
import { ClaimType, VerifiedFact } from './grounding-guard.service';
import type { HoursProfile } from '../locations/store-hours.service';

export type FreshnessState = 'fresh' | 'stale' | 'unknown' | 'not_applicable';

/**
 * Evidence attached to every customer-facing dealership claim. The LLM never decides these;
 * they come from authoritative tools. `verified=false` means the reply must use safe,
 * non-asserting language for this field.
 */
export type ClaimEvidence = {
  field:
    | 'inventory_availability'
    | 'advertised_price'
    | 'msrp'
    | 'incentives'
    | 'store_hours'
    | 'staff_contact'
    | 'appointment_availability'
    | 'appointment_status'
    | 'service_status'
    | 'repair_order_status'
    | 'parts_fitment'
    | 'parts_availability'
    | 'parts_price'
    | 'trade_value'
    | 'finance_apr'
    | 'finance_approval'
    | 'dealership_policy'
    | 'promotion'
    | 'service_amenity'
    | 'vehicle_feature';
  value: string | number | boolean | null;
  source: string | null;
  sourceRecordId: string | null;
  retrievedAt: string;
  sourceUpdatedAt: string | null;
  freshnessState: FreshnessState;
  tenantId: string;
  locationId: string | null;
  verified: boolean;
  conflictId?: string | null;
  disclaimer?: string;
};

const FIELD_TO_CLAIM: Partial<Record<ClaimEvidence['field'], ClaimType>> = {
  inventory_availability: ClaimType.INVENTORY_AVAILABILITY,
  advertised_price: ClaimType.PRICE,
  msrp: ClaimType.PRICE,
  incentives: ClaimType.INCENTIVES,
  store_hours: ClaimType.HOURS,
  staff_contact: ClaimType.STAFF,
  appointment_status: ClaimType.APPOINTMENT_CONFIRMATION,
  appointment_availability: ClaimType.APPOINTMENT_CONFIRMATION,
  service_status: ClaimType.SERVICE_STATUS,
  repair_order_status: ClaimType.SERVICE_STATUS,
  parts_fitment: ClaimType.PARTS_FITMENT,
  parts_availability: ClaimType.PARTS_STOCK,
  parts_price: ClaimType.PARTS_PRICE,
  finance_apr: ClaimType.FINANCE_APR,
  finance_approval: ClaimType.FINANCE_APPROVAL,
  dealership_policy: ClaimType.POLICIES,
  promotion: ClaimType.INCENTIVES,
};

/** Grounding-guard facts derived ONLY from verified evidence. */
export function verifiedFactsFrom(evidence: ClaimEvidence[]): VerifiedFact[] {
  const out = new Map<ClaimType, boolean>();
  for (const e of evidence) {
    const ct = FIELD_TO_CLAIM[e.field];
    if (!ct) continue;
    out.set(ct, (out.get(ct) ?? false) || e.verified);
  }
  return [...out.entries()].map(([claimType, verified]) => ({
    claimType,
    verified,
  }));
}

/** Public-safe projection (no internal ids beyond source record id, no PII). */
export function publicEvidence(evidence: ClaimEvidence[]) {
  return evidence.map((e) => ({
    field: e.field,
    verified: e.verified,
    source: e.source,
    sourceUpdatedAt: e.sourceUpdatedAt,
    freshnessState: e.freshnessState,
    disclaimer: e.disclaimer,
  }));
}

@Injectable()
export class ClaimEvidenceService {
  constructor(private readonly truth: TruthResolverService) {}

  private base(tenantId: string, locationId: string | null | undefined) {
    return {
      tenantId,
      locationId: locationId ?? null,
      retrievedAt: new Date().toISOString(),
    };
  }

  /** Availability + price for a vehicle row, resolved through configured source authority. */
  async forVehicle(
    tenantId: string,
    locationId: string | null | undefined,
    v: {
      id?: string;
      vin: string;
      price?: number | null;
      msrp?: number | null;
      status?: string | null;
      source?: string | null;
      lastSeenAt?: string | null;
      freshnessState?: string | null;
    },
  ): Promise<ClaimEvidence[]> {
    const src = v.source ?? 'inventory_feed';
    const fresh =
      v.freshnessState === 'FRESH' || v.freshnessState === 'DEGRADED';
    const freshness: FreshnessState = !v.lastSeenAt
      ? 'unknown'
      : fresh
        ? 'fresh'
        : 'stale';
    const sellable = v.status === 'AVAILABLE' || v.status === 'IN_TRANSIT';
    const out: ClaimEvidence[] = [
      {
        ...this.base(tenantId, locationId),
        field: 'inventory_availability',
        value: sellable
          ? v.status === 'IN_TRANSIT'
            ? 'in_transit'
            : 'available'
          : (v.status ?? 'unknown'),
        source: src,
        sourceRecordId: v.vin,
        sourceUpdatedAt: v.lastSeenAt ?? null,
        freshnessState: freshness,
        verified: sellable && freshness === 'fresh',
        disclaimer:
          freshness === 'stale'
            ? 'Inventory data may be out of date — the dealership will confirm availability.'
            : v.status === 'IN_TRANSIT'
              ? 'In transit — arrival timing is confirmed by the dealership.'
              : undefined,
      },
    ];
    if (v.price != null) {
      const resolved = await this.truth.resolveField({
        tenantId,
        field: 'vehicle.price',
        entityType: 'Vehicle',
        entityId: v.id ?? v.vin,
        candidates: [
          {
            source: src,
            value: String(v.price),
            observedAt: v.lastSeenAt ?? null,
          },
        ],
      });
      out.push({
        ...this.base(tenantId, locationId),
        field: 'advertised_price',
        value: resolved.verified ? Number(resolved.value) : v.price,
        source: resolved.source ?? src,
        sourceRecordId: v.vin,
        sourceUpdatedAt: v.lastSeenAt ?? null,
        freshnessState: freshness,
        // A price is customer-verified only when fresh AND authority rule accepts the source.
        verified: resolved.verified && freshness === 'fresh',
        conflictId: resolved.provenance.conflictId ?? null,
        disclaimer: resolved.conflict
          ? 'Price sources disagree — the dealership will confirm the exact price.'
          : 'Advertised price; taxes, fees and incentives are confirmed by the dealership.',
      });
    }
    return out;
  }

  forHours(
    tenantId: string,
    locationId: string | null | undefined,
    profile: HoursProfile | null,
  ): ClaimEvidence {
    return {
      ...this.base(tenantId, locationId),
      field: 'store_hours',
      value: profile?.verified ? 'verified' : null,
      source: profile ? 'location.storeHours' : null,
      sourceRecordId: profile?.locationId ?? null,
      sourceUpdatedAt: profile?.verifiedAt ?? null,
      freshnessState: profile?.verified ? 'fresh' : 'unknown',
      verified: !!profile?.verified,
      disclaimer: profile?.verified
        ? undefined
        : 'Hours not verified by the dealership.',
    };
  }

  forAppointment(
    tenantId: string,
    locationId: string | null | undefined,
    a: {
      id: string;
      status: string;
      provider: string;
      availabilityVerified: boolean;
      updatedAt: Date;
    },
  ): ClaimEvidence {
    const confirmed = a.status === 'CONFIRMED' && a.availabilityVerified;
    return {
      ...this.base(tenantId, locationId),
      field: 'appointment_status',
      value: a.status,
      source: a.provider === 'NONE' ? 'amqur_request' : a.provider,
      sourceRecordId: a.id,
      sourceUpdatedAt: a.updatedAt.toISOString(),
      freshnessState: 'fresh',
      verified: confirmed,
      disclaimer: confirmed
        ? undefined
        : 'Requested — not confirmed until the dealership or its scheduling system confirms.',
    };
  }

  unverified(
    tenantId: string,
    locationId: string | null | undefined,
    field: ClaimEvidence['field'],
    disclaimer: string,
  ): ClaimEvidence {
    return {
      ...this.base(tenantId, locationId),
      field,
      value: null,
      source: null,
      sourceRecordId: null,
      sourceUpdatedAt: null,
      freshnessState: 'unknown',
      verified: false,
      disclaimer,
    };
  }

  verifiedConfig(
    tenantId: string,
    locationId: string | null | undefined,
    field: ClaimEvidence['field'],
    value: string | number | boolean,
    source: string,
    verifiedAt: string | null,
  ): ClaimEvidence {
    return {
      ...this.base(tenantId, locationId),
      field,
      value,
      source,
      sourceRecordId: null,
      sourceUpdatedAt: verifiedAt,
      freshnessState: verifiedAt ? 'fresh' : 'unknown',
      verified: !!verifiedAt,
    };
  }
}
