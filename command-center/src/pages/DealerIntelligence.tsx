import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Stat } from '../ui';
import { completedMonthCandidates, selectedStats } from './dealer-intelligence-metrics';
import type { DiSnapshot } from './dealer-intelligence-metrics';

const number = (x: number | null) => x === null ? 'Not available' : x.toLocaleString('en-US');
const dollars = (x: number | null) => x === null ? 'Not available' : x.toLocaleString('en-US',{style:'currency',currency:'USD'});
const notes = 'Google spend, CRM leads, and DMS provisional retail candidates are different measurement cohorts. They are not vehicle-sales attribution or ROI.';

export function DealerIntelligence() {
  const query = useAsync(() => api<DiSnapshot>('/ops/dealer-intelligence/snapshot'), []);
  const [periodId,setPeriodId] = useState('last7');
  const [store,setStore] = useState('all');
  const [line,setLine] = useState('all');
  const snapshot=query.data;
  const period=snapshot?.periods.find(x=>x.id===periodId) ?? snapshot?.periods[0];
  const stats=useMemo(()=>snapshot&&period?selectedStats(snapshot,period,store,line):null,[snapshot,period,store,line]);

  const exportAggregates = () => {
    if (!snapshot || !period || !stats) return;
    // Only the currently selected, aggregate summary may leave the dashboard; no customer records.
    const fields=['store','period_start','period_end','stock_type','eligible_purchase_lead_records','provisional_retail_candidates','google_rooftop_spend_usd','unallocated_central_google_spend_usd'];
    const vals=[store,period.start,period.end,line,stats.crmLeads??'',stats.retailCandidates??'',stats.rooftopSpend??'',stats.groupSpend??''];
    const csv=fields.join(',')+'\n'+vals.map(x=>JSON.stringify(String(x))).join(',')+'\n';
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a'); a.href=url; a.download=`amqur-dial-aggregates-${snapshot.as_of}.csv`;
    a.click();URL.revokeObjectURL(url);
  };

  return <div className="page">
    <h1>Dealer Intelligence</h1>
    <p className="muted">Dial Auto Group · $0 flagship · Private executive analytics · Read-only</p>
    <ErrorNote error={query.error} />
    {query.loading && <p className="muted" aria-busy="true">Loading private reporting snapshot…</p>}
    {!query.loading && !snapshot && !query.error && <Empty>No authorized reporting snapshot has been configured.</Empty>}
    {snapshot && period && stats && <>
      <div className="row" style={{marginBottom:14}}>
        <Badge tone={snapshot.freshness.stale?'warn':'ok'}>{snapshot.freshness.stale?'Stale snapshot':'Snapshot loaded'}</Badge>
        <span className="small muted">Data cutoff: {snapshot.as_of} · {snapshot.freshness.age_days} day(s) old</span>
        <Badge tone="warn">Retail candidates, not deliveries</Badge>
      </div>
      {snapshot.freshness.stale && <p className="banner banner--warn" role="alert">This private snapshot is more than two days old. Do not use it as a current live operating report until refreshed.</p>}
      <div className="row" style={{marginBottom:16,alignItems:'end'}}>
        <label>Period
          <select aria-label="Reporting period" value={period.id} onChange={e=>setPeriodId(e.target.value)}>
            {snapshot.periods.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label>Dealership
          <select aria-label="Dealership" value={store} onChange={e=>setStore(e.target.value)}>
            <option value="all">All five rooftops</option>
            {snapshot.stores.map(x=><option value={x.key} key={x.key}>{x.name}</option>)}
          </select>
        </label>
        <label>Vehicle line
          <select aria-label="Vehicle line" value={line} onChange={e=>setLine(e.target.value)}>
            <option value="all">Combined</option><option value="new">New</option><option value="used">Used</option>
          </select>
        </label>
        <button className="btn btn--ghost" onClick={exportAggregates}>Export selected aggregates</button>
      </div>
      <div className="stats" style={{marginBottom:14}}>
        <Stat label="Eligible CRM purchase lead records" value={number(stats.crmLeads)} hint={!stats.sourceCoverage.crm?'Coverage incomplete for selected period':''} />
        <Stat label="Provisional retail deal candidates" value={number(stats.retailCandidates)} hint={!stats.sourceCoverage.dms?'Coverage incomplete for selected period':'NOT confirmed deliveries'} />
        <Stat label="Observed rooftop Google Ads spend" value={dollars(stats.rooftopSpend)} hint={line!=='all'?'Cannot allocate unclassified spend to new/used':!stats.sourceCoverage.ads?'Google coverage incomplete':''} />
        {store==='all' && <Stat label="Separate central Google Ads spend" value={dollars(stats.groupSpend)} hint="Not allocated to any rooftop" />}
      </div>
      <Card title="Measurement limitations">
        <p className="small">{notes}</p>
        <div className="row">
          {(['ads','crm','dms'] as const).map(src=><span key={src} className="small"><Badge tone={stats.sourceCoverage[src]?'ok':'warn'}>{src.toUpperCase()} {stats.sourceCoverage[src]?'full window':'partial/missing'}</Badge></span>)}
        </div>
        <ul className="small muted">{snapshot.flags.map((x,i)=><li key={i}>{x}</li>)}</ul>
      </Card>
      <Card title={`Completed-month retail candidate comparison · ${snapshot.comparison.earlier} vs ${snapshot.comparison.later}`}>
        <p className="muted small">Counts are derived from Tekion Deal List entries matching the provisional retail filter. Not accounting-posted sales.</p>
        <div style={{overflowX:'auto'}}><table className="table">
          <thead><tr><th>Dealership</th><th>Earlier</th><th>Later</th><th>Change</th><th>New (earlier → later)</th><th>Used (earlier → later)</th></tr></thead>
          <tbody>{snapshot.stores.filter(x=>store==='all'||x.key===store).map(x=>{
            const a=completedMonthCandidates(snapshot,x.key,snapshot.comparison.earlier,line);
            const b=completedMonthCandidates(snapshot,x.key,snapshot.comparison.later,line);
            const oldNew=completedMonthCandidates(snapshot,x.key,snapshot.comparison.earlier,'new');
            const newNew=completedMonthCandidates(snapshot,x.key,snapshot.comparison.later,'new');
            const oldUsed=completedMonthCandidates(snapshot,x.key,snapshot.comparison.earlier,'used');
            const newUsed=completedMonthCandidates(snapshot,x.key,snapshot.comparison.later,'used');
            return <tr key={x.key}><th scope="row">{x.name}</th><td>{a}</td><td>{b}</td>
              <td>{a===0?'N/A':((b-a)/a*100).toFixed(1)+'%'}</td>
              <td>{oldNew} → {newNew}</td><td>{oldUsed} → {newUsed}</td></tr>;
          })}</tbody>
        </table></div>
      </Card>
      <Card title="Owner action register — all require review">
        <div style={{overflowX:'auto'}}><table className="table">
          <thead><tr><th>Priority</th><th>Store</th><th>Finding / evidence</th><th>Recommended next step</th><th>Approval</th></tr></thead>
          <tbody>{snapshot.action_register.filter(a=>store==='all'||a.store==='Dial Auto Group'||a.store===snapshot.stores.find(x=>x.key===store)?.name).map((a,i)=><tr key={i}>
            <td><Badge tone={a.priority==='Critical'?'warn':'neutral'}>{a.priority}</Badge></td>
            <td>{a.store}</td><td><strong>{a.issue}</strong><p className="small muted">{a.evidence}</p></td>
            <td>{a.recommended_action}</td><td><Badge tone="warn">Needs Review</Badge></td>
          </tr>)}</tbody>
        </table></div>
      </Card>
      <p className="muted small">No production campaigns, customer messages, CRM records, budgets, or websites can be changed from this page.</p>
    </>}
  </div>;
}