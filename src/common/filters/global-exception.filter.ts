import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { captureError } from '../../observability/instrument';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object') {
        const r: any = res;
        message = r.message ?? message;
      }
    }

    if (!(exception instanceof HttpException)) {
      console.error('UNHANDLED ERROR:', exception);
      captureError(exception, { source: 'global-exception-filter' });
    } else if (status >= 500) {
      captureError(exception, { source: 'http-5xx' });
    }

    // Response already completed (manual @Res, redirect, stream, disconnect).
    // Capture the original error above; never send a second JSON body.
    if (response.headersSent || response.writableEnded) {
      console.error(
        'EXCEPTION_AFTER_HEADERS_SENT',
        JSON.stringify({
          path: request.url,
          requestId: request.requestId ?? null,
          statusAttempted: status,
        }),
      );
      return;
    }

    const requestId = request.requestId;
    if (requestId && !response.headersSent) {
      try {
        response.setHeader('X-Request-Id', requestId);
      } catch {
        /* ignore */
      }
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
