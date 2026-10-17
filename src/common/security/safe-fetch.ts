import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (
    v === '::1' ||
    v === '::' ||
    v.startsWith('fc') ||
    v.startsWith('fd') ||
    v.startsWith('fe80')
  )
    return true;
  const mapped = v.startsWith('::ffff:') ? v.slice(7) : v;
  if (isIP(mapped) === 4) {
    const [a, b] = mapped.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  return false;
}

/**
 * SSRF-hardened fetch for staff-initiated ingestion:
 *  - every hop's URL is re-validated by `validate` (scheme/host allowlist)
 *  - DNS is resolved and ALL addresses must be public (blocks rebinding to private ranges)
 *  - redirects are followed manually (max 3), never automatically
 *  - hard timeout and streamed size cap
 * Note: a resolver race between lookup and connect remains theoretically possible; egress
 * network policy at the platform layer is the second line of defense (docs/SECURITY_THREAT_MODEL.md).
 */
export async function safeFetchText(
  url: string,
  opts: {
    validate: (u: URL) => void;
    maxBytes: number;
    timeoutMs: number;
    userAgent: string;
    maxRedirects?: number;
  },
): Promise<{ finalUrl: string; text: string; contentType: string }> {
  let current = new URL(url);
  const deadline = Date.now() + opts.timeoutMs;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop += 1) {
    opts.validate(current);
    const host = current.hostname;
    const addrs = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      throw new BadRequestException(
        'Destination resolves to a private or reserved address',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, deadline - Date.now()),
    );
    try {
      const res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': opts.userAgent,
          Accept: 'text/html,text/plain',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new BadRequestException('Redirect without location');
        current = new URL(loc, current);
        continue;
      }
      if (!res.ok)
        throw new BadRequestException(`Fetch failed with HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/.test(contentType)) {
        throw new BadRequestException('Unsupported content type');
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > opts.maxBytes) {
            controller.abort();
            throw new BadRequestException('Page exceeds size limit');
          }
          chunks.push(value);
        }
      }
      return {
        finalUrl: current.toString(),
        text: Buffer.concat(chunks).toString('utf8'),
        contentType,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BadRequestException('Too many redirects');
}
