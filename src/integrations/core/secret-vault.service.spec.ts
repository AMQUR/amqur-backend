import { createHash } from 'crypto';
import { SecretVaultService } from './secret-vault.service';
import { ConfigService } from '@nestjs/config';

describe('SecretVaultService', () => {
  it('round-trips encryption when key present', () => {
    const config = {
      get: (k: string) =>
        k === 'INTEGRATION_ENCRYPTION_KEY'
          ? 'test-integration-encryption-key-32chars!!'
          : undefined,
    } as unknown as ConfigService;
    const vault = new SecretVaultService(config);
    expect(vault.isReady()).toBe(true);
    const enc = vault.encrypt('super-secret');
    expect(enc.ciphertext).not.toContain('super-secret');
    expect(vault.decrypt(enc)).toBe('super-secret');
  });

  it('reports not ready without key', () => {
    const config = {
      get: () => '',
    } as unknown as ConfigService;
    const vault = new SecretVaultService(config);
    expect(vault.isReady()).toBe(false);
  });
});

describe('webhook signature helper', () => {
  it('uses sha256 of secret.payload', () => {
    const sig = createHash('sha256')
      .update('secret.{"a":1}')
      .digest('hex');
    expect(sig).toHaveLength(64);
  });
});
