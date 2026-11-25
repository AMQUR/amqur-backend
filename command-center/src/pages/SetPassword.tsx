import { useEffect, useState, type FormEvent } from 'react';
import { acceptStaffLink, describeStaffLink } from '../api';

type Link = Awaited<ReturnType<typeof describeStaffLink>> & { firstName?: string | null; dealershipSlug?: string | null };

/**
 * Public page reached from an invitation or password-reset link. The person chooses their own
 * password here; nobody else ever sees or sets it. The link works once and expires.
 */
export function SetPassword({ token, onDone }: { token: string; onDone: (slug: string | null) => void }) {
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    describeStaffLink(token).then((l) => setLink(l as Link), () => setLink({ valid: false }));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) return setError('Use at least 12 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const r = await acceptStaffLink(token, password);
      setDone(r.dealershipSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/_/g, ' ') : 'Could not set the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="login__card" onSubmit={submit} aria-labelledby="sp-title">
        <h1 id="sp-title">{link?.purpose === 'RESET' ? 'Reset your password' : 'Set up your account'}</h1>
        {!link && <p aria-busy="true">Checking your link…</p>}
        {link && !link.valid && (
          <p className="error" role="alert">This link is invalid, already used or expired. Ask your administrator for a new one.</p>
        )}
        {link?.valid && done === undefined && (
          <>
            <p className="small">
              {link.firstName ? `${link.firstName}, choose` : 'Choose'} a password for <strong>{link.email}</strong> at <strong>{link.dealership}</strong>.
              Administrators and managers will be asked to set up an authenticator app after signing in.
            </p>
            <label>
              New password (at least 12 characters)
              <input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Repeat it
              <input type="password" autoComplete="new-password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn btn--primary" disabled={busy}>Save password</button>
          </>
        )}
        {done !== undefined && (
          <>
            <p role="status">Your password is set. Sign in with your email{done ? <> and dealership ID <strong>{done}</strong> (under “Multiple dealerships?”)</> : null}.</p>
            <button type="button" className="btn btn--primary" onClick={() => onDone(done)}>Go to sign in</button>
          </>
        )}
      </form>
    </main>
  );
}
