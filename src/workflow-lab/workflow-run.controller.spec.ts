import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/guards/roles.guard';
import { WorkflowRunController } from './workflow-run.controller';

function ctx(
  role: string,
  handler: keyof WorkflowRunController,
): ExecutionContext {
  return {
    getHandler: () => WorkflowRunController.prototype[handler],
    getClass: () => WorkflowRunController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('WorkflowRunController authorization', () => {
  const guard = new RolesGuard(new Reflector());
  const handlers: Array<keyof WorkflowRunController> = [
    'list',
    'start',
    'get',
    'decide',
    'cancel',
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
});
