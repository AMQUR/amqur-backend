import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

function setRequestIdHeader(
  res: { headersSent?: boolean; setHeader: (k: string, v: string) => void },
  requestId: string,
): void {
  // Never rewrite headers after a manual send, redirect, download, or stream.
  if (res.headersSent) return;
  try {
    res.setHeader('X-Request-Id', requestId);
  } catch {
    // Race: headers finalized between the headersSent check and setHeader.
  }
}

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const requestId =
      (typeof req.headers['x-request-id'] === 'string' &&
        req.headers['x-request-id']) ||
      randomUUID();
    req.requestId = requestId;
    // Assign before controller execution so logs/handlers can use it.
    setRequestIdHeader(res, requestId);
    return next.handle().pipe(
      tap({
        next: () => setRequestIdHeader(res, requestId),
        error: () => setRequestIdHeader(res, requestId),
      }),
    );
  }
}
