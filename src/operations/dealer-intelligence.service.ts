import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { projectDealerIntelligenceSnapshot } from './dealer-intelligence.policy';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
function within(base: string, file: string): boolean {
  const rel = path.relative(base, file);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  );
}

/**
 * Fail-closed private snapshot reader.
 * Disabled until a private mounted source (outside code/asset roots) is explicitly configured.
 * Never serves uploaded customer records, private HTML or a file path from the request.
 */
@Injectable()
export class DealerIntelligenceService {
  async snapshot() {
    if (process.env.DEALER_INTELLIGENCE_ENABLED !== 'true') {
      throw new ServiceUnavailableException(
        'Dealer Intelligence is not enabled',
      );
    }
    const root = process.env.DEALER_INTELLIGENCE_PRIVATE_ROOT;
    const file = process.env.DEALER_INTELLIGENCE_REPORT_PATH;
    if (!root || !file || !path.isAbsolute(root) || !path.isAbsolute(file)) {
      throw new ServiceUnavailableException(
        'Private report location is not configured',
      );
    }
    try {
      const rootPath = path.resolve(root),
        filePath = path.resolve(file);
      // Reject symlink-based path escapes and reports inside the app/source checkout.
      const [resolvedRoot, resolvedFile, fileInfo, rootInfo] =
        await Promise.all([
          realpath(rootPath),
          realpath(filePath),
          lstat(filePath),
          stat(rootPath),
        ]);
      if (
        resolvedRoot !== rootPath ||
        resolvedFile !== filePath ||
        !rootInfo.isDirectory() ||
        !fileInfo.isFile() ||
        fileInfo.isSymbolicLink() ||
        !within(resolvedRoot, resolvedFile) ||
        within(path.resolve(process.cwd()), resolvedFile) ||
        within(path.resolve(process.cwd()), resolvedRoot) ||
        (fileInfo.mode & 0o027) !== 0 ||
        (rootInfo.mode & 0o007) !== 0 ||
        fileInfo.size < 2 ||
        fileInfo.size > MAX_JSON_BYTES
      ) {
        throw new Error('Private snapshot path or permissions invalid');
      }
      const raw = JSON.parse(await readFile(resolvedFile, 'utf8')) as unknown;
      const safe = projectDealerIntelligenceSnapshot(raw);
      // A missing or stale refresh must be visible; do not silently label it live.
      const ageDays = Math.max(
        0,
        Math.floor(
          (Date.now() - Date.parse(safe.as_of + 'T00:00:00Z')) / 86400000,
        ),
      );
      return { ...safe, freshness: { age_days: ageDays, stale: ageDays > 2 } };
    } catch {
      // Do not echo file paths, raw JSON, provider or user details in HTTP errors.
      throw new ServiceUnavailableException(
        'Private Dealer Intelligence snapshot unavailable or invalid',
      );
    }
  }
}
