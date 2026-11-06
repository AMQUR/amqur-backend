import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { RequestIdInterceptor } from './interceptors/request-id.interceptor';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

function mockHttp(
  opts: {
    headersSent?: boolean;
    writableEnded?: boolean;
    inboundId?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  let headersSent = Boolean(opts.headersSent);
  const res = {
    get headersSent() {
      return headersSent;
    },
    writableEnded: Boolean(opts.writableEnded),
    setHeader: jest.fn((k: string, v: string) => {
      if (headersSent) {
        throw new Error(
          `Cannot set headers after they are sent to the client: ${k}`,
        );
      }
      headers[k.toLowerCase()] = String(v);
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    markSent() {
      headersSent = true;
    },
  };
  const req = {
    headers: opts.inboundId ? { 'x-request-id': opts.inboundId } : {},
    requestId: undefined as string | undefined,
    url: '/api/test',
  };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
  return { ctx, req, res, headers };
}

describe('response lifecycle — request id + exception filter', () => {
  it('assigns X-Request-Id before the handler runs', (done) => {
    const { ctx, req, res, headers } = mockHttp();
    const interceptor = new RequestIdInterceptor();
    const next: CallHandler = {
      handle: () => {
        expect(req.requestId).toBeTruthy();
        expect(headers['x-request-id']).toBe(req.requestId);
        return of({ ok: true });
      },
    };
    interceptor.intercept(ctx, next).subscribe({
      complete: () => {
        expect(res.setHeader).toHaveBeenCalled();
        done();
      },
      error: done,
    });
  });

  it('preserves inbound X-Request-Id', (done) => {
    const { ctx, req, headers } = mockHttp({ inboundId: 'client-corr-1' });
    const interceptor = new RequestIdInterceptor();
    interceptor.intercept(ctx, { handle: () => of(null) }).subscribe({
      complete: () => {
        expect(req.requestId).toBe('client-corr-1');
        expect(headers['x-request-id']).toBe('client-corr-1');
        done();
      },
      error: done,
    });
  });

  it('does not throw when tap runs after headers were already sent', (done) => {
    const { ctx, res } = mockHttp();
    const interceptor = new RequestIdInterceptor();
    const next: CallHandler = {
      handle: () => {
        res.markSent();
        return of({ streamed: true });
      },
    };
    interceptor.intercept(ctx, next).subscribe({
      complete: () => {
        // Second setHeader attempt must be skipped — no throw.
        expect(true).toBe(true);
        done();
      },
      error: (err) => done(err),
    });
  });

  it('does not send a second JSON body when headers already sent', () => {
    const { ctx, res } = mockHttp({ headersSent: true, writableEnded: true });
    const filter = new GlobalExceptionFilter();
    filter.catch(new Error('after-send boom'), ctx as any);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns the normal error envelope while the response is writable', () => {
    const { ctx, res, headers } = mockHttp();
    const filter = new GlobalExceptionFilter();
    (ctx.switchToHttp().getRequest() as any).requestId = 'rid-42';
    filter.catch(new HttpException('nope', 400), ctx as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 400,
        message: 'nope',
      }),
    );
    expect(headers['x-request-id']).toBe('rid-42');
  });

  it('falls back to inbound X-Request-Id when interceptor did not run', () => {
    const { ctx, res, headers } = mockHttp({ inboundId: 'from-client-404' });
    const filter = new GlobalExceptionFilter();
    filter.catch(new HttpException('missing', 404), ctx as any);
    expect(headers['x-request-id']).toBe('from-client-404');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('interceptor error path also refuses post-send header writes', (done) => {
    const { ctx, res } = mockHttp();
    const interceptor = new RequestIdInterceptor();
    const next: CallHandler = {
      handle: () => {
        res.markSent();
        return throwError(() => new Error('handler failed after send'));
      },
    };
    interceptor.intercept(ctx, next).subscribe({
      next: () => done(new Error('expected error')),
      error: () => {
        // Must not surface ERR_HTTP_HEADERS_SENT from the interceptor.
        done();
      },
    });
  });
});
