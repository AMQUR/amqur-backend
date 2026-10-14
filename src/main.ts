import 'reflect-metadata';
import './observability/instrument'; // error monitoring — must load first
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const logger = new Logger('Bootstrap');

  // Behind Railway's edge proxy: without this, req.ip is the (varying)
  // edge hop, which breaks rate-limit buckets (every request looks like a
  // new client) and audit logging. First X-Forwarded-For hop = real client.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new ResponseInterceptor(),
  );

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin:
      corsOrigins.length > 0
        ? corsOrigins
        : process.env.NODE_ENV === 'production'
          ? false
          : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  // AMQUR Command Center (staff app) — static, same-origin, strict CSP, never indexed.
  const ccDist = join(__dirname, '..', 'command-center', 'dist');
  if (existsSync(ccDist)) {
    app.use(
      '/cc',
      (
        _req: unknown,
        res: { setHeader: (k: string, v: string) => void },
        next: () => void,
      ) => {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
        );
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader(
          'Permissions-Policy',
          'camera=(), microphone=(), geolocation=()',
        );
        next();
      },
    );
    app.useStaticAssets(ccDist, {
      prefix: '/cc/',
      index: 'index.html',
      maxAge: '1h',
      setHeaders: (res, path) => {
        if (path.endsWith('index.html'))
          res.setHeader('Cache-Control', 'no-store');
        else if (path.includes('/assets/'))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    logger.log('Command Center served at /cc/');
  }

  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  logger.log(`API listening on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
