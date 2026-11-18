import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { WorkflowLabController } from './workflow-lab.controller';
import { WorkflowPreviewService } from './workflow-preview.service';

function roleContext(role: string): ExecutionContext {
  return {
    getHandler: () => WorkflowLabController.prototype.preview,
    getClass: () => WorkflowLabController,
    switchToHttp: () => ({
      getRequest: () => ({ user: { role } }),
    }),
  } as unknown as ExecutionContext;
}

describe('WorkflowLabController authorization', () => {
  const roles = new RolesGuard(new Reflector());

  it('rejects customer widget and ordinary staff from staff-only preview', () => {
    expect(() => roles.canActivate(roleContext('widget'))).toThrow(
      ForbiddenException,
    );
    expect(() => roles.canActivate(roleContext('STAFF'))).toThrow(
      ForbiddenException,
    );
    expect(roles.canActivate(roleContext('MANAGER'))).toBe(true);
  });

  it('denies a location-bound manager requesting a different rooftop', () => {
    const preview = jest.fn().mockResolvedValue({ mode: 'preview' });
    const controller = new WorkflowLabController({
      preview,
    } as unknown as WorkflowPreviewService);
    const manager: AuthUser = {
      sub: 'employee-1',
      tenantId: 'tenant-a',
      role: 'MANAGER',
      locationId: 'rooftop-a',
    };
    expect(() =>
      controller.preview(manager, {
        graph: {},
        query: 'warranty',
        locationId: 'rooftop-b',
      }),
    ).toThrow(ForbiddenException);
    expect(preview).not.toHaveBeenCalled();
  });

  it('uses trusted JWT tenant and authorized rooftop context', () => {
    const preview = jest.fn().mockResolvedValue({ mode: 'preview' });
    const controller = new WorkflowLabController({
      preview,
    } as unknown as WorkflowPreviewService);
    const manager: AuthUser = {
      sub: 'employee-1',
      tenantId: 'tenant-a',
      role: 'MANAGER',
      locationId: 'rooftop-a',
    };
    const graph = { version: 1, nodes: [] };
    controller.preview(manager, { graph, query: 'service' });
    expect(preview).toHaveBeenCalledWith(graph, {
      tenantId: 'tenant-a',
      locationId: 'rooftop-a',
      query: 'service',
    });
  });
});
