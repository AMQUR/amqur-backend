import { useState } from 'react';
import { confirmMfa, logout, setupMfa } from '../api';
import { Card, ErrorNote } from '../ui';

export function Security({ required }: { required: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="page">
      <h1>Security</h1>
      {required && !codes && <p className="banner banner--warn">Your role requires two-factor authentication before you can use the Command Center.</p>}
      <Card title="Two-factor authentication (authenticator app)">
        {!setup && !codes && (
          <button className="btn btn--primary" onClick={async () => setSetup(await setupMfa().catch((e) => (setError(String(e.message)), null)))}>
            Set up authenticator
          </button>
        )}
        {setup && !codes && (
          <div className="stack">
            <p>Add this key in your authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.</p>
            <code className="secret">{setup.secret.replace(/(.{4})/g, '$1 ')}</code>
            <a href={setup.otpauthUri}>Open in authenticator app</a>
            <label>
              Code
              <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button className="btn btn--primary" onClick={async () => setCodes(await confirmMfa(code).catch((e) => (setError(String(e.message)), null)))}>
              Confirm
            </button>
          </div>
        )}
        {codes && (
          <div className="stack">
            <p>
              <strong>Save these recovery codes now.</strong> Each works once if you lose your device. They won’t be shown again.
            </p>
            <ul className="codes">
              {codes.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
            <a className="btn" href="#/home">
              Continue
            </a>
          </div>
        )}
        <ErrorNote error={error} />
      </Card>
      <Card title="Sessions">
        <button className="btn" onClick={() => void logout(true)}>
          Sign out of all devices
        </button>
      </Card>
    </div>
  );
}
