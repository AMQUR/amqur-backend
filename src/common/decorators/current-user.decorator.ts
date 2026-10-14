import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

export type AuthUser = {
  sub: string;
  tenantId: string;
  locationId?: string | null;
  role: string;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthUser | undefined;
    if (!user?.sub || !user?.tenantId) {
      throw new UnauthorizedException('Authenticated user context required');
    }
    return user;
  },
);

/**
 * Resolve the tenant scope for a request.
 * SUPER_ADMIN may optionally pass ?tenantId= for cross-tenant admin tools.
 * Everyone else is locked to their JWT tenantId.
 */
export function resolveTenantId(
  user: AuthUser,
  requestedTenantId?: string,
): string {
  if (user.role === 'SUPER_ADMIN' && requestedTenantId) {
    return requestedTenantId;
  }
  if (requestedTenantId && requestedTenantId !== user.tenantId) {
    throw new ForbiddenException('Cross-tenant access denied');
  }
  return user.tenantId;
}

/** Reject widget JWTs from staff-only admin endpoints. */
export function assertStaffRole(user: AuthUser): void {
  if (user.role === 'widget') {
    throw new ForbiddenException('Widget tokens cannot access staff APIs');
  }
}

/**
 * Location scope for staff queries. Staff/managers bound to a location (JWT locationId)
 * may only see that rooftop; tenant-wide roles may filter by any location in their tenant.
 */
export function resolveLocationScope(
  user: AuthUser,
  requestedLocationId?: string | null,
): string | null {
  const bound =
    (user.role === 'STAFF' || user.role === 'MANAGER') && user.locationId
      ? user.locationId
      : null;
  if (bound) {
    if (requestedLocationId && requestedLocationId !== bound) {
      throw new ForbiddenException('Location access denied');
    }
    return bound;
  }
  return requestedLocationId ?? null;
}
