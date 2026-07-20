import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import * as fs from 'fs';
import * as path from 'path';

type ReleaseInfo = {
  version: string;
  commitSha: string;
  environment: string;
  buildTime: string;
  releaseId: string;
  service: string;
};

/**
 * Deployment provenance. Values come from (in priority order):
 * 1. APP_* environment variables set by the deploy pipeline
 * 2. release.json stamped into the image by scripts/stamp-release.mjs
 * 3. package.json version / 'unknown'
 *
 * Returns ONLY release identity — never configuration or secrets.
 */
@Controller('version')
export class VersionController {
  private cached: ReleaseInfo | null = null;

  @Public()
  @Get()
  version(): ReleaseInfo {
    if (this.cached) return this.cached;

    const stamped = this.readJson(path.resolve(process.cwd(), 'release.json'));
    const pkg = this.readJson(path.resolve(process.cwd(), 'package.json'));

    this.cached = {
      version:
        process.env.APP_RELEASE_VERSION?.trim() ||
        (stamped?.version as string) ||
        (pkg?.version as string) ||
        'unknown',
      commitSha:
        process.env.APP_COMMIT_SHA?.trim() ||
        (stamped?.commitSha as string) ||
        'unknown',
      environment:
        process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
        process.env.NODE_ENV ||
        'unknown',
      buildTime:
        process.env.APP_BUILD_TIME?.trim() ||
        (stamped?.buildTime as string) ||
        'unknown',
      releaseId:
        process.env.APP_RELEASE_ID?.trim() ||
        (stamped?.releaseId as string) ||
        'unknown',
      service:
        process.env.APP_SERVICE_NAME?.trim() ||
        process.env.RAILWAY_SERVICE_NAME?.trim() ||
        process.env.PROCESS_ROLE?.trim() ||
        'unknown',
    };
    return this.cached;
  }

  private readJson(file: string): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }
}
