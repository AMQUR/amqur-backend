#!/usr/bin/env node
/**
 * Staging-only, read-only Dial Difference vAuto SFTP diagnostic.
 *
 * Runs inside the Railway worker (or any host with the same env).
 * Does NOT enable AMQUR_VAUTO_SFTP_ENABLED / INVENTORY_SYNC_ENABLED /
 * AMQUR_VAUTO_PUBLISH_*. Never uploads, deletes, or imports.
 *
 * Usage (on worker-staging):
 *   AMQUR_SFTP_DIAGNOSTIC=1 node scripts/diagnose-vauto-sftp-readonly.mjs
 *
 * Password and raw CSV bodies are never printed.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const DIAG_VERSION = '1.1.0-20261120';
// Resolve deps from app root so /tmp copies still work on Railway SSH.
const require = createRequire(
  pathToFileURL(join(process.cwd(), 'package.json')).href,
);

const FEEDS = [
  {
    store: 'Dial Chevy of Chicago',
    feed: 'New',
    feedSourceKey: 'chevy/new',
    remoteDir: '/chevy/new',
  },
  {
    store: 'Dial Chevy of Chicago',
    feed: 'Used',
    feedSourceKey: 'chevy/used',
    remoteDir: '/chevy/used',
  },
  {
    store: 'Dial Nissan of Chicago',
    feed: 'New',
    feedSourceKey: 'nissan/new',
    remoteDir: '/nissan/new',
  },
  {
    store: 'Dial Nissan of Chicago',
    feed: 'Used',
    feedSourceKey: 'nissan/used',
    remoteDir: '/nissan/used',
  },
  {
    store: 'INFINITI of Chicago',
    feed: 'New',
    feedSourceKey: 'infiniti/new',
    remoteDir: '/infiniti/new',
  },
  {
    store: 'INFINITI of Chicago',
    feed: 'Used',
    feedSourceKey: 'infiniti/used',
    remoteDir: '/infiniti/used',
  },
  {
    store: 'Dial CDJR South',
    feed: 'New',
    feedSourceKey: 'cdjr_south/new',
    remoteDir: '/cdjr_south/new',
  },
  {
    store: 'Dial CDJR South',
    feed: 'Used',
    feedSourceKey: 'cdjr_south/used',
    remoteDir: '/cdjr_south/used',
  },
  {
    store: 'Jeep of Chicago North',
    feed: 'New',
    feedSourceKey: 'jeep_north/new',
    remoteDir: '/jeep_north/new',
  },
  {
    store: 'Jeep of Chicago North',
    feed: 'Used',
    feedSourceKey: 'jeep_north/used',
    remoteDir: '/jeep_north/used',
  },
];

const ALLOWED_DIRS = new Set(FEEDS.map((f) => f.remoteDir));
const MAX_LIST = 200;
const PEEK_BYTES = 8 * 1024;
const MAX_PEEK_FILES = 1;
const READY_TIMEOUT_MS = 20_000;

function normalizeFp(fp) {
  const body = String(fp || '')
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
  return `SHA256:${body}`;
}

function sshHostFingerprintSha256(hostKey) {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64')}`;
}

function hostKeyMatches(hostKey, expected) {
  if (!expected || !String(expected).trim()) return false;
  return (
    normalizeFp(sshHostFingerprintSha256(hostKey)) === normalizeFp(expected)
  );
}

function assertAllowedDir(remoteDir) {
  const normalized = String(remoteDir || '').replace(/\\/g, '/');
  if (
    normalized.includes('..') ||
    normalized.includes('\0') ||
    !normalized.startsWith('/') ||
    !ALLOWED_DIRS.has(normalized)
  ) {
    throw new Error('sftp_path_not_in_allowlist');
  }
  return normalized;
}

function flagValue(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function flagIsFalse(name) {
  return flagValue(name) === 'false';
}

function readGitSha() {
  try {
    if (existsSync('/app/release.json')) {
      const j = JSON.parse(readFileSync('/app/release.json', 'utf8'));
      if (j.commitSha) return String(j.commitSha);
    }
  } catch {
    /* ignore */
  }
  return process.env.APP_COMMIT_SHA || 'unknown';
}

function detectFormat(filename, headUtf8) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.xml')) return 'XML';
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return 'CSV';
  const head = String(headUtf8 || '').trimStart();
  if (head.startsWith('<')) return 'XML';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  if (head.includes(',') && /vin/i.test(head.slice(0, 200))) return 'CSV';
  return 'UNKNOWN';
}

