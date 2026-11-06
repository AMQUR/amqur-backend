import { SecurityHeadersMiddleware } from './security-headers.middleware';

describe('SecurityHeadersMiddleware', () => {
  it('sets baseline security headers without inventing CSP', () => {
    const mw = new SecurityHeadersMiddleware();
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
    };
    let nextCalled = false;
    mw.use({} as never, res as never, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });
});
