import { createHash } from 'crypto';
import { hostKeyMatches, sshHostFingerprintSha256 } from './host-key';

describe('host-key pinning', () => {
  const key = Buffer.from('test-host-key-material');
  const fp = `SHA256:${createHash('sha256').update(key).digest('base64')}`;

  it('accepts matching SHA256 fingerprints including unpadded OpenSSH form', () => {
    expect(sshHostFingerprintSha256(key)).toBe(fp);
    expect(hostKeyMatches(key, fp)).toBe(true);
    expect(hostKeyMatches(key, fp.replace(/^SHA256:/, ''))).toBe(true);
    expect(hostKeyMatches(key, fp.replace(/=+$/, ''))).toBe(true);
  });

  it('rejects missing or mismatched fingerprints', () => {
    expect(hostKeyMatches(key, '')).toBe(false);
    expect(hostKeyMatches(key, null)).toBe(false);
    expect(hostKeyMatches(key, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(
      false,
    );
  });
});
