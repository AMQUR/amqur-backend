import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, logout, session, tryRestore } from './api';
import { useAsync, useHashRoute } from './hooks';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Inbox } from './pages/Inbox';
import { Appointments } from './pages/Appointments';
import { Queues } from './pages/Queues';
import { Knowledge } from './pages/Knowledge';
import { Integrations } from './pages/Integrations';
import { Settings } from './pages/Settings';
import { Ops } from './pages/Ops';
import { Security } from './pages/Security';
import { Group } from './pages/Group';
import { Spotlights } from './pages/Spotlights';
import { ConversationStudio } from './pages/ConversationStudio';
import { Campaigns } from './pages/Campaigns';
import { ActionPages } from './pages/ActionPages';
import { SoldDeals } from './pages/SoldDeals';
import { Reviews } from './pages/Reviews';
import { CallQa } from './pages/CallQa';
import { DocumentSigning } from './pages/DocumentSigning';

const NAV: Array<{ id: string; label: string; roles?: string[] }> = [
  { id: 'home', label: 'Today' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'appointments', label: 'Appointments' },
  { id: 'queues', label: 'Service · Parts · Finance' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'studio', label: 'Conversation Studio', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'campaigns', label: 'Campaigns', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'action-pages', label: 'Action pages', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'sold-deals', label: 'Sold deals', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'reviews', label: 'Reviews (GBP)', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'call-qa', label: 'Call QA', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'document-signing', label: 'Document signing', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'spotlights', label: 'Spotlights' },
  { id: 'integrations', label: 'Integrations', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'settings', label: 'Rooftop settings', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'ops', label: 'Delivery failures', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { id: 'group', label: 'Group comparison' },
  { id: 'security', label: 'Security' },
];

type Loc = { id: string; name: string; slug: string };

export function App() {
  const user = useSyncExternalStore(session.subscribe, () => session.user);
  const [booting, setBooting] = useState(true);
  const [enrollRequired, setEnrollRequired] = useState(false);
  const [route, go] = useHashRoute();
  useEffect(() => {
    void tryRestore().finally(() => setBooting(false));
  }, []);
  if (booting) return <div className="boot" aria-busy="true" />;
  if (!user) return <Login onDone={(req) => { setEnrollRequired(req); if (req) go('security'); }} />;
  return <Shell route={enrollRequired ? 'security' : route} go={go} role={user.role} name={`${user.firstName} ${user.lastName}`} boundLocation={user.locationId} enrollRequired={enrollRequired} onEnrolled={() => setEnrollRequired(false)} />;
}

function Shell(props: { route: string; go: (r: string) => void; role: string; name: string; boundLocation: string | null; enrollRequired: boolean; onEnrolled: () => void }) {
  const locs = useAsync(() => api<Loc[]>('/locations'), []);
  const bound = props.boundLocation && ['STAFF', 'MANAGER'].includes(props.role) ? props.boundLocation : null;
  const [locationId, setLocationId] = useState<string>(() => bound ?? localStorage.getItem('amqur_cc_loc') ?? '');
  useEffect(() => {
    if (!locationId && locs.data?.length === 1) setLocationId(locs.data[0].id);
  }, [locs.data, locationId]);
  useEffect(() => {
    try {
      localStorage.setItem('amqur_cc_loc', locationId);
    } catch {
      /* ignore */
    }
  }, [locationId]);
  const nav = NAV.filter((n) => !n.roles || n.roles.includes(props.role));
  const route = nav.some((n) => n.id === props.route) ? props.route : 'home';
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <nav className="side" aria-label="Main">
        <div className="brand">Command Center</div>
        <label className="loc">
          <span className="sr">Rooftop</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!!bound}>
            {!bound && <option value="">All rooftops</option>}
            {(locs.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
        <ul>
          {nav.map((n) => (
            <li key={n.id}>
              <a href={`#/${n.id}`} aria-current={route === n.id ? 'page' : undefined}>{n.label}</a>
            </li>
          ))}
        </ul>
        <div className="me">
          <div className="small">{props.name}</div>
          <div className="muted small">{props.role}</div>
          <button className="btn btn--ghost" onClick={() => void logout()}>Sign out</button>
        </div>
      </nav>
      <main id="main" tabIndex={-1}>
        {route === 'home' && <Home locationId={locationId} />}
        {route === 'inbox' && <Inbox locationId={locationId} />}
        {route === 'appointments' && <Appointments locationId={locationId} />}
        {route === 'queues' && <Queues locationId={locationId} />}
        {route === 'knowledge' && <Knowledge locationId={locationId} />}
        {route === 'studio' && <ConversationStudio locationId={locationId} />}
        {route === 'campaigns' && <Campaigns locationId={locationId} />}
        {route === 'action-pages' && <ActionPages locationId={locationId} />}
        {route === 'sold-deals' && <SoldDeals locationId={locationId} />}
        {route === 'reviews' && <Reviews locationId={locationId} />}
        {route === 'call-qa' && <CallQa locationId={locationId} />}
        {route === 'document-signing' && <DocumentSigning locationId={locationId} />}
        {route === 'integrations' && <Integrations />}
        {route === 'settings' && <Settings locationId={locationId} />}
        {route === 'ops' && <Ops />}
        {route === 'group' && <Group />}
        {route === 'spotlights' && <Spotlights locationId={locationId} />}
        {route === 'security' && <Security required={props.enrollRequired} />}
      </main>
    </div>
  );
}
