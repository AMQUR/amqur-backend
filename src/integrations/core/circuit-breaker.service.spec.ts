import { CircuitBreakerService } from './circuit-breaker.service';

describe('CircuitBreakerService', () => {
  it('opens after threshold failures', () => {
    const cb = new CircuitBreakerService();
    for (let i = 0; i < 5; i++) cb.recordFailure('tekion');
    expect(cb.isOpen('tekion')).toBe(true);
    cb.recordSuccess('tekion');
    expect(cb.isOpen('tekion')).toBe(false);
  });
});
