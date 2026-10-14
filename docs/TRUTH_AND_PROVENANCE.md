# Truth and provenance

## Rule

Every customer-facing dealership fact must carry a `ClaimEvidence` produced by a tool:

```ts
{ field, value, source, sourceRecordId, retrievedAt, sourceUpdatedAt,
  freshnessState: 'fresh' | 'stale' | 'unknown' | 'not_applicable',
  tenantId, locationId, verified, conflictId?, disclaimer? }
```

Fields: inventory_availability, advertised_price, msrp, incentives, store_hours, staff_contact, appointment_availability, appointment_status, service_status, repair_order_status, parts_fitment, parts_availability, parts_price, trade_value, finance_apr, finance_approval, dealership_policy, promotion, service_amenity, vehicle_feature.

## Pipeline

1. Tools build evidence (`ClaimEvidenceService`): vehicle price goes through `TruthResolverService` (source-authority rules, freshness SLA, conflict recording → `SourceConflict`, visible to staff).
2. The orchestrator authors a **draft** from evidence (bilingual).
3. Optional LLM polish. The grounding guard allows only claim types present in the server draft or backed by verified evidence; if the model introduces any other claim, the polish is **discarded** and the draft is sent.
4. The response includes `evidence` (public projection) and `provenance` (sources, inventory as-of, disclaimers).

## Unknown or conflicting

Unverified → safe language + a next action ("I can't confirm a shuttle from here; I've added a note so the service advisor can let you know"). Conflicts are never resolved by the LLM.

## Specific policies

- **Appointments:** "requested" until a scheduler or staff confirms (`provider`, `confirmedAt`, `provenance.confirmedBy`).
- **Payments:** `aprSource` = ILLUSTRATIVE / CUSTOMER / VERIFIED_OFFER; never "your rate". Taxes/fees only when dealer-verified.
- **Finance approval:** never claimed; credit link "clicked" ≠ completed.
- **Parts:** fitment/price/availability/ETA flags false unless provider-verified.
- **Trade:** no values without an authorized appraisal source.
- **Hours/amenities:** only staff-verified configuration.
- **Holds:** staff-only; inventory status is never mutated by chat.
