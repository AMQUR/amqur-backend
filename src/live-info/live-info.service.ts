import { Injectable, Logger } from '@nestjs/common';
import { ConfigCacheService } from '../cache/config-cache.service';

/**
 * Live, verifiable information for ordinary small talk (weather, sports).
 *
 * Rules: server-side only; fixed provider hosts (never a customer-supplied URL); bounded
 * timeouts; short-lived cache; every result carries its source and observation time. When a
 * provider is not configured or unreachable the result says so — callers must never present
 * model knowledge as a live lookup.
 *
 * Weather: US National Weather Service (api.weather.gov) — public-domain US government data,
 * no key, commercial use permitted; requires an identifying User-Agent. Coordinates come from a
 * small built-in table of Chicago-area places (no third-party geocoder).
 * Sports: no licensed provider is configured; `SPORTS_PROVIDER` is the switch for a future
 * licensed feed. Until then sports lookups return `unavailable`.
 */
export type LiveWeather =
  | {
      status: 'ok';
      place: string;
      source: 'National Weather Service (api.weather.gov)';
      retrievedAt: string;
      periods: Array<{
        name: string;
        temperature: number;
        unit: string;
        shortForecast: string;
        precipitationChance: number | null;
        wind: string;
      }>;
    }
  | { status: 'unknown_place'; place: string }
  | { status: 'unavailable'; reason: string };

export type LiveSports = { status: 'unavailable'; reason: string };

/** Places we can resolve without a geocoding vendor (lat, lon). */
export const KNOWN_PLACES: Record<string, [number, number]> = {
  chicago: [41.8781, -87.6298],
  evanston: [42.0451, -87.6877],
  skokie: [42.0324, -87.7416],
  'oak park': [41.885, -87.7845],
  cicero: [41.8456, -87.7539],
  naperville: [41.7508, -88.1535],
  schaumburg: [42.0334, -88.0834],
  'des plaines': [42.0334, -87.8834],
  joliet: [41.525, -88.0817],
  aurora: [41.7606, -88.3201],
  elgin: [42.0354, -88.2826],
  'oak lawn': [41.711, -87.7584],
  orland: [41.6303, -87.8539],
  gary: [41.5934, -87.3464],
  milwaukee: [43.0389, -87.9065],
};

@Injectable()
export class LiveInfoService {
  private readonly logger = new Logger(LiveInfoService.name);
  constructor(private readonly cache: ConfigCacheService) {}

  weatherEnabled(): boolean {
    return (process.env.LIVE_WEATHER_PROVIDER ?? 'nws').toLowerCase() === 'nws';
  }

  resolvePlace(text: string | null | undefined): string | null {
    const t = ` ${(text ?? '').toLowerCase()} `;
    const hit = Object.keys(KNOWN_PLACES).find((p) => t.includes(` ${p}`));
    return hit ?? null;
  }

  async weather(placeKey: string): Promise<LiveWeather> {
    if (!this.weatherEnabled())
      return { status: 'unavailable', reason: 'weather provider disabled' };
    const coords = KNOWN_PLACES[placeKey];
    if (!coords) return { status: 'unknown_place', place: placeKey };
    const key = `live:weather:nws:${placeKey}`;
    const cached = await this.cache.getJson<LiveWeather>(key).catch(() => null);
    if (cached?.status === 'ok') return cached;
    const ua =
      process.env.LIVE_INFO_USER_AGENT?.trim() ||
      'AMQUR dealership assistant (contact: dealership website)';
    const get = async (url: string) => {
      const r = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: 'application/geo+json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) throw new Error(`nws_http_${r.status}`);
      return (await r.json()) as Record<string, any>;
    };
    try {
      const point = await get(
        `https://api.weather.gov/points/${coords[0]},${coords[1]}`,
      );
      const forecastUrl = String(point?.properties?.forecast ?? '');
      // Only follow the provider's own forecast link on the same fixed host.
      if (!forecastUrl.startsWith('https://api.weather.gov/'))
        throw new Error('nws_unexpected_forecast_url');
      const fc = await get(forecastUrl);
      const periods = (fc?.properties?.periods ?? [])
        .slice(0, 10)
        .map((p: Record<string, any>) => ({
          name: String(p.name ?? ''),
          temperature: Number(p.temperature),
          unit: String(p.temperatureUnit ?? 'F'),
          shortForecast: String(p.shortForecast ?? ''),
          precipitationChance:
            typeof p.probabilityOfPrecipitation?.value === 'number'
              ? p.probabilityOfPrecipitation.value
              : null,
          wind: `${p.windSpeed ?? ''} ${p.windDirection ?? ''}`.trim(),
        }))
        .filter(
          (p: { name: string; temperature: number }) =>
            p.name && Number.isFinite(p.temperature),
        );
      if (!periods.length) throw new Error('nws_no_periods');
      const out: LiveWeather = {
        status: 'ok',
        place: placeKey.replace(/\b\w/g, (c) => c.toUpperCase()),
        source: 'National Weather Service (api.weather.gov)',
        retrievedAt: new Date().toISOString(),
        periods,
      };
      await this.cache.setJson(key, out, 600).catch(() => undefined);
      return out;
    } catch (e: unknown) {
      this.logger.warn(
        `live weather unavailable: ${e instanceof Error ? e.message : 'error'}`,
      );
      return { status: 'unavailable', reason: 'weather service unreachable' };
    }
  }

  async sports(): Promise<LiveSports> {
    // No licensed sports-data provider is configured (owner decision / contract required).
    return {
      status: 'unavailable',
      reason: 'no licensed live sports provider is configured',
    };
  }
}
