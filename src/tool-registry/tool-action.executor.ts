import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, ToolActionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  OutboxProcessorService,
  PermanentOutboxError,
} from '../integrations/core/outbox-processor.service';
import { TOOL_ACTION_TOPIC } from './tool-action.service';

/**
 * Dispatches APPROVED actions to the MOCK provider. It never calls a real CRM, SMS or email
 * system. An action that is not APPROVED is never executed, and replays are no-ops.
 */
@Injectable()
export class ToolActionExecutor implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: OutboxProcessorService,
  ) {}

  onModuleInit() {
    this.processor.registerHandler(TOOL_ACTION_TOPIC, (p, m) =>
      this.execute(p, m.tenantId),
    );
  }

  async execute(payload: Record<string, unknown>, tenantId: string) {
    const id = typeof payload.actionId === 'string' ? payload.actionId : null;
    if (!id) throw new PermanentOutboxError('missing_action_id');
    const row = await this.prisma.toolActionRequest.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new PermanentOutboxError('action_not_found');
    if (row.status === ToolActionStatus.EXECUTED)
      return { note: 'already_executed' };
    if (row.status !== ToolActionStatus.APPROVED)
      throw new PermanentOutboxError(`not_approved_${row.status}`);
    const result = { mock: true, tool: row.toolName, executedAt: new Date() };
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.toolActionRequest.updateMany({
        where: { id, tenantId, status: ToolActionStatus.APPROVED },
        data: {
          status: ToolActionStatus.EXECUTED,
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
      if (claimed.count !== 1) return;
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'tool.action.executed.mock',
          resource: 'ToolActionRequest',
          resourceId: id,
          metadata: { tool: row.toolName, mock: true },
        },
      });
    });
    return { note: 'mock_executed' };
  }
}
