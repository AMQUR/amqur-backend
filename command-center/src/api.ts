/**
 * Command Center API client. Same-origin (/api). Access token lives in memory only; the
 * rotating refresh token is kept in sessionStorage (tab-scoped, cleared on close) so a page
 * reload doesn't force re-login. Strict CSP on /cc limits XSS exposure of that token.
 */
export type User = { id: string; email: string; firstName: string; lastName: string; role: string; tenantId: string; locationId: string | null };
type Tokens = { access_token: string; refresh_token: string; user: User; mfa_enrollment_required?: boolean };

const RT_KEY = 'amqur_cc_rt';
let access: string | null = null;
let currentUser: User | null = null;
const listeners = new Set<() => void>();

export const session = {
  get user() {
    return currentUser;
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function emit() {
  listeners.forEach((l) => l());
}

function store(t: Tokens) {
  access = t.access_token;
  currentUser = t.user;
  try {
    sessionStorage.setItem(RT_KEY, t.refresh_token);
  } catch {
    /* storage blocked: session ends on reload */
  }
  emit();
}

export function clearSession() {
  access = null;
  currentUser = null;
  try {
    sessionStorage.removeItem(RT_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

async function raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(auth && access ? { Authorization: `Bearer ${access}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function unwrap<T>(json: unknown): T {
  if (json && typeof json === 'object' && 'data' in (json as object)) return (json as { data: T }).data;
  return json as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const inner = unwrap<{ message?: string | string[] }>(json) ?? {};
    const msg = Array.isArray(inner.message) ? inner.message.join(', ') : inner.message ?? (json as { message?: string })?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, String(msg));
  }
  return unwrap<T>(json);
}

export async function tryRestore(): Promise<boolean> {
  let rt: string | null = null;
  try {
    rt = sessionStorage.getItem(RT_KEY);
  } catch {
    return false;
  }
  if (!rt) return false;
  const res = await raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: rt }) }, false);
  if (!res.ok) {
    clearSession();
    return false;
  }
  store(await parse<Tokens>(res));
  return true;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && (await tryRestore())) res = await raw(path, init);
  if (res.status === 401) clearSession();
  return parse<T>(res);
}

/** Multipart upload helper — does not force JSON Content-Type. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return api<T>(path, { method: 'POST', body: form });
}

export type LoginResult = { kind: 'ok'; mfaEnrollmentRequired: boolean } | { kind: 'mfa'; mfaToken: string };

export async function login(email: string, password: string, tenantSlug?: string): Promise<LoginResult> {
  const res = await raw('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, ...(tenantSlug ? { tenantSlug } : {}) }) }, false);
  const data = await parse<Tokens & { mfa_required?: boolean; mfa_token?: string }>(res);
  if (data.mfa_required && data.mfa_token) return { kind: 'mfa', mfaToken: data.mfa_token };
  store(data);
  return { kind: 'ok', mfaEnrollmentRequired: !!data.mfa_enrollment_required };
}

export async function verifyMfa(mfaToken: string, code: string) {
  const res = await raw('/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfa_token: mfaToken, code }) }, false);
  store(await parse<Tokens>(res));
}

export async function setupMfa() {
  return api<{ secret: string; otpauthUri: string }>('/auth/mfa/setup', { method: 'POST' });
}

export async function confirmMfa(code: string) {
  const r = await api<Tokens & { recoveryCodes: string[] }>('/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
  store(r);
  return r.recoveryCodes;
}

export async function logout(all = false) {
  let rt: string | null = null;
  try {
    rt = sessionStorage.getItem(RT_KEY);
  } catch {
    /* ignore */
  }
  try {
    if (all) await api('/auth/logout-all', { method: 'POST' });
    else if (rt) await raw('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: rt }) }, false);
  } finally {
    clearSession();
  }
}
