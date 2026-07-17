import { Injectable } from '@nestjs/common';
import { ClaudeConversationService } from '../claude/claude-conversation.service';

@Injectable()
export class IntelligentService {
  constructor(private readonly claude: ClaudeConversationService) {}

  async answer(params: {
    question: string;
    context: string[];
  }): Promise<string> {
    return this.claude.answerIntelligentQuestion(params.question);
  }
}
