import * as path from 'path';
import { FixtureSftpTransport } from './fixture-sftp-transport';

const ROOT = path.join(
  __dirname,
  '../../../../fixtures/vauto/dial-difference-sftp',
);

describe('FixtureSftpTransport', () => {
  const transport = new FixtureSftpTransport(ROOT);

  it('lists jeep_north/new inventory and downloads with checksum', async () => {
    const listed = await transport.list('/jeep_north/new');
    expect(listed.some((f) => f.name === 'inventory.xml')).toBe(true);
    const file = await transport.download(
      '/jeep_north/new/inventory.xml',
      5_000_000,
    );
    expect(file.size).toBeGreaterThan(100);
    expect(file.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.body.toString('utf8')).toContain('1C4HJXDG0FW000001');
  });

  it('keeps cdjr_south used stock separate from jeep_north', async () => {
    const south = await transport.download(
      '/cdjr_south/used/inventory.xml',
      5_000_000,
    );
    expect(south.body.toString('utf8')).toContain('1C6SRFFT0MN000101');
    expect(south.body.toString('utf8')).not.toContain('1C4HJXDG0FW000001');
  });

  it('rejects paths outside the allowlist', async () => {
    await expect(transport.list('/tmp')).rejects.toThrow(
      /sftp_path_not_in_allowlist/,
    );
  });
});
