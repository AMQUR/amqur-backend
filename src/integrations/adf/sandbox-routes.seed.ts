import { LeadDeliveryDepartment } from '@prisma/client';
import { LeadDeliveryRouteService } from './lead-delivery-route.service';

/** Reserved (RFC 2606) domain — mail to it can never reach a real mailbox. */
export const SANDBOX_ROUTE_DOMAIN = 'leads.example.invalid';
export const SANDBOX_VERIFICATION_EVIDENCE =
  'SANDBOX ONLY - reserved test address (example.invalid). NOT a verified dealership CRM inbox.';

export function sandboxAddressFor(
  slug: string,
  department: LeadDeliveryDepartment = 'SALES',
): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `adf-${department.toLowerCase()}-${safe}@${SANDBOX_ROUTE_DOMAIN}`;
}

/**
 * Local/demo/test only: give each rooftop a SANDBOX route to its own reserved test address.
 * SANDBOX routes can never be production-enabled (service rule + DB CHECK), so nothing seeded
 * here can ever address a real mailbox.
 */
export async function seedSandboxRoutes(
  routes: LeadDeliveryRouteService,
  rooftops: Array<{ tenantId: string; locationId: string; slug: string }>,
  actor: string,
  department: LeadDeliveryDepartment = 'SALES',
) {
  const out: Array<{ slug: string; routeId: string; address: string }> = [];
  for (const r of rooftops) {
    const address = sandboxAddressFor(r.slug, department);
    const route = await routes.configure(
      r.tenantId,
      { locationId: r.locationId, department, address, environment: 'SANDBOX' },
      actor,
    );
    await routes.verify(
      r.tenantId,
      route.id,
      { evidence: SANDBOX_VERIFICATION_EVIDENCE },
      actor,
    );
    out.push({ slug: r.slug, routeId: route.id, address });
  }
  return out;
}
