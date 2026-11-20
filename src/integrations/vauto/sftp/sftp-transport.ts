export type SftpListedFile = {
  name: string;
  remotePath: string;
  size: number;
  modifyTimeMs: number;
};

export type SftpDownloadedFile = {
  remotePath: string;
  name: string;
  size: number;
  modifyTimeMs: number;
  checksumSha256: string;
  body: Buffer;
};

/**
 * Read-only remote file access. Production uses SFTPGo; tests use an in-memory/fixture transport.
 * Never exposes credentials.
 */
export interface InventorySftpTransport {
  list(remoteDir: string): Promise<SftpListedFile[]>;
  download(remotePath: string, maxBytes: number): Promise<SftpDownloadedFile>;
  dispose(): Promise<void>;
}
