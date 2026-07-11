import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CurrentUser,
  assertStaffRole,
  resolveTenantId,
} from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { nextBestAction } from '../leads/next-best-action';

/**
 * Staff co-pilot: reviewable suggestions only — never auto-sends as the staff member.
 */
@Controller('copilot')
@UseGuards(RolesGuard)
export class CopilotController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF')
  @Get('conversations/:id')
  async conversationAssist(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    assertStaffRole(user);
    const tenantId = resolveTenantId(user);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 20 },
        leads: { take: 1, orderBy: { updatedAt: 'desc' } },
        escalations: { where: { status: 'OPEN' }, take: 3 },
      },
    });
    if (!conversation) return { error: 'NOT_FOUND' };

    const lead = conversation.leads[0] ?? null;
    const nba = lead
      ? nextBestAction({
          score: lead.score,
          interestedVin: lead.interestedVin,
          email: lead.email,
          phone: lead.phone,
          financingNeeded: lead.financingNeeded,
          stage: lead.stage,
        })
      : 'Review conversation and offer assistance';

    const recent = [...conversation.messages].reverse();
    const summaryLines = recent
      .slice(-8)
      .map((m) => `${m.role}: ${m.content.slice(0, 160)}`);

    return {
      conversationId: conversation.id,
      summary: summaryLines.join('\n'),
      recommendedReply:
        'Thanks for your patience — I can help confirm details with our team. What works best for a follow-up?',
      nextBestAction: nba,
      lead,
      openEscalations: conversation.escalations,
      reviewRequired: true,
      disclaimer:
        'AI suggestions are advisory. Staff must review before sending.',
    };
  }
}
