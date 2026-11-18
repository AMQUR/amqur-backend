import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  toActor,
  WorkflowDefinitionController,
} from './workflow-definition.controller';

function ctx(
  role: string,
  handler: keyof WorkflowDefinitionController,
): ExecutionContext {
  return {
    getHandler: () => WorkflowDefinitionController.prototype[handler],
    getClass: () => WorkflowDefinitionController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('WorkflowDefinitionController authorization', () => {
  const guard = new RolesGuard(new Reflector());
  const handlers: Array<keyof WorkflowDefinitionController> = [
    'list',
    'create',
    'get',
    'versions',
    'update',
    'requestReview',
    'approve',
    'deny',
    'rollback',
  ];

  it.each(handlers)('%s denies widget and STAFF, allows MANAGER', (h) => {
    expect(() => guard.canActivate(ctx('widget', h))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(ctx('STAFF', h))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(ctx('MANAGER', h))).toBe(true);
  });

  it('derives tenant, actor and rooftop binding from the JWT only', () => {
    const manager: AuthUser = {
      sub: 'u1',
      tenantId: 'tenant-a',
      role: 'MANAGER',
      locationId: 'rooftop-a',
    };
    expect(toActor(manager)).toEqual({
      tenantId: 'tenant-a',
      userId: 'u1',
      role: 'MANAGER',
      boundLocationId: 'rooftop-a',
    });
    const admin: AuthUser = {
      sub: 'u2',
      tenantId: 'tenant-a',
      role: 'ADMIN',
      locationId: 'ignored',
    };
    expect(toActor(admin).boundLocationId).toBeNull();
  });
});
