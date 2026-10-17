import { useState } from 'react';
import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type TradeValuationBlockedReason = 'not_connected' | 'not_configured';

type TradeValuationBlocked = {
  status: 'blocked';
  reason: TradeValuationBlockedReason;
  verified: false;
};

type TradeValuationIntegrationStatus =
  | TradeValuationBlocked
  | { status: 'ready'; verified: false; providerId: string };

type TradeValuationOk = {
  status: 'ok';
  verified: true;
  providerRef: string;
  amount?: number;
  amountLow?: number;
  amountHigh?: number;
};

type GetValuationResult = TradeValuationBlocked | TradeValuationOk;

type AppraisalProviderRow = {
  id: string;
  name: string;
  status: string;
  registered: boolean;
};

type TradeAppraisalRow = {
  id: string;
  kind: string;
  provider: string;
  status: string;
  amount: number | null;
  amountLow: number | null;
  amountHigh: number | null;
  displayPermitted: boolean;
  expiresAt: string | null;
  createdAt: string;
};

const VALUATION_BLOCKED: Record<TradeValuationBlockedReason, string> = {
  not_connected:
    'Trade valuation is not connected — enable a live-ready trade_valuation integration for this rooftop (Integrations).',
  not_configured:
    'Valuation provider adapter is not configured in this environment — no licensed amounts until vendor OAuth is verified.',
};

function isValuationBlocked(
  r: GetValuationResult | TradeValuationIntegrationStatus | null | undefined,
): r is TradeValuationBlocked {
  return !!r && r.status === 'blocked';
}

function vehicleQuery(
  locationId: string,
  form: VehicleForm,
): URLSearchParams {
  const q = new URLSearchParams();
  if (locationId) q.set('locationId', locationId);
  const vin = form.vin.trim();
  if (vin) q.set('vin', vin);
  if (form.year.trim()) q.set('year', form.year.trim());
  if (form.make.trim()) q.set('make', form.make.trim());
  if (form.model.trim()) q.set('model', form.model.trim());
  if (form.mileage.trim()) q.set('mileage', form.mileage.trim());
  return q;
}

function bodyFromForm(locationId: string, form: VehicleForm) {
  const body: Record<string, string | number> = {};
  if (locationId) body.locationId = locationId;
  const vin = form.vin.trim();
  if (vin) body.vin = vin;
  if (form.year.trim()) body.year = Number(form.year);
  if (form.make.trim()) body.make = form.make.trim();
  if (form.model.trim()) body.model = form.model.trim();
  if (form.mileage.trim()) body.mileage = Number(form.mileage);
  return body;
}

type VehicleForm = {
  vin: string;
  year: string;
  make: string;
  model: string;
  mileage: string;
};

const emptyVehicle = (): VehicleForm => ({
  vin: '',
  year: '',
  make: '',
  model: '',
  mileage: '',
});

