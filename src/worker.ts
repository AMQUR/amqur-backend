/**
 * Dedicated worker process entry (outbox + future queue consumers).
 * Run: node dist/worker.js
 * Set PROCESS_ROLE=worker and OUTBOX_PROCESSOR_ENABLED=true.
 *
 * Exposes a minimal liveness HTTP server so Railway healthchecks can pass
 * without mounting the full API surface.
 */
import 'reflect-metadata';
import './observability/instrument'; // error monitoring — must load first
import * as http from 'http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { OutboxProcessorService } from './integrations/core/outbox-processor.service';
import { MetaLeadsInboxProcessor } from './integrations/meta/meta-leads-inbox.processor';

async function bootstrap() {
  process.env.PROCESS_ROLE = process.env.PROCESS_ROLE || 'worker';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const logger = new Logger('Worker');
  const processor = app.get(OutboxProcessorService);
  const metaLeads = app.get(MetaLeadsInboxProcessor);

  const intervalMs = Number(process.env.OUTBOX_POLL_MS || 15_000);
  const metaLeadPollMs = Number(process.env.META_LEAD_INBOX_POLL_MS || 30_000);
  const metaLeadMaterializerOn =
    process.env.META_LEAD_MATERIALIZER_ENABLED !== 'false';
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health/live' || req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'worker' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  logger.log(
    `Worker started; liveness on :${port}; outbox poll ${intervalMs}ms`,
  );

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

  const metaTick = async () => {
    if (!metaLeadMaterializerOn) return;
    try {
      const n = await metaLeads.processBatch();
      if (n > 0) logger.log(`Materialized ${n} Meta lead inbox row(s)`);
    } catch (err: unknown) {
      logger.error(
        `Meta lead inbox tick failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  };

  await tick();
  if (metaLeadMaterializerOn) await metaTick();
  const handle = setInterval(tick, intervalMs);
  const metaHandle = metaLeadMaterializerOn
    ? setInterval(metaTick, metaLeadPollMs)
    : null;

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}; shutting down`);
    clearInterval(handle);
    if (metaHandle) clearInterval(metaHandle);
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
