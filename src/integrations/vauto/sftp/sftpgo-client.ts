import { createHash } from 'crypto';
import SftpClient from 'ssh2-sftp-client';
import { assertAllowedRemotePath } from '../dial-difference-feed-map';
import { hostKeyMatches, sshHostFingerprintSha256 } from './host-key';
import type {
  InventorySftpTransport,
  SftpDownloadedFile,
  SftpListedFile,
} from './sftp-transport';

export type SftpGoClientConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Required — connection refuses if the server key does not match. */
  hostFingerprintSha256: string;
  readyTimeoutMs?: number;
};

/**
 * Read-only SFTPGo client with strict host-key pinning.
 * Password is held only in memory for the connection lifetime; never logged.
 */
export class SftpGoClient implements InventorySftpTransport {
  private client: SftpClient | null = null;

  constructor(private readonly cfg: SftpGoClientConfig) {
    if (!cfg.hostFingerprintSha256?.trim()) {
      throw new Error('sftp_host_fingerprint_required');
    }
  }

  private async ensureConnected(): Promise<SftpClient> {
    if (this.client) return this.client;
    const client = new SftpClient();
    await client.connect({
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      password: this.cfg.password,
      readyTimeout: this.cfg.readyTimeoutMs ?? 20_000,
      // Fail closed on host-key mismatch — never accept a changed key silently.
      hostVerifier: (key: Buffer) => {
        const ok = hostKeyMatches(key, this.cfg.hostFingerprintSha256);
        if (!ok) {
          // Log fingerprint only (not the password).
          // eslint-disable-next-line no-console
          console.warn(
            `sftp_host_key_mismatch actual=${sshHostFingerprintSha256(key)}`,
          );
        }
        return ok;
      },
    });
    this.client = client;
    return client;
  }

  async list(remoteDir: string): Promise<SftpListedFile[]> {
    const dir = assertAllowedRemotePath(remoteDir);
    const client = await this.ensureConnected();
    const entries = await client.list(dir);
    return entries
      .filter((e) => e.type === '-' || e.type === 'l')
      .filter((e) => {
        const n = e.name;
        return (
          !n.startsWith('.') &&
          !n.endsWith('.tmp') &&
          !n.endsWith('.partial') &&
          !n.endsWith('~') &&
          !n.endsWith('.filepart')
        );
      })
      .map((e) => ({
        name: e.name,
        remotePath: `${dir.replace(/\/$/, '')}/${e.name}`,
        size: Number(e.size) || 0,
        modifyTimeMs: Number(e.modifyTime) || 0,
      }));
  }

  async download(
    remotePath: string,
    maxBytes: number,
  ): Promise<SftpDownloadedFile> {
    const safe = assertAllowedRemotePath(remotePath);
    const client = await this.ensureConnected();
    // Stable-size check: list then re-list after a short wait when size is changing.
    const parent = safe.slice(0, safe.lastIndexOf('/')) || '/';
    const name = safe.slice(safe.lastIndexOf('/') + 1);
    const before = (await client.list(parent)).find((e) => e.name === name);
    if (!before) throw new Error('sftp_file_missing');
    if (Number(before.size) > maxBytes) throw new Error('sftp_file_too_large');
    await new Promise((r) => setTimeout(r, 750));
    const after = (await client.list(parent)).find((e) => e.name === name);
    if (!after || Number(after.size) !== Number(before.size)) {
      throw new Error('sftp_partial_upload');
    }
    const buf = (await client.get(safe)) as Buffer;
    const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (body.length > maxBytes) throw new Error('sftp_file_too_large');
    return {
      remotePath: safe,
      name,
      size: body.length,
      modifyTimeMs: Number(after.modifyTime) || 0,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
      body,
    };
  }

  async dispose(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.end();
    } finally {
      this.client = null;
    }
  }
}
