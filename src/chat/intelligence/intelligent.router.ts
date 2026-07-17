import { Injectable } from '@nestjs/common';
import { ChatIntent } from '../intents/intent.types';

@Injectable()
export class IntelligentRouter {
  shouldRoute(intent: ChatIntent): boolean {
    return intent === ChatIntent.INTELLIGENT_QUERY;
  }
}
