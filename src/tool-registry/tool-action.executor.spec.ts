import { ToolActionExecutor } from './tool-action.executor';
import { PermanentOutboxError } from '../integrations/core/outbox-processor.service';

function setup(row: Record<string, unknown> | null) {
  const tx = {
    toolActionRequest: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    toolActionRequest: { findFirst: jest.fn().mockResolvedValue(row) },
    $transaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
  };
  const processor = { registerHandler: jest.fn() };
  const ex = new ToolActionExecutor(prisma as never, processor as never);
  return { ex, tx, prisma, processor };
}

describe('ToolActionExecutor (mock provider)', () => {
  it('registers its topic handler on init', () => {
    const { ex, processor } = setup(null);
    ex.onModuleInit();
    expect(processor.registerHandler).toHaveBeenCalledWith(
      'tool.action.mock',
      expect.any(Function),
    );
  });

  it('executes only APPROVED actions, scoped to the event tenant', async () => {
    const { ex, tx, prisma } = setup({
      id: 'a1',
      status: 'APPROVED',
      toolName: 'crm.note.add',
    });
    await ex.execute({ actionId: 'a1' }, 't1');
    expect(prisma.toolActionRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1', tenantId: 't1' },
    });
    expect(tx.toolActionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a1', tenantId: 't1', status: 'APPROVED' },
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it.each(['PENDING_APPROVAL', 'DENIED', 'EXPIRED', 'CANCELLED'])(
    'never executes a %s action',
    async (status) => {
      const { ex, tx } = setup({ id: 'a1', status, toolName: 'x' });
      await expect(ex.execute({ actionId: 'a1' }, 't1')).rejects.toThrow(
        PermanentOutboxError,
      );
      expect(tx.toolActionRequest.updateMany).not.toHaveBeenCalled();
    },
  );

  it('is idempotent on replay and rejects bad payloads or other tenants', async () => {
    const done = setup({ id: 'a1', status: 'EXECUTED', toolName: 'x' });
    expect(await done.ex.execute({ actionId: 'a1' }, 't1')).toEqual({
      note: 'already_executed',
    });
    expect(done.tx.toolActionRequest.updateMany).not.toHaveBeenCalled();
    const missing = setup(null);
    await expect(
      missing.ex.execute({ actionId: 'a1' }, 'other'),
    ).rejects.toThrow(PermanentOutboxError);
    await expect(missing.ex.execute({}, 't1')).rejects.toThrow(
      PermanentOutboxError,
    );
  });
});
