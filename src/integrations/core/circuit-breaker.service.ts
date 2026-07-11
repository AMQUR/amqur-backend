import { Injectable } from '@nestjs/common';

export type CircuitState = {
  failures: number;
  openUntil: number | null;
};

/**
 * Simple in-process circuit breaker. Multi-instance deployments should
 * replace with Redis-backed state (documented in reliability.md).
 */
@Injectable()
export class CircuitBreakerService {
  private readonly states = new Map<string, CircuitState>();
  private readonly failureThreshold = 5;
  private readonly openMs = 60_000;

  isOpen(key: string): boolean {
    const s = this.states.get(key);
    if (!s?.openUntil) return false;
    if (Date.now() >= s.openUntil) {
      s.openUntil = null;
      s.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(key: string): void {
    this.states.set(key, { failures: 0, openUntil: null });
  }

  recordFailure(key: string): void {
    const s = this.states.get(key) ?? { failures: 0, openUntil: null };
    s.failures += 1;
    if (s.failures >= this.failureThreshold) {
      s.openUntil = Date.now() + this.openMs;
    }
    this.states.set(key, s);
  }

  snapshot(key: string): CircuitState {
    return this.states.get(key) ?? { failures: 0, openUntil: null };
  }
}
