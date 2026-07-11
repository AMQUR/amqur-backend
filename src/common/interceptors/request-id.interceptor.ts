import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

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
    res.setHeader('X-Request-Id', requestId);
    return next.handle().pipe(
      tap(() => {
        res.setHeader('X-Request-Id', requestId);
      }),
    );
  }
}
