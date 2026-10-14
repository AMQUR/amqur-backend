import type { ReactNode } from 'react';

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | 'neutral'; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card__head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}
export const statusTone = (s: string): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' =>
  /CONFIRMED|PUBLISHED|SYNCED|HEALTHY|COMPLETED/.test(s) ? 'ok' : /DEAD|FAILED|UNHEALTHY|CANCEL|REJECT|NO_SHOW/.test(s) ? 'bad' : /PENDING|REQUESTED|DRAFT|REVIEW|QUEUED/.test(s) ? 'warn' : 'neutral';
