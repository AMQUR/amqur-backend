import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;

      const tenantId = (req as any).user?.tenantId ?? 'public';

      console.log(
        `${req.method} ${req.originalUrl} | tenant=${tenantId} | ${res.statusCode} | ${duration}ms`,
      );
    });

    next();
  }
}
