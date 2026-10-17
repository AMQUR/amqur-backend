import { Module } from '@nestjs/common';
import { VoiceSessionService } from './voice-session.service';

/** Voice telephony — fail-closed until `voiceAi` + live-ready provider are authorized. */
@Module({
  providers: [VoiceSessionService],
  exports: [VoiceSessionService],
})
export class VoiceModule {}