function looksLikeVAutoExport(filename, format, headUtf8) {
  const name = String(filename || '').toLowerCase();
  const head = String(headUtf8 || '');
  if (format === 'CSV' && /vin/i.test(head.slice(0, 400))) return true;
  if (format === 'XML' && /<(vehicle|inventory|Item)/i.test(head.slice(0, 800)))
    return true;
  if (/\.(csv|txt|xml)$/i.test(name) && format !== 'UNKNOWN') return true;
  return false;
}

function classifyFeed({ listingOk, fileCount, format, validation, errorCode }) {
  if (errorCode === 'HOST_KEY_BLOCKED' || errorCode === 'sftp_host_key_mismatch')
    return 'HOST_KEY_BLOCKED';
  if (errorCode === 'AUTH_FAILED' || /auth|password|permission denied/i.test(String(errorCode)))
    return 'AUTH_FAILED';
  if (errorCode === 'ACCESS_DENIED' || /permission|denied|forbidden/i.test(String(errorCode)))
    return 'ACCESS_DENIED';
  if (errorCode === 'PATH_MISSING' || /no such file|ENOENT|not found/i.test(String(errorCode)))
    return 'PATH_MISSING';
  if (!listingOk && errorCode) return 'UNKNOWN';
  if (listingOk && fileCount === 0) return 'EMPTY';
  if (listingOk && fileCount > 0) {
    if (validation === 'SCHEMA_MISMATCH') return 'SCHEMA_MISMATCH';
    if (validation === 'INVALID_FILE') return 'INVALID_FILE';
    if (validation === 'VALID_CANDIDATE' || format === 'CSV' || format === 'XML')
      return 'REAL_FEED_VERIFIED';
    if (validation === 'PEEK_SKIPPED') return 'PARTIAL_FEED';
    return 'PARTIAL_FEED';
  }
  return 'NOT_RECEIVED';
}

function gateOrExit() {
  const explicit = process.env.AMQUR_SFTP_DIAGNOSTIC === '1';
  const staging =
    process.env.RAILWAY_ENVIRONMENT_NAME === 'staging' ||
    process.env.RAILWAY_ENVIRONMENT === 'staging' ||
    process.env.APP_DEPLOYMENT_TIER === 'staging';
  const worker = process.env.PROCESS_ROLE === 'worker';
  if (!explicit && !(staging && worker)) {
    console.error(
      JSON.stringify({
        ok: false,
        error: 'RUNTIME_BLOCKED',
        detail:
          'Refuse to run unless AMQUR_SFTP_DIAGNOSTIC=1 or (staging worker).',
      }),
    );
    process.exit(2);
  }

  const unsafe = [
    'AMQUR_VAUTO_SFTP_ENABLED',
    'INVENTORY_SYNC_ENABLED',
    'AMQUR_VAUTO_PUBLISH_PRICES',
    'AMQUR_VAUTO_PUBLISH_PHOTOS',
  ].filter((k) => !flagIsFalse(k));

  if (unsafe.length) {
    console.error(
      JSON.stringify({
        ok: false,
        error: 'UNSAFE_FLAGS',
        detail: `Refusing diagnostic: expected false for ${unsafe.join(',')}`,
        observed: Object.fromEntries(
          [
            'AMQUR_VAUTO_SFTP_ENABLED',
            'INVENTORY_SYNC_ENABLED',
            'AMQUR_VAUTO_PUBLISH_PRICES',
            'AMQUR_VAUTO_PUBLISH_PHOTOS',
          ].map((k) => [k, flagValue(k) || 'missing']),
        ),
      }),
    );
    process.exit(3);
  }
}

