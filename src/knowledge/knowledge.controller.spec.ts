import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { KnowledgeController } from './knowledge.controller';
import type { KnowledgeEmbeddingService } from './knowledge-embedding.service';

function ctx(role: string): ExecutionContext {
  return {
    getHandler: () => KnowledgeController.prototype.reindexEmbeddings,
    getClass: () => KnowledgeController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('KnowledgeController embeddings reindex', () => {
  const guard = new RolesGuard(new Reflector());

  it('is denied to widget and ordinary staff', () => {
    expect(() => guard.canActivate(ctx('widget'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('STAFF'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx('MANAGER'))).toBe(true);
  });

  it('embeds only the JWT tenant', async () => {
    const embedPending = jest.fn().mockResolvedValue({ embedded: 0 });
    const controller = new KnowledgeController(
      {} as never,
      {} as never,
      { embedPending } as unknown as KnowledgeEmbeddingService,
    );
    const user: AuthUser = {
      sub: 'u1',
      tenantId: 'tenant-a',
      role: 'ADMIN',
    };
    await controller.reindexEmbeddings(user);
    expect(embedPending).toHaveBeenCalledWith('tenant-a', { limit: 200 });
  });
});
