import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  CANARY_COOKIE_NAME,
  CanaryAuthService,
  type CanarySessionClaims,
} from './canary-auth.service';

const JEEP_WWW = 'https://www.jeepofchicago.com';
const JEEP_APEX = 'https://jeepofchicago.com';
const SECRET = 'test-canary-secret-at-least-32-chars!!';

describe('CanaryAuthService secure employee gate', () => {
  const tenant = {
    id: 'tenant-1',
    slug: 'dial-auto-group',
    allowedOrigins: `${JEEP_WWW},${JEEP_APEX}`,
  };
  const location = {
    id: 'loc-1',
    slug: 'jeep-of-chicago',
    tenantId: 'tenant-1',
  };

  let invites: Record<string, any>;
  let prisma: any;
  let jwt: any;
  let config: any;
  let svc: CanaryAuthService;

  beforeEach(() => {
    invites = {};
    prisma = {
      tenant: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.slug === tenant.slug || where.id === tenant.id)
            return tenant;
          return null;
        }),
      },
      location: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (
            (where.slug === location.slug || where.id === location.id) &&
            where.tenantId === tenant.id
          ) {
            return location;
          }
          return null;
        }),
      },
      canaryInvite: {
        create: jest.fn(async ({ data }: any) => {
          invites[data.jti] = { id: `id-${data.jti}`, ...data };
          return invites[data.jti];
        }),
        findUnique: jest.fn(
          async ({ where }: any) => invites[where.jti] ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const row = Object.values(invites).find(
            (i: any) => i.id === where.id || i.jti === where.jti,
          );
          Object.assign(row, data);
          return row;
        }),
      },
      auditLog: {
        create: jest.fn(async () => ({ id: 'audit-1' })),
      },
    };

    const store: Record<string, { payload: any; expMs: number }> = {};
    jwt = {
      sign: jest.fn(
        (payload: any, opts: { secret: string; expiresIn: number }) => {
          const token = `signed.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${opts.expiresIn}`;
          store[token] = {
            payload,
            expMs: Date.now() + opts.expiresIn * 1000,
          };
          return token;
        },
      ),
      verify: jest.fn((token: string, opts: { secret: string }) => {
        if (opts.secret !== SECRET) throw new Error('bad secret');
        const row = store[token];
        if (!row) throw new Error('unknown');
        if (row.expMs < Date.now()) throw new Error('expired');
        return row.payload;
      }),
    };

    config = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          CANARY_EMPLOYEE_ENABLED: 'true',
          CANARY_EMPLOYEE_SECRET: SECRET,
          CANARY_ENVIRONMENT: 'staging',
          CANARY_SESSION_EXPIRES_IN: '2h',
          CANARY_INVITE_EXPIRES_IN: '15m',
          NODE_ENV: 'test',
        };
        return map[key];
      }),
      getOrThrow: jest.fn(() => SECRET),
    };

    svc = new CanaryAuthService(prisma, jwt, config);
  });

  async function issueAndRedeem(origin = JEEP_WWW) {
    const issued = await svc.issueInvite({
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
      testerLabel: 'qa@amqur.internal',
    });
    return svc.redeemInvite(issued.inviteToken, origin);
  }

  it('authorized employee + approved Jeep origin succeeds', async () => {
    const { cookieValue, claims } = await issueAndRedeem(JEEP_WWW);
    const cookieHeader = `${CANARY_COOKIE_NAME}=${cookieValue}`;
    const result = await svc.checkEligibility({
      cookieHeader,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(true);
    expect(claims.env).toBe('staging');
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls.map(
      (c: any) => c[0].data,
    );
    for (const a of auditArgs) {
      expect(JSON.stringify(a)).not.toMatch(/inviteToken|cookieValue|signed\./);
    }
  });

  it('previously redeemed invitation cannot be reused', async () => {
    const issued = await svc.issueInvite({
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    await svc.redeemInvite(issued.inviteToken, JEEP_WWW);
    await expect(
      svc.redeemInvite(issued.inviteToken, JEEP_WWW),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no employee authorization + approved Jeep origin fails', async () => {
    const result = await svc.checkEligibility({
      cookieHeader: null,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result).toEqual({ eligible: false, reason: 'missing_credential' });
  });

  it('forged cookie fails', async () => {
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=forged.not.real`,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('invalid_or_expired');
  });

  it('expired token fails', async () => {
    jwt.verify.mockImplementationOnce(() => {
      throw new Error('jwt expired');
    });
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=any.token.value`,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('invalid_or_expired');
  });

  it('wrong tenant fails', async () => {
    const { cookieValue } = await issueAndRedeem();
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=${cookieValue}`,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'other-tenant',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('tenant_or_rooftop_mismatch');
  });

  it('wrong rooftop fails', async () => {
    const { cookieValue } = await issueAndRedeem();
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=${cookieValue}`,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'wrong-rooftop',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('tenant_or_rooftop_mismatch');
  });

  it('wrong environment fails', async () => {
    const { cookieValue } = await issueAndRedeem();
    // Mutate verify to return wrong env by signing a tampered payload with secret
    const bad: CanarySessionClaims = {
      typ: 'canary_emp',
      jti: 'x',
      tenantId: tenant.id,
      locationId: location.id,
      tenantSlug: tenant.slug,
      locationSlug: location.slug,
      env: 'production',
    };
    const token = jwt.sign(bad, { secret: SECRET, expiresIn: 3600 });
    void cookieValue;
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=${token}`,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('environment_mismatch');
  });

  it('unknown origin fails', async () => {
    await expect(issueAndRedeem('https://evil.example')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const { cookieValue } = await issueAndRedeem(JEEP_WWW);
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=${cookieValue}`,
      requestOrigin: 'https://evil.example',
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('origin_rejected');
  });

  it('missing Origin fails closed', async () => {
    await expect(issueAndRedeem(null as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const { cookieValue } = await issueAndRedeem(JEEP_WWW);
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=${cookieValue}`,
      requestOrigin: null,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('origin_rejected');
  });

  it('revoked canary (master kill switch) fails', async () => {
    const { cookieValue } = await issueAndRedeem();
    config.get.mockImplementation((key: string) => {
      if (key === 'CANARY_EMPLOYEE_ENABLED') return 'false';
      const map: Record<string, string> = {
        CANARY_EMPLOYEE_SECRET: SECRET,
        CANARY_ENVIRONMENT: 'staging',
        CANARY_SESSION_EXPIRES_IN: '2h',
        CANARY_INVITE_EXPIRES_IN: '15m',
      };
      return map[key];
    });
    const result = await svc.checkEligibility({
      cookieHeader: `${CANARY_COOKIE_NAME}=${cookieValue}`,
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result).toEqual({ eligible: false, reason: 'canary_disabled' });
  });

  it('revoked invite cannot be redeemed', async () => {
    const issued = await svc.issueInvite({
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    await svc.revokeInvite(issued.jti);
    await expect(
      svc.redeemInvite(issued.inviteToken, JEEP_WWW),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('amqur_emp=1 cookie alone is not accepted as canary credential', async () => {
    const result = await svc.checkEligibility({
      cookieHeader: 'amqur_emp=1',
      requestOrigin: JEEP_WWW,
      tenantSlug: 'dial-auto-group',
      locationSlug: 'jeep-of-chicago',
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('missing_credential');
  });

  it('buildSetCookieHeader is HttpOnly Secure SameSite=None', () => {
    const h = svc.buildSetCookieHeader('tok', 120);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('Secure');
    expect(h).toContain('SameSite=None');
    expect(h).toContain(`${CANARY_COOKIE_NAME}=tok`);
  });

  it('rejects issue when master disabled', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'CANARY_EMPLOYEE_ENABLED' ? 'false' : SECRET,
    );
    await expect(
      svc.issueInvite({
        tenantSlug: 'dial-auto-group',
        locationSlug: 'jeep-of-chicago',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects unknown tenant on issue', async () => {
    await expect(
      svc.issueInvite({
        tenantSlug: 'nope',
        locationSlug: 'jeep-of-chicago',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
