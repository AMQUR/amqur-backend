import { BadRequestException } from '@nestjs/common';
import { isIP } from 'net';

/**
 * SSRF protection for inventory feed URLs.
 * Only https (or http in development) to allowlisted hosts.
 * Blocks private/link-local IPs and metadata endpoints.
 */
export function assertFeedUrlAllowed(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid feed URL');
  }

  const allowHttp = process.env.NODE_ENV !== 'production';
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new BadRequestException('Feed URL must use HTTPS');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new BadRequestException('Feed URL host is not allowed');
  }

  if (isIP(host)) {
    if (
      host.startsWith('10.') ||
      host.startsWith('127.') ||
      host.startsWith('169.254.') ||
      host.startsWith('0.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      /^192\.168\./.test(host) ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80')
    ) {
      throw new BadRequestException('Feed URL must not target private networks');
    }
  }

  const allowlistRaw = process.env.INVENTORY_FEED_ALLOWED_HOSTS ?? '';
  const allowlist = allowlistRaw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (allowlist.length > 0 && !allowlist.includes(host)) {
    throw new BadRequestException(
      `Feed host "${host}" is not in INVENTORY_FEED_ALLOWED_HOSTS`,
    );
  }

  return parsed;
}