export function TradeValuation({ locationId }: { locationId: string }) {
  const [vehicle, setVehicle] = useState<VehicleForm>(emptyVehicle);
  const [tradeId, setTradeId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [requestResult, setRequestResult] = useState<GetValuationResult | null>(null);
  const [busy, setBusy] = useState<'request' | 'offer' | 'appraisal' | null>(null);
  const [staffAmount, setStaffAmount] = useState('');
  const [offerDays, setOfferDays] = useState('7');
  const [staffMsg, setStaffMsg] = useState<string | null>(null);

  const integration = useAsync(async () => {
    if (!locationId) return null;
    const q = new URLSearchParams({ locationId });
    return api<TradeValuationIntegrationStatus>(`/trade/valuation/status?${q}`);
  }, [locationId]);

  const providers = useAsync(
    () => api<AppraisalProviderRow[]>('/ops/appraisal-providers'),
    [],
  );

  const pollParams = vehicleQuery(locationId, vehicle);
  const canPollVehicle =
    !!vehicle.vin.trim() ||
    (!!vehicle.year.trim() && !!vehicle.make.trim() && !!vehicle.model.trim());

  const vehicleStatus = useAsync(async () => {
    if (!locationId || !canPollVehicle) return null;
    return api<GetValuationResult | TradeValuationIntegrationStatus>(
      `/trade/valuation/status?${pollParams}`,
    );
  }, [locationId, canPollVehicle, pollParams.toString()]);

  const tradeAppraisals = useAsync(async () => {
    const id = tradeId.trim();
    if (!id) return null;
    return api<TradeAppraisalRow[]>(`/ops/trades/${encodeURIComponent(id)}/appraisals`);
  }, [tradeId]);

  const integrationBlocked =
    integration.data && isValuationBlocked(integration.data) ? integration.data : null;
  const pollBlocked =
    vehicleStatus.data && isValuationBlocked(vehicleStatus.data) ? vehicleStatus.data : null;
  const pollOk =
    vehicleStatus.data && vehicleStatus.data.status === 'ok' ? vehicleStatus.data : null;

  const requestLicensed = async () => {
    if (!locationId) return;
    const hasId =
      !!vehicle.vin.trim() ||
      (!!vehicle.year.trim() && !!vehicle.make.trim() && !!vehicle.model.trim());
    if (!hasId) {
      setErr('Supply VIN or year + make + model.');
      return;
    }
    setErr(null);
    setRequestResult(null);
    setBusy('request');
    try {
      const r = await api<GetValuationResult>('/trade/valuation/request', {
        method: 'POST',
        body: JSON.stringify(bodyFromForm(locationId, vehicle)),
      });
      setRequestResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Valuation request failed');
    } finally {
      setBusy(null);
    }
  };

  const postTrade = async (path: string, body: unknown, ok: string) => {
    const id = tradeId.trim();
    if (!id) {
      setStaffMsg('Trade request ID is required.');
      return;
    }
    setStaffMsg(null);
    setBusy(path === 'offer' ? 'offer' : 'appraisal');
    try {
      await api(`/ops/trades/${encodeURIComponent(id)}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setStaffMsg(ok);
      void tradeAppraisals.reload();
    } catch (e) {
      setStaffMsg(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (!locationId) {
    return (
      <div className="page">
        <h1>Trade valuation</h1>
        <p>Select a rooftop to check licensed valuation and staff appraisal workflows.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Trade valuation</h1>
      <p className="muted">
        Licensed third-party valuations and staff-recorded appraisals only — AMQUR never invents
        trade dollar amounts.
      </p>
      <p className="banner banner--warn" role="note">
        Fail-closed: licensed lookups return <code>not_connected</code> without a live-ready{' '}
        <code>trade_valuation</code> integration; the disabled adapter returns{' '}
        <code>not_configured</code>. Customer-visible values come from staff/manager records on a
        trade request, not from this page guessing.
      </p>
      <ErrorNote error={integration.error ?? vehicleStatus.error ?? err} />

      <Card
        title="Licensed valuation integration"
        actions={
          integrationBlocked ? (
            <Badge tone="bad">blocked</Badge>
          ) : integration.data?.status === 'ready' ? (
            <Badge tone="info">gate open</Badge>
          ) : null
        }
      >
        {integration.loading && <p className="muted">Checking integration…</p>}
        {integrationBlocked && (
          <p className="banner" role="status">
            {VALUATION_BLOCKED[integrationBlocked.reason] ?? integrationBlocked.reason}
          </p>
        )}
        {integration.data?.status === 'ready' && (
          <p className="muted">
            Provider slot <code>{integration.data.providerId}</code> — vehicle details still required
            for a lookup; amounts only when the vendor returns verified values.
          </p>
        )}
      </Card>

      <Card title="Licensed provider lookup">
        <div className="stack">
          <div className="grid2">
            <label>
              VIN
              <input
                maxLength={17}
                value={vehicle.vin}
                onChange={(e) => setVehicle({ ...vehicle, vin: e.target.value })}
                placeholder="11–17 characters"
              />
            </label>
            <label>
              Year
              <input
                inputMode="numeric"
                value={vehicle.year}
                onChange={(e) => setVehicle({ ...vehicle, year: e.target.value })}
              />
            </label>
            <label>
              Make
              <input
                value={vehicle.make}
                onChange={(e) => setVehicle({ ...vehicle, make: e.target.value })}
              />
            </label>
            <label>
              Model
              <input
                value={vehicle.model}
                onChange={(e) => setVehicle({ ...vehicle, model: e.target.value })}
              />
            </label>
            <label>
              Mileage <span className="muted small">(optional)</span>
              <input
                inputMode="numeric"
                value={vehicle.mileage}
                onChange={(e) => setVehicle({ ...vehicle, mileage: e.target.value })}
              />
            </label>
          </div>
          <button
            className="btn btn--primary"
            disabled={busy !== null}
            onClick={() => void requestLicensed()}
          >
            {busy === 'request' ? 'Requesting…' : 'Request licensed valuation'}
          </button>
        </div>
      </Card>

      {requestResult && (
        <p
          className={`banner ${requestResult.status === 'ok' ? 'banner--ok' : ''}`}
          role="status"
        >
          {isValuationBlocked(requestResult) ? (
            <>
              Request blocked —{' '}
              {VALUATION_BLOCKED[requestResult.reason] ?? requestResult.reason}
            </>
          ) : (
            <>
              Verified valuation from provider ref <code>{requestResult.providerRef}</code>
              {requestResult.amount != null && <> — {formatMoney(requestResult.amount)}</>}
              {requestResult.amount == null &&
                requestResult.amountLow != null &&
                requestResult.amountHigh != null && (
                  <>
                    {' '}
                    — {formatMoney(requestResult.amountLow)}–
                    {formatMoney(requestResult.amountHigh)}
                  </>
                )}
              . <Badge tone="ok">verified: true</Badge>
            </>
          )}
        </p>
      )}

      <Card
        title="Lookup status (poll)"
        actions={
          pollBlocked ? (
            <Badge tone="bad">blocked</Badge>
          ) : pollOk ? (
            <Badge tone="ok">verified</Badge>
          ) : canPollVehicle ? (
            <Badge tone="info">polling</Badge>
          ) : null
        }
      >
        {!canPollVehicle && (
          <p className="muted">Enter VIN or year + make + model to poll licensed status.</p>
        )}
        {canPollVehicle && vehicleStatus.loading && <p className="muted">Loading…</p>}
        {canPollVehicle && pollBlocked && (
          <p className="banner" role="status">
            {VALUATION_BLOCKED[pollBlocked.reason] ?? pollBlocked.reason}
          </p>
        )}
        {pollOk && (
          <ul className="kv">
            <li>
              <span>Provider ref</span>
              <code>{pollOk.providerRef}</code>
            </li>
            {pollOk.amount != null && (
              <li>
                <span>Amount</span>
                {formatMoney(pollOk.amount)}
              </li>
            )}
            {pollOk.amountLow != null && pollOk.amountHigh != null && (
              <li>
                <span>Range</span>
                {formatMoney(pollOk.amountLow)}–{formatMoney(pollOk.amountHigh)}
              </li>
            )}
          </ul>
        )}
      </Card>

      <Card title="Candidate appraisal providers (licensing)">
        {providers.loading && <p className="muted">Loading registry…</p>}
        {providers.data && (
          <ul className="list">
            {providers.data.map((p) => (
              <li key={p.id} className="row">
                <span>{p.name}</span>
                <span className="row">
                  <Badge tone={p.registered ? 'ok' : 'neutral'}>
                    {p.registered ? 'registered' : p.status}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Staff trade request appraisals">
        <div className="stack">
          <label>
            Trade request ID
            <input
              value={tradeId}
              onChange={(e) => setTradeId(e.target.value)}
              placeholder="From queues or conversation trade-in"
            />
          </label>
          {tradeId.trim() && tradeAppraisals.loading && (
            <p className="muted">Loading appraisal history…</p>
          )}
          {tradeAppraisals.data && !tradeAppraisals.data.length && (
            <p className="muted">No appraisals recorded yet.</p>
          )}
          {tradeAppraisals.data && tradeAppraisals.data.length > 0 && (
            <ul className="list">
              {tradeAppraisals.data.map((a) => (
                <li key={a.id} className="row">
                  <span>
                    {a.kind} · {a.provider} · {fmtDate(a.createdAt)}
                  </span>
                  <span className="row">
                    {a.amount != null && <Badge tone="info">${a.amount.toLocaleString()}</Badge>}
                    <Badge tone={a.displayPermitted ? 'ok' : 'neutral'}>
                      {a.displayPermitted ? 'customer-visible' : 'internal'}
                    </Badge>
                    <Badge tone="neutral">{a.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="row small">
            <label>
              Staff amount $
              <input
                inputMode="numeric"
                style={{ width: 96 }}
                value={staffAmount}
                onChange={(e) => setStaffAmount(e.target.value)}
              />
            </label>
            <button
              className="btn btn--ghost"
              disabled={busy !== null || !(Number(staffAmount) > 0)}
              onClick={() =>
                void postTrade(
                  'appraisals',
                  { amount: Number(staffAmount) },
                  'Dealer appraisal recorded (internal until manager releases)',
                )
              }
            >
              Record dealer appraisal
            </button>
            <label>
              Offer valid days
              <input
                inputMode="numeric"
                style={{ width: 48 }}
                value={offerDays}
                onChange={(e) => setOfferDays(e.target.value)}
              />
            </label>
            <button
              className="btn"
              disabled={busy !== null || !(Number(staffAmount) > 0)}
              onClick={() =>
                void postTrade(
                  'offer',
                  { amount: Number(staffAmount), validDays: Number(offerDays) || 7 },
                  'Final offer issued — customer-visible when active',
                )
              }
            >
              Issue final offer
            </button>
          </div>
          {staffMsg && <p className="muted">{staffMsg}</p>}
        </div>
      </Card>
    </div>
  );
}

function formatMoney(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}
