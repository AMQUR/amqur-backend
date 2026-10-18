import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiError, session, clearSession, tryRestore } from './api';

if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
}

describe('Command Center API client', () => {
  beforeEach(() => {
    clearSession();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('ApiError instantiates with status and message', () => {
    const err = new ApiError(403, 'Forbidden action');
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden action');
    expect(err).toBeInstanceOf(Error);
  });

  it('session manages listeners and user state cleanly', () => {
    let callCount = 0;
    const unsub = session.subscribe(() => {
      callCount++;
    });
    expect(session.user).toBeNull();
    clearSession();
    expect(callCount).toBe(1);
    unsub();
    clearSession();
    expect(callCount).toBe(1);
  });

  it('tryRestore returns false when no refresh token stored', async () => {
    const restored = await tryRestore();
    expect(restored).toBe(false);
  });
});
