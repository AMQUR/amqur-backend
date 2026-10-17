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
