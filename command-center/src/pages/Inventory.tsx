import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote } from '../ui';

type VehicleRow = {
  vin: string;
  stock?: string | null;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  price?: number;
  status?: string;
  simulated?: boolean;
  freshnessState?: string | null;
  lastSeenAt?: string | null;
};

type InventoryHealth = {
  dialDifferenceSftp?: {
    ingestEnabled: boolean;
    inventorySyncEnabled: boolean;
    credentialsConfigured: boolean;
    publishPrices: boolean;
    publishPhotos: boolean;
    feedSourceCount: number;
  };
  freshness?: Record<string, number>;
  failedOrRejectedImports7d?: number;
  latestImportByFeed?: Record<
    string,
    { status: string; startedAt: string | null; validCount: number | null; displayName?: string }
  >;
  tenFeeds?: Array<{
    feedSourceKey: string;
    status: string;
    startedAt: string | null;
    validCount: number | null;
    displayName: string;
  }>;
  pricePhotoPolicy?: { publishPrices: boolean; publishPhotos: boolean; provenance: string };
  note?: string;
};

function fmtPrice(n?: number) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function vehicleLabel(v: VehicleRow) {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || v.vin;
}

export function Inventory({ locationId }: { locationId: string }) {
  const [vin, setVin] = useState('');
  const [stock, setStock] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState({
    vin: '',
    stock: '',
    make: '',
    model: '',
    q: '',
  });

  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (locationId) p.set('locationId', locationId);
    for (const [k, v] of Object.entries(submitted)) {
      if (v.trim()) p.set(k, v.trim());
    }
    const qs = p.toString();
    return `/ops/inventory${qs ? `?${qs}` : ''}`;
  }, [locationId, submitted]);

  const { data, error, reload } = useAsync(
    () => api<VehicleRow[]>(path),
    [path],
  );
  const rows = data ?? [];

  const healthPath = useMemo(() => {
    const p = new URLSearchParams();
    if (locationId) p.set('locationId', locationId);
    const qs = p.toString();
    return `/ops/inventory/health${qs ? `?${qs}` : ''}`;
  }, [locationId]);
  const { data: health } = useAsync(() => api<InventoryHealth>(healthPath), [healthPath]);

  const runSearch = () => {
    setSubmitted({ vin, stock, make, model, q });
  };

  const clear = () => {
    setVin('');
    setStock('');
    setMake('');
    setModel('');
    setQ('');
    setSubmitted({ vin: '', stock: '', make: '', model: '', q: '' });
  };

  return (
    <div className="page">
      <h1>Inventory</h1>
      <p className="muted">
        Live rows from <code>GET /ops/inventory</code> (same Vehicle table as chat). Price and
        status are shown exactly as stored — nothing is marked available unless{' '}
        <code>status</code> says so.
      </p>
      {health && (
        <Card title="Feed health">
          <ul className="kv">
            <li>
              <span>Dial Difference SFTP</span>
              <span>
                <Badge tone={health.dialDifferenceSftp?.credentialsConfigured ? 'ok' : 'warn'}>
                  {health.dialDifferenceSftp?.credentialsConfigured ? 'creds set' : 'creds missing'}
                </Badge>
                <Badge tone={health.dialDifferenceSftp?.ingestEnabled ? 'warn' : 'neutral'}>
                  ingest {health.dialDifferenceSftp?.ingestEnabled ? 'on' : 'off'}
                </Badge>
                <Badge tone="neutral">
                  {health.dialDifferenceSftp?.feedSourceCount ?? 0} feeds
                </Badge>
              </span>
            </li>
            <li>
              <span>Failed/rejected imports · 7d</span>
              <Badge tone={(health.failedOrRejectedImports7d ?? 0) > 0 ? 'warn' : 'ok'}>
                {health.failedOrRejectedImports7d ?? 0}
              </Badge>
            </li>
            {health.freshness &&
              Object.entries(health.freshness).map(([k, v]) => (
                <li key={k}>
                  <span>Freshness · {k}</span>
                  <Badge tone={k === 'FRESH' ? 'ok' : 'warn'}>{v}</Badge>
                </li>
              ))}
          </ul>
          {health.note && <p className="muted small">{health.note}</p>}
          {(health.tenFeeds ?? Object.entries(health.latestImportByFeed ?? {}).map(([feedSourceKey, row]) => ({
            feedSourceKey,
            ...row,
            displayName: row.displayName ?? feedSourceKey,
          }))).length > 0 && (
            <ul className="kv">
              {(
                health.tenFeeds ??
                Object.entries(health.latestImportByFeed ?? {}).map(([feedSourceKey, row]) => ({
                  feedSourceKey,
                  ...row,
                  displayName: row.displayName ?? feedSourceKey,
                }))
              ).map((row) => (
                <li key={row.feedSourceKey}>
                  <span>{row.displayName}</span>
                  <Badge
                    tone={
                      row.status === 'SUCCEEDED'
                        ? 'ok'
                        : row.status === 'NEVER_RUN'
                          ? 'neutral'
                          : 'warn'
                    }
                  >
                    {row.status} · {row.validCount ?? '—'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {health.pricePhotoPolicy && (
            <p className="muted small">
              Prices {health.pricePhotoPolicy.publishPrices ? 'on' : 'off'} · Photos{' '}
              {health.pricePhotoPolicy.publishPhotos ? 'on' : 'off'}. {health.pricePhotoPolicy.provenance}
            </p>
          )}
        </Card>
      )}
      <Card title="Search">
        <div className="grid2">
          <label>
            VIN
            <input value={vin} onChange={(e) => setVin(e.target.value)} autoComplete="off" />
          </label>
          <label>
            Stock #
            <input value={stock} onChange={(e) => setStock(e.target.value)} autoComplete="off" />
          </label>
          <label>
            Make
            <input value={make} onChange={(e) => setMake(e.target.value)} autoComplete="off" />
          </label>
          <label>
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" />
          </label>
          <label>
            General query (make, model, trim, VIN, stock)
            <input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <div className="row">
          <button className="btn" type="button" onClick={runSearch}>
            Search
          </button>
          <button className="btn btn--ghost" type="button" onClick={clear}>
            Clear
          </button>
          <button className="btn btn--ghost" type="button" onClick={() => void reload()}>
            Refresh
          </button>
        </div>
      </Card>
      <ErrorNote error={error} />
      <Card title={`Results (${rows.length})`}>
        {!rows.length && !error ? (
          <Empty>No vehicles match — try different filters or confirm feed import.</Empty>
        ) : (
          <table className="table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>VIN</th>
                  <th>Stock</th>
                  <th>Price</th>
                  <th>Status</th>
                  <th>Feed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.vin}>
                    <td>{vehicleLabel(v)}</td>
                    <td>
                      <code>{v.vin}</code>
                    </td>
                    <td>{v.stock ?? '—'}</td>
                    <td>{fmtPrice(v.price)}</td>
                    <td>
                      <Badge tone={v.status === 'AVAILABLE' ? 'ok' : v.status === 'SOLD' ? 'bad' : 'neutral'}>
                        {v.status ?? 'UNKNOWN'}
                      </Badge>
                    </td>
                    <td>
                      {v.simulated && <Badge tone="warn">simulated</Badge>}
                      {v.freshnessState && (
                        <span className="muted small"> {v.freshnessState}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        )}
      </Card>
    </div>
  );
}
