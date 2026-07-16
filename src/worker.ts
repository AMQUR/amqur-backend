/**
 * Dedicated worker process entry (outbox + future queue consumers).
 * Run: node dist/worker.js
 * Set PROCESS_ROLE=worker and OUTBOX_PROCESSOR_ENABLED=true.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { OutboxProcessorService } from './integrations/core/outbox-processor.service';

async function bootstrap() {
  process.env.PROCESS_ROLE = process.env.PROCESS_ROLE || 'worker';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const logger = new Logger('Worker');
  const processor = app.get(OutboxProcessorService);

  const intervalMs = Number(process.env.OUTBOX_POLL_MS || 15_000);
  logger.log(`Worker started; polling outbox every ${intervalMs}ms`);

  const tick = async () => {
    try {
      const n = await processor.processBatch();
      if (n > 0) logger.log(`Processed ${n} outbox event(s)`);
    } catch (err: unknown) {
      logger.error(
        `Outbox tick failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  };

  await tick();
  const handle = setInterval(tick, intervalMs);

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}; shutting down`);
    clearInterval(handle);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal worker bootstrap error', err);
  process.exit(1);
});
