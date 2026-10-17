import { useState } from 'react';
import type { FormEvent } from 'react';
import { login, verifyMfa } from '../api';

export function Login({ onDone }: { onDone: (enrollRequired: boolean) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await verifyMfa(mfaToken, code);
        onDone(false);
      } else {
        const r = await login(email, password, tenantSlug || undefined);
        if (r.kind === 'mfa') setMfaToken(r.mfaToken);
        else onDone(r.mfaEnrollmentRequired);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      if (mfaToken && /expired/i.test(String(err))) setMfaToken(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login__card" onSubmit={submit} aria-labelledby="login-title">
        <h1 id="login-title">Command Center</h1>
        {!mfaToken ? (
          <>
            <label>
              Email
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <details>
              <summary>Multiple dealerships?</summary>
              <label>
                Dealership ID (slug)
                <input value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} />
              </label>
            </details>
          </>
        ) : (
          <label>
            Authenticator code or recovery code
            <input inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--primary" disabled={busy}>
          {mfaToken ? 'Verify' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