async function main() {
  gateOrExit();

  const host = flagValue('AMQUR_VAUTO_SFTP_HOST');
  const port = Number(flagValue('AMQUR_VAUTO_SFTP_PORT') || '2022');
  const username = flagValue('AMQUR_VAUTO_SFTP_USER');
  const password = process.env.AMQUR_VAUTO_SFTP_PASSWORD || '';
  const expectedFp = flagValue('AMQUR_VAUTO_SFTP_HOST_FINGERPRINT');

  const runtime = {
    diagnosticVersion: DIAG_VERSION,
    verifiedAtUtc: new Date().toISOString(),
    processRole: process.env.PROCESS_ROLE || null,
    railwayEnvironment:
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.RAILWAY_ENVIRONMENT ||
      null,
    appCommitSha: readGitSha(),
    appServiceName: process.env.APP_SERVICE_NAME || null,
    appReleaseId: process.env.APP_RELEASE_ID || null,
    node: process.version,
    cwd: process.cwd(),
    config: {
      host,
      port,
      username,
      passwordPresent: Boolean(password.trim()),
      fingerprintConfigured: Boolean(expectedFp),
      fingerprintPrefix: expectedFp ? expectedFp.slice(0, 20) : null,
    },
    safetyFlags: {
      AMQUR_VAUTO_SFTP_ENABLED: flagValue('AMQUR_VAUTO_SFTP_ENABLED'),
      INVENTORY_SYNC_ENABLED: flagValue('INVENTORY_SYNC_ENABLED'),
      AMQUR_VAUTO_PUBLISH_PRICES: flagValue('AMQUR_VAUTO_PUBLISH_PRICES'),
      AMQUR_VAUTO_PUBLISH_PHOTOS: flagValue('AMQUR_VAUTO_PUBLISH_PHOTOS'),
    },
  };

  if (!host || !username || !password.trim() || !expectedFp) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          verdict: 'CONNECTION FAILED — DIAGNOSIS PROVIDED',
          runtime,
          error: 'AUTH_CONFIG_INCOMPLETE',
          hostKeyVerification: 'NOT_ATTEMPTED',
          authentication: 'NOT_ATTEMPTED',
          feeds: FEEDS.map((f) => ({
            Store: f.store,
            Feed: f.feed,
            Directory: f.remoteDir,
            Listing: 'NOT_ATTEMPTED',
            'File Count': null,
            'Latest Filename': null,
            Size: null,
            'Modified UTC': null,
            Format: null,
            Validation: 'NOT_ATTEMPTED',
            Status: 'RUNTIME_BLOCKED',
          })),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  let SftpClient;
  try {
    SftpClient = require('ssh2-sftp-client');
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false,
        verdict: 'BLOCKED — RUNTIME ACCESS UNAVAILABLE',
        runtime,
        error: 'ssh2-sftp-client_missing',
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    process.exit(1);
  }

  const client = new SftpClient();
  let hostKeyVerification = 'PENDING';
  let authentication = 'PENDING';
  let actualFp = null;
  let connectError = null;

  try {
    await client.connect({
      host,
      port,
      username,
      password,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key) => {
        actualFp = sshHostFingerprintSha256(key);
        const ok = hostKeyMatches(key, expectedFp);
        hostKeyVerification = ok ? 'MATCH' : 'MISMATCH';
        return ok;
      },
    });
    authentication = 'SUCCEEDED';
  } catch (e) {
    connectError = e instanceof Error ? e.message : String(e);
    if (hostKeyVerification === 'MISMATCH') {
      authentication = 'NOT_REACHED';
    } else if (/handshake|host key|fingerprint/i.test(connectError)) {
      hostKeyVerification =
        hostKeyVerification === 'PENDING' ? 'FAILED' : hostKeyVerification;
      authentication = 'NOT_REACHED';
    } else {
      authentication = 'FAILED';
      if (hostKeyVerification === 'PENDING' && actualFp) {
        hostKeyVerification =
          normalizeFp(actualFp) === normalizeFp(expectedFp)
            ? 'MATCH'
            : 'MISMATCH';
      } else if (hostKeyVerification === 'PENDING') {
        hostKeyVerification = 'UNKNOWN';
      }
    }
  }

  const feeds = [];

  if (authentication !== 'SUCCEEDED') {
    const status =
      hostKeyVerification === 'MISMATCH'
        ? 'HOST_KEY_BLOCKED'
        : authentication === 'FAILED'
          ? 'AUTH_FAILED'
          : 'UNKNOWN';
    for (const f of FEEDS) {
      feeds.push({
        Store: f.store,
        Feed: f.feed,
        Directory: f.remoteDir,
        Listing: 'NOT_ATTEMPTED',
        'File Count': null,
        'Latest Filename': null,
        Size: null,
        'Modified UTC': null,
        Format: null,
        Validation: 'NOT_ATTEMPTED',
        Status: status,
        errorCode: connectError ? String(connectError).slice(0, 160) : status,
      });
    }
  } else {
    for (const f of FEEDS) {
      const row = {
        Store: f.store,
        Feed: f.feed,
        Directory: f.remoteDir,
        Listing: 'FAILED',
        'File Count': null,
        'Latest Filename': null,
        Size: null,
        'Modified UTC': null,
        Format: null,
        Validation: 'NOT_ATTEMPTED',
        Status: 'UNKNOWN',
        filenamesSample: [],
        inspectionAttempted: false,
        appearsGenuineVAutoExport: null,
        errorCode: null,
      };
      try {
        const dir = assertAllowedDir(f.remoteDir);
        const entries = await client.list(dir);
        const files = entries
          .filter((e) => e.type === '-')
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
            size: Number(e.size) || 0,
            modifyTimeMs: Number(e.modifyTime) || 0,
          }))
          .sort((a, b) => b.modifyTimeMs - a.modifyTimeMs);

        const truncated = files.length > MAX_LIST;
        const bounded = files.slice(0, MAX_LIST);
        row.Listing = truncated ? 'OK_TRUNCATED' : 'OK';
        row['File Count'] = truncated ? `>=${MAX_LIST}` : bounded.length;
        row.filenamesSample = bounded.slice(0, 5).map((x) => x.name);

        if (bounded.length === 0) {
          row.Validation = 'N/A_EMPTY';
          row.Status = 'EMPTY';
        } else {
          const latest = bounded[0];
          row['Latest Filename'] = latest.name;
          row.Size = latest.size;
          row['Modified UTC'] = latest.modifyTimeMs
            ? new Date(latest.modifyTimeMs).toISOString()
            : null;

          // Bounded peek of newest file only — no full download.
          if (MAX_PEEK_FILES > 0 && latest.size > 0) {
            row.inspectionAttempted = true;
            const remotePath = `${dir}/${latest.name}`;
            assertAllowedDir(dir);
            if (latest.name.includes('..') || latest.name.includes('/')) {
              throw new Error('sftp_path_rejected');
            }
            const buf = await client.get(remotePath, undefined, {
              readStreamOptions: { start: 0, end: Math.max(0, PEEK_BYTES - 1) },
            });
            const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
            const head = body.subarray(0, PEEK_BYTES).toString('utf8');
            const format = detectFormat(latest.name, head);
            row.Format = format;
            const genuine = looksLikeVAutoExport(latest.name, format, head);
            row.appearsGenuineVAutoExport = genuine;

            const hasVinHint = /vin/i.test(head.slice(0, 500));
            if (format === 'UNKNOWN') {
              row.Validation = 'INVALID_FILE';
            } else if (format === 'CSV' && !hasVinHint) {
              row.Validation = 'SCHEMA_MISMATCH';
            } else if (genuine) {
              row.Validation = 'VALID_CANDIDATE';
            } else {
              row.Validation = 'PARTIAL';
            }
            row.Status = classifyFeed({
              listingOk: true,
              fileCount: bounded.length,
              format,
              validation: row.Validation,
              errorCode: null,
            });
          } else {
            row.Validation = 'PEEK_SKIPPED';
            row.Status = 'PARTIAL_FEED';
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        row.errorCode = msg.slice(0, 160);
        if (/no such file|ENOENT|not exist/i.test(msg)) {
          row.Status = 'PATH_MISSING';
          row.Listing = 'PATH_MISSING';
        } else if (/permission|denied|forbidden/i.test(msg)) {
          row.Status = 'ACCESS_DENIED';
          row.Listing = 'ACCESS_DENIED';
        } else {
          row.Status = 'UNKNOWN';
          row.Listing = 'FAILED';
        }
        row.Validation = 'FAILED';
      }
      feeds.push(row);
    }
  }

  try {
    await client.end();
  } catch {
    /* ignore */
  }

  const verifiedCount = feeds.filter((r) => r.Status === 'REAL_FEED_VERIFIED')
    .length;
  const emptyCount = feeds.filter((r) => r.Status === 'EMPTY').length;
  const connected = authentication === 'SUCCEEDED';

  let verdict;
  if (!connected) {
    verdict = 'CONNECTION FAILED — DIAGNOSIS PROVIDED';
  } else if (verifiedCount === 10) {
    verdict = 'CONNECTED — REAL FEEDS VERIFIED';
  } else if (verifiedCount > 0) {
    verdict = 'CONNECTED — WAITING FOR VAUTO FILES';
  } else if (emptyCount === 10 || emptyCount + feeds.filter((r) => r.Status === 'PATH_MISSING').length === 10) {
    verdict = 'CONNECTED — WAITING FOR VAUTO FILES';
  } else if (connected) {
    verdict = 'CONNECTED — WAITING FOR VAUTO FILES';
  } else {
    verdict = 'CONNECTION FAILED — DIAGNOSIS PROVIDED';
  }

  const out = {
    ok: connected,
    verdict,
    runtime,
    hostKeyVerification,
    actualFingerprintPrefix: actualFp ? actualFp.slice(0, 20) : null,
    authentication,
    connectError: connectError ? String(connectError).slice(0, 200) : null,
    isolationAssessment:
      'Read-only listing/peek only. Write restriction NOT proven by this diagnostic (no write attempted). Account isolation relies on SFTPGo config evidence + allowlisted paths.',
    summary: {
      feedsTotal: feeds.length,
      realFeedVerified: verifiedCount,
      empty: emptyCount,
      other: feeds.length - verifiedCount - emptyCount,
    },
    feeds,
    note: 'VALID_CANDIDATE means format looks like a vAuto export candidate after bounded peek. It does NOT mean inventory was imported into AMQUR.',
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(connected ? 0 : 1);
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      verdict: 'CONNECTION FAILED — DIAGNOSIS PROVIDED',
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  process.exit(1);
});
