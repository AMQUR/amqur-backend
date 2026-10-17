import { api } from '../api';
import { fmtDate, useAsync } from '../hooks';
import { Badge, Card, ErrorNote } from '../ui';

type Integ = {
  tekion: { status: string; detail: string; capabilities: Record<string, boolean>; writebackGate: { open: boolean; reason?: string }; connections: Array<{ id: string; enabled: boolean; liveReady: boolean; credentialConfigured: boolean; config: { environment: string | null; dealerId: string | null } }> };
  llm: Array<{ provider: string; configured: boolean; circuitOpen: boolean; failures: number }>;
  connections: Array<{ id: string; provider: string; capability: string; enabled: boolean; liveReady: boolean; healthStatus: string; lastSuccessAt: string | null; lastError: string | null; credentialConfigured: boolean; circuitOpenUntil: string | null }>;
  messaging: Record<string, string>;
  errorMonitoring: { sentryConfigured: boolean };
  crmWebhook: { configured: boolean; signed: boolean };
  metaLeadAds?: {
    inbox: { pendingMaterialization: number; failed: number };
    webhookIntakeConfigured: boolean;
    graphAccessTokenConfigured: boolean;
    note: string;
  };
};

export function Integrations() {
  const { data, error } = useAsync(() => api<Integ>('/ops/integrations'), []);
  return (
    <div className="page">
      <h1>Integrations</h1>
      <ErrorNote error={error} />
      {data && (
        <>
          <Card title="Tekion" actions={<Badge tone={data.tekion.status === 'healthy' ? 'ok' : 'warn'}>{data.tekion.status.replace(/_/g, ' ')}</Badge>}>
            <p className="muted small">{data.tekion.detail}</p>
            <p>CRM writeback: <Badge tone={data.tekion.writebackGate.open ? 'ok' : 'neutral'}>{data.tekion.writebackGate.open ? 'enabled' : `off — ${data.tekion.writebackGate.reason?.replace(/_/g, ' ')}`}</Badge></p>
            <div className="caps">
              {Object.entries(data.tekion.capabilities).map(([k, v]) => (
                <Badge key={k} tone={v ? 'ok' : 'neutral'}>{k}</Badge>
              ))}
            </div>
            {data.tekion.connections.map((c) => (
              <p key={c.id} className="small">Connection {c.config.environment ?? 'unset'} · dealer {c.config.dealerId ?? '—'} · credential {c.credentialConfigured ? 'stored' : 'missing'} · {c.enabled ? 'enabled' : 'disabled'} · {c.liveReady ? 'live-ready' : 'not live-ready'}</p>
            ))}
          </Card>
          {data.metaLeadAds && (
            <Card title="Meta Lead Ads">
              <p>
                Meta Lead Ads inbox:{' '}
                <Badge tone={data.metaLeadAds.inbox.pendingMaterialization ? 'warn' : 'ok'}>
                  {data.metaLeadAds.inbox.pendingMaterialization} pending materialization
                </Badge>
                {data.metaLeadAds.inbox.failed > 0 && (
                  <>
                    {' · '}
                    <Badge tone="bad">{data.metaLeadAds.inbox.failed} failed</Badge>
                  </>
                )}
              </p>
              <ul className="kv">
                <li>
                  <span>Webhook intake</span>
                  <Badge tone={data.metaLeadAds.webhookIntakeConfigured ? 'ok' : 'neutral'}>
                    {data.metaLeadAds.webhookIntakeConfigured ? 'env configured' : 'not configured'}
                  </Badge>
                </li>
                <li>
                  <span>Graph access token</span>
                  <Badge tone={data.metaLeadAds.graphAccessTokenConfigured ? 'ok' : 'warn'}>
                    {data.metaLeadAds.graphAccessTokenConfigured
                      ? 'configured'
                      : 'missing — full PII fetch unavailable'}
                  </Badge>
                </li>
              </ul>
              <p className="muted small">{data.metaLeadAds.note}</p>
            </Card>
          )}
          <div className="grid2">
            <Card title="AI providers">
              <ul className="kv">
                {data.llm.map((l) => (
                  <li key={l.provider}><span>{l.provider}</span><Badge tone={!l.configured ? 'neutral' : l.circuitOpen ? 'bad' : 'ok'}>{!l.configured ? 'not configured' : l.circuitOpen ? `circuit open (${l.failures} failures)` : 'healthy'}</Badge></li>
                ))}
              </ul>
              <p className="muted small">If every provider is down, deterministic dealership flows keep working.</p>
            </Card>
            <Card title="Channels & monitoring">
              <ul className="kv">
                {Object.entries(data.messaging).map(([k, v]) => <li key={k}><span>{k.toUpperCase()}</span><Badge>{v.replace(/_/g, ' ')}</Badge></li>)}
                <li><span>CRM webhook</span><Badge tone={data.crmWebhook.configured ? 'ok' : 'neutral'}>{data.crmWebhook.configured ? (data.crmWebhook.signed ? 'configured · signed' : 'configured · unsigned') : 'not configured'}</Badge></li>
                <li><span>Error monitoring</span><Badge tone={data.errorMonitoring.sentryConfigured ? 'ok' : 'warn'}>{data.errorMonitoring.sentryConfigured ? 'configured' : 'DSN missing'}</Badge></li>
              </ul>
            </Card>
          </div>
          <Card title="All connections">
            <table className="table">
              <thead><tr><th>Provider</th><th>Capability</th><th>State</th><th>Health</th><th>Last success</th><th>Last error</th></tr></thead>
              <tbody>
                {data.connections.map((c) => (
                  <tr key={c.id}><td>{c.provider}</td><td>{c.capability}</td><td>{c.enabled ? 'enabled' : 'disabled'} · {c.liveReady ? 'live-ready' : 'not live-ready'} · cred {c.credentialConfigured ? '✓' : '—'}</td><td><Badge tone={c.healthStatus === 'HEALTHY' ? 'ok' : c.healthStatus === 'UNKNOWN' ? 'neutral' : 'warn'}>{c.healthStatus}</Badge></td><td className="small">{fmtDate(c.lastSuccessAt)}</td><td className="small">{c.lastError ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
