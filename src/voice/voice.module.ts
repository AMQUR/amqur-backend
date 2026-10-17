import { Module } from '@nestjs/common';
import { CallQaController } from './call-qa.controller';
import { CallQaService } from './call-qa.service';
import { VoiceSessionService } from './voice-session.service';

/** Voice telephony — fail-closed until `voiceAi` + live-ready provider are authorized. */
@Module({
  controllers: [CallQaController],
  providers: [VoiceSessionService, CallQaService],
  exports: [VoiceSessionService, CallQaService],
})
export class VoiceModule {}
