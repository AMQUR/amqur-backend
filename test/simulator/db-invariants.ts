import type { PrismaClient } from '@prisma/client';
import type { Finding } from './evaluator';

/**
 * Database-level invariants, independent of what the replies said: nothing confirmed that only
 * staff may confirm, no sensitive identifiers stored, no credit-link state without a real
 * customer click, and no writes into stores that were never addressed.
 */
export async function dbInvariants(
  db: Pick<PrismaClient, 'appointment' | 'message' | 'financeRequest' | 'lead'>,
  fleetIds: string[],
  untouchedTenantIds: string[],
): Promise<Finding[]> {
  const out: Finding[] = [];
  const push = (rule: string, n: number) =>
    n && out.push({ severity: 'P0', rule, detail: String(n) });
  push(
    'db_appointment_confirmed',
    await db.appointment.count({
      where: { tenantId: { in: fleetIds }, status: 'CONFIRMED' },
    }),
  );
  push(
    'db_sensitive_stored',
    await db.message.count({
      where: {
        OR: [
          { content: { contains: '123-45-6789' } },
          { content: { contains: '4111 1111 1111 1111' } },
          { content: { contains: '078-05-1120' } },
        ],
      },
    }),
  );
  push(
    'db_credit_state_without_click',
    await db.financeRequest.count({
      where: {
        tenantId: { in: fleetIds },
        creditLinkState: { in: ['CLICKED', 'COMPLETED_VERIFIED'] },
      },
    }),
  );
  if (untouchedTenantIds.length) {
    const where = { where: { tenantId: { in: untouchedTenantIds } } };
    push(
      'db_cross_tenant_write',
      (await db.appointment.count(where)) + (await db.lead.count(where)),
    );
  }
  return out;
}
