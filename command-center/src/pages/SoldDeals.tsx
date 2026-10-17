import { useState } from 'react';
import { api } from '../api';
import { Card, ErrorNote } from '../ui';

type RecordSoldResult =
  | { accepted: true; dmsDealId: string; leadId?: string }
  | {
      accepted: false;
      reason:
        | 'dms_not_connected'
        | 'invalid_input'
        | 'lead_not_found'
        | 'lead_not_eligible';
    };

const REASON_LABEL: Record<
  'dms_not_connected' | 'invalid_input' | 'lead_not_found' | 'lead_not_eligible',
  string
> = {
  dms_not_connected: 'DMS is not connected or not live-ready for this rooftop',
  invalid_input: 'Invalid input — check required fields',
  lead_not_found: 'Lead not found in this tenant',
  lead_not_eligible: 'Lead is not eligible for sold reconciliation',
};

export function SoldDeals({ locationId }: { locationId: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RecordSoldResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    source: 'staff' as 'staff' | 'dms',
    dmsDealId: '',
    leadId: '',
    vin: '',
  });

  const submit = async () => {
    if (!locationId) return;
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {
        locationId,
        source: form.source,
        dmsDealId: form.dmsDealId.trim(),
      };
      if (form.leadId.trim()) body.leadId = form.leadId.trim();
      if (form.vin.trim()) body.vin = form.vin.trim();
      const r = await api<RecordSoldResult>('/deals/sold/record', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(r);
      if (r.accepted) {
        setForm({ source: form.source, dmsDealId: '', leadId: '', vin: '' });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Record failed');
    } finally {
      setBusy(false);
    }
  };

  if (!locationId) {
    return (
      <div className="page">
        <h1>Record sold deal</h1>
        <p>Select a rooftop to reconcile a DMS-attributed sold deal.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Record sold deal</h1>
      <p className="muted">
        Structured reconciliation only — never inferred from chat or AI. Requires an enabled DMS
        integration with <code>liveReady</code> for the selected rooftop (see Integrations).
      </p>
      <p className="banner banner--warn" role="note">
        Fail-closed: if DMS is missing credentials, disabled, or not live-ready, recording is
        rejected with <code>dms_not_connected</code>.
      </p>
      <ErrorNote error={err} />
      {result && (
        <p
          className={`banner ${result.accepted ? 'banner--ok' : ''}`}
          role="status"
        >
          {result.accepted ? (
            <>
              Accepted — deal <code>{result.dmsDealId}</code>
              {result.leadId ? (
                <>
                  {' '}
                  linked to lead <code>{result.leadId}</code>
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              Not accepted —{' '}
              {REASON_LABEL[result.reason] ?? result.reason.replace(/_/g, ' ')}
            </>
          )}
        </p>
      )}
      <Card title="Sold deal payload">
        <div className="stack">
          <div className="grid2">
            <label>
              Source
              <select
                value={form.source}
                onChange={(e) =>
                  setForm({ ...form, source: e.target.value as 'staff' | 'dms' })
                }
              >
                <option value="staff">staff</option>
                <option value="dms">dms</option>
              </select>
            </label>
            <label>
              DMS deal ID
              <input
                required
                value={form.dmsDealId}
                onChange={(e) => setForm({ ...form, dmsDealId: e.target.value })}
                placeholder="Authoritative contract / deal id"
              />
            </label>
            <label>
              Lead ID <span className="muted small">(optional)</span>
              <input
                value={form.leadId}
                onChange={(e) => setForm({ ...form, leadId: e.target.value })}
              />
            </label>
            <label>
              VIN <span className="muted small">(optional)</span>
              <input
                maxLength={17}
                value={form.vin}
                onChange={(e) => setForm({ ...form, vin: e.target.value })}
              />
            </label>
          </div>
          <button
            className="btn btn--primary"
            disabled={busy || !form.dmsDealId.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Recording…' : 'Record sold deal'}
          </button>
        </div>
      </Card>
    </div>
  );
}
