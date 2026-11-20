import { createHash } from 'crypto';

/**
 * Compare an SSH host public key buffer to a configured SHA256 fingerprint.
 * Accepts `SHA256:base64` (OpenSSH) or bare base64 / hex digests.
 */
export function sshHostFingerprintSha256(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64')}`;
}

function normalizeFp(fp: string): string {
  // OpenSSH often prints SHA256 fingerprints without base64 padding `=`.
  const body = fp
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
  return `SHA256:${body}`;
}

export function hostKeyMatches(
  hostKey: Buffer,
  expected: string | undefined | null,
): boolean {
  if (!expected || !expected.trim()) return false;
  return (
    normalizeFp(sshHostFingerprintSha256(hostKey)) === normalizeFp(expected)
  );
}
