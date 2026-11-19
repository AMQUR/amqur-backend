import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import { isRawResponse } from '../decorators/raw-response.decorator';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    // Streaming handlers own the socket: no JSON envelope.
    if (isRawResponse(context.getHandler())) return next.handle();
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();
    const statusCode = response.statusCode;

    return next.handle().pipe(
      map((data) => ({
        success: true,
        statusCode,
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
