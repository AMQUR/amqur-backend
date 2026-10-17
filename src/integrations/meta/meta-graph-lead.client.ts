import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { MetaGraphLeadFetchResult } from './meta-lead-graph';

export type MetaGraphLeadClient = {
  fetchLeadgen(leadgenId: string): Promise<MetaGraphLeadFetchResult>;
};

/**
 * Fail-closed Meta Graph leadgen fetch. Requires META_GRAPH_ACCESS_TOKEN (page/system user).
 * Does not log tokens or lead PII.
 */
@Injectable()
export class MetaGraphLeadClientService implements MetaGraphLeadClient {
  private readonly logger = new Logger(MetaGraphLeadClientService.name);

  async fetchLeadgen(leadgenId: string): Promise<MetaGraphLeadFetchResult> {
    const token = process.env.META_GRAPH_ACCESS_TOKEN?.trim();
    if (!token) {
      return { ok: false, reason: 'not_configured' };
    }
    const id = leadgenId.trim();
    if (!id) {
      return { ok: false, reason: 'malformed', message: 'empty_leadgen_id' };
    }
    const version = process.env.META_GRAPH_API_VERSION?.trim() || 'v21.0';
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(id)}`;
    try {
      const res = await axios.get(url, {
        params: {
          access_token: token,
          fields: 'id,created_time,field_data',
        },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'lead_not_found',
          statusCode: 404,
        };
      }
      if (res.status < 200 || res.status >= 300) {
        this.logger.warn(
          `meta graph leadgen fetch failed status=${res.status} leadgen=${id.slice(0, 12)}…`,
        );
        return {
          ok: false,
          reason: 'http_error',
          statusCode: res.status,
          message:
            typeof res.data?.error?.message === 'string'
              ? res.data.error.message.slice(0, 200)
              : `http_${res.status}`,
        };
      }
      const data = res.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, reason: 'malformed' };
      }
      const rawId = (data as Record<string, unknown>).id;
      const graphLeadId =
        typeof rawId === 'string' ? rawId.slice(0, 200) : undefined;
      return {
        ok: true,
        fieldData: (data as Record<string, unknown>).field_data,
        graphLeadId,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'network_error';
      this.logger.warn(`meta graph leadgen fetch error: ${msg.slice(0, 120)}`);
      return { ok: false, reason: 'http_error', message: msg.slice(0, 200) };
    }
  }
}
