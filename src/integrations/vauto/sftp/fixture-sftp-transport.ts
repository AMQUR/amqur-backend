import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { assertAllowedRemotePath } from '../dial-difference-feed-map';
import type {
  InventorySftpTransport,
  SftpDownloadedFile,
  SftpListedFile,
} from './sftp-transport';

/**
 * Local directory tree mirroring `/chevy/new/...` for unit/integration tests.
 * Never used as a customer-facing inventory source.
 */
export class FixtureSftpTransport implements InventorySftpTransport {
  constructor(private readonly rootDir: string) {}

  private localPath(remotePath: string): string {
    const safe = assertAllowedRemotePath(remotePath);
    return path.join(this.rootDir, safe.replace(/^\//, ''));
  }

  async list(remoteDir: string): Promise<SftpListedFile[]> {
    const dir = this.localPath(remoteDir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: SftpListedFile[] = [];
    for (const name of names) {
      if (name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('~'))
        continue;
      const full = path.join(dir, name);
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      out.push({
        name,
        remotePath: `${remoteDir.replace(/\/$/, '')}/${name}`,
        size: st.size,
        modifyTimeMs: st.mtimeMs,
      });
    }
    return out;
  }

  async download(
    remotePath: string,
    maxBytes: number,
  ): Promise<SftpDownloadedFile> {
    const full = this.localPath(remotePath);
    const st = await fs.stat(full);
    if (st.size > maxBytes) throw new Error('sftp_file_too_large');
    const body = await fs.readFile(full);
    return {
      remotePath,
      name: path.basename(remotePath),
      size: body.length,
      modifyTimeMs: st.mtimeMs,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
      body,
    };
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}
