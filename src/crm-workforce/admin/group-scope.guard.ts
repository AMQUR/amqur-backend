import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Dealership switching inside CRM Workforce, for people who run a group.
 *
 * A request may name another dealership with `?tenantId=`. Normally only a platform operator
 * may do that. This guard also allows it when the signed-in person has an explicit
 * DealerGroupMembership in a group that contains BOTH their own dealership and the requested
 * one. The request then runs as that dealership with the membership's authority, never more
 * than the person holds at home (a home STAFF account gets no cross-dealership access):
 *   GROUP_ADMIN  → acts as ADMIN of the target dealership (MANAGER if a manager at home)
 *   GROUP_VIEWER → acts as MANAGER, and only reads (GET); every write is refused
 * Acting in another dealership never reaches its administrator accounts: staff management
 * there is limited to roles below ADMIN (see CrmWfStaffService).
 * Without a membership, or for a dealership outside the group, the request is refused here.
 * Memberships are granted by the platform operator, never by this module.
 *
 * Applies to the CRM Workforce controller only; the rest of the platform is unaffected.
 */
@Injectable()
export class CrmWfGroupScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      query: Record<string, unknown>;
      user?: {
        sub: string;
        tenantId: string;
        role: string;
        locationId?: string | null;
        groupActing?: object;
      };
    }>();
    const u = req.user;
    const target =
      typeof req.query?.tenantId === 'string' ? req.query.tenantId : null;
    if (
      !u ||
      !target ||
      target === u.tenantId ||
      u.role === 'SUPER_ADMIN' ||
      u.role === 'widget'
    )
      return true;

    const memberships = await this.prisma.dealerGroupMembership.findMany({
      where: { userId: u.sub },
      select: { role: true, dealerGroupId: true },
    });
    if (!memberships.length)
      throw new ForbiddenException('Cross-tenant access denied');
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: [u.tenantId, target] } },
      select: { id: true, dealerGroupId: true },
    });
    const home = tenants.find((t) => t.id === u.tenantId);
    const dest = tenants.find((t) => t.id === target);
    const m = memberships.find(
      (x) =>
        home?.dealerGroupId === x.dealerGroupId &&
        dest?.dealerGroupId === x.dealerGroupId,
    );
    if (!m || !dest) throw new ForbiddenException('Cross-tenant access denied');
    if (m.role === 'GROUP_VIEWER' && req.method !== 'GET')
      throw new ForbiddenException('group_viewer_is_read_only');
    // Never more authority elsewhere than at home.
    if (u.role !== 'ADMIN' && u.role !== 'MANAGER')
      throw new ForbiddenException('Cross-tenant access denied');
    const role =
      m.role === 'GROUP_ADMIN' && u.role === 'ADMIN' ? 'ADMIN' : 'MANAGER';

    // Act as the target dealership, tenant-wide. `sub` stays the real person for the audit log.
    req.user = {
      ...u,
      tenantId: dest.id,
      role,
      locationId: null,
      groupActing: { homeTenantId: u.tenantId, membership: m.role },
    };
    return true;
  }
}
