import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import {
  createE2eApp,
  E2eCtx,
  seedTwoTenants,
  unwrap,
} from '../helpers/e2e-app';
import { totp } from '../../src/auth/totp';

describe('staff MFA (TOTP) end-to-end', () => {
  let ctx: E2eCtx;
  const email = 'mfa-admin@pilot-alpha.test';
  const password = 'MfaAdminPass123!';
  const api = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createE2eApp();
    const seed = await seedTwoTenants(ctx.prisma);
    const hash = await bcrypt.hash(password, 10);
    await ctx.prisma.user.upsert({
      where: { tenantId_email: { tenantId: seed.alpha.tenant.id, email } },
      create: {
        tenantId: seed.alpha.tenant.id,
        email,
        password: hash,
        firstName: 'Mfa',
        lastName: 'Admin',
        role: Role.ADMIN,
      },
      update: {
        password: hash,
        mfaEnabled: false,
        mfaSecretEnc: undefined,
        mfaRecoveryHashes: [],
        mfaLastCounter: null,
      },
    });
  });
  afterAll(async () => ctx.app.close());

  it('enroll → challenge login → replay rejected → recovery code single use → logout-all', async () => {
    const l1 = unwrap<{ access_token: string; refresh_token: string }>(
      (await api().post('/api/auth/login').send({ email, password })).body,
    );
    expect(l1.access_token).toBeTruthy();
    const setup = unwrap<{ secret: string; otpauthUri: string }>(
      (
        await api()
          .post('/api/auth/mfa/setup')
          .set('Authorization', `Bearer ${l1.access_token}`)
      ).body,
    );
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(
      (
        await api()
          .post('/api/auth/mfa/confirm')
          .set('Authorization', `Bearer ${l1.access_token}`)
          .send({ code: '000000' })
      ).status,
    ).toBe(401);
    const confirm = unwrap<{ enabled: boolean; recoveryCodes: string[] }>(
      (
        await api()
          .post('/api/auth/mfa/confirm')
          .set('Authorization', `Bearer ${l1.access_token}`)
          .send({ code: totp(setup.secret) })
      ).body,
    );
    expect(confirm.enabled).toBe(true);
    expect(confirm.recoveryCodes).toHaveLength(8);
    const row = await ctx.prisma.user.findFirstOrThrow({ where: { email } });
    expect(JSON.stringify(row.mfaSecretEnc)).not.toContain(setup.secret); // encrypted at rest

    // password alone no longer yields tokens
    const l2 = unwrap<{
      mfa_required?: boolean;
      mfa_token?: string;
      access_token?: string;
    }>((await api().post('/api/auth/login').send({ email, password })).body);
    expect(l2.mfa_required).toBe(true);
    expect(l2.access_token).toBeUndefined();
    // the challenge token is not an API credential
    expect(
      (
        await api()
          .get('/api/ops/overview')
          .set('Authorization', `Bearer ${l2.mfa_token}`)
      ).status,
    ).toBe(401);
    // the code used during enrollment cannot be replayed
    const replay = await api()
      .post('/api/auth/mfa/verify')
      .send({ mfa_token: l2.mfa_token, code: totp(setup.secret) });
    expect(replay.status).toBe(401);
    // a recovery code works exactly once
    const rc = confirm.recoveryCodes[0];
    const ok = unwrap<{ access_token: string }>(
      (
        await api()
          .post('/api/auth/mfa/verify')
          .send({ mfa_token: l2.mfa_token, code: rc })
      ).body,
    );
    expect(ok.access_token).toBeTruthy();
    expect(
      (
        await api()
          .get('/api/ops/overview')
          .set('Authorization', `Bearer ${ok.access_token}`)
      ).status,
    ).toBe(200);
    const l3 = unwrap<{ mfa_token: string }>(
      (await api().post('/api/auth/login').send({ email, password })).body,
    );
    expect(
      (
        await api()
          .post('/api/auth/mfa/verify')
          .send({ mfa_token: l3.mfa_token, code: rc })
      ).status,
    ).toBe(401);

    const out = unwrap<{ revokedSessions: number }>(
      (
        await api()
          .post('/api/auth/logout-all')
          .set('Authorization', `Bearer ${ok.access_token}`)
      ).body,
    );
    expect(out.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(
      (
        await api()
          .post('/api/auth/refresh')
          .send({ refresh_token: l1.refresh_token })
      ).status,
    ).toBe(401);
  });
});
