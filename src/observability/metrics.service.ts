import { Injectable } from '@nestjs/common';

/**
 * Lightweight in-process counters for ops dashboards / log scraping.
 * Replace with Prometheus/StatsD later without changing call sites.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }

  reset(): void {
    this.counters.clear();
  }
}
