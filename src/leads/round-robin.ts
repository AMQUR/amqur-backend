import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const LEAD_ASSIGNABLE_ROLES: Role[] = [Role.STAFF, Role.MANAGER];

/** Active STAFF/MANAGER eligible for a lead at this rooftop (or tenant-wide when location is null). */
export function assignableStaffWhere(
  tenantId: string,
  leadLocationId?: string | null,
) {
  return {
    tenantId,
    isActive: true,
    role: { in: LEAD_ASSIGNABLE_ROLES },
    ...(leadLocationId
      ? { OR: [{ locationId: leadLocationId }, { locationId: null }] }
      : {}),
  };
}

/**
 * Least-open-load round-robin among active staff at the rooftop (or tenant-wide
 * when locationId is null). Never invents an assignee when nobody is eligible.
 */
export async function pickRoundRobinAssignee(
  prisma: PrismaService,
  tenantId: string,
  locationId?: string | null,
): Promise<string | null> {
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      isActive: true,
      role: { in: LEAD_ASSIGNABLE_ROLES },
      OR: locationId
        ? [{ locationId }, { locationId: null }]
        : undefined,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (users.length === 0) return null;

  const openCounts = await prisma.lead.groupBy({
    by: ['assignedUserId'],
    where: {
      tenantId,
      ...(locationId ? { locationId } : {}),
      status: { in: ['OPEN', 'CONTACTED', 'QUALIFIED'] },
      assignedUserId: { in: users.map((u) => u.id) },
    },
    _count: { _all: true },
  });
  const byId = new Map(
    openCounts.map((r) => [r.assignedUserId!, r._count._all]),
  );
  let best = users[0].id;
  let bestCount = byId.get(best) ?? 0;
  for (const u of users.slice(1)) {
    const n = byId.get(u.id) ?? 0;
    if (n < bestCount) {
      best = u.id;
      bestCount = n;
    }
  }
  return best;
}

export type LeadAssignInput = {
  tenantId: string;
  locationId?: string | null;
  existingAssignedUserId?: string | null;
};

/** Only assigns when the lead has no owner yet. */
export async function resolveNewLeadAssignee(
  prisma: PrismaService,
  flags: Record<string, boolean>,
  input: LeadAssignInput,
): Promise<string | null> {
  if (input.existingAssignedUserId) return input.existingAssignedUserId;
  if (flags.roundRobinAssign !== true) return null;
  return pickRoundRobinAssignee(prisma, input.tenantId, input.locationId);
}
