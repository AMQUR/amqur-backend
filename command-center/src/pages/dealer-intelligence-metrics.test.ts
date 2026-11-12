import { describe, expect, it } from 'vitest';
import { completedMonthCandidates, hasWholePeriod, selectedStats } from './dealer-intelligence-metrics';
import type { DiSnapshot } from './dealer-intelligence-metrics';

const snapshot: DiSnapshot = {
  schema:'amqur.dealer-intelligence.private-preview.v1', name:'Dial Auto Group', as_of:'2026-11-10', status:'PROVISIONAL',synthetic:false,
  freshness:{age_days:1,stale:false}, stores:[{key:'nissan',name:'Dial Nissan of Chicago'}],
  periods:[{id:'last7',label:'Nov 4-10',start:'2026-11-04',end:'2026-11-10'}],
  comparison:{earlier:'2026-09',later:'2026-10'},
  coverage:{ads:{rows:2,start:'2026-11-04',end:'2026-11-10',description:''},crm:{rows:1,start:'2026-11-10',end:'2026-11-10',description:''},dms:{rows:3,start:'2026-09-01',end:'2026-11-10',description:''}},
  totals:{provisional_retail_candidates:4,crm_purchase_lead_records:11,connected_google_spend_usd:31,unallocated_group_google_spend_usd:10},
  flags:[],notes:[],action_register:[],
  ads:[{date:'2026-11-10',store:'nissan',platform:'google_ads',business_line:'unclassified',spend_usd:21,impressions:90,clicks:10,reported_conversions:2},
       {date:'2026-11-10',store:'group',platform:'google_ads',business_line:'unclassified',spend_usd:10,impressions:30,clicks:3,reported_conversions:0}],
  crm:[{date:'2026-11-10',store:'nissan',business_line:'new',leads:11,appointments:null,shows:null,sold:null}],
  dms:[{date:'2026-09-01',store:'nissan',business_line:'new',retail_candidates:2},
       {date:'2026-10-01',store:'nissan',business_line:'new',retail_candidates:1},
       {date:'2026-11-10',store:'nissan',business_line:'new',retail_candidates:1}],
};
describe('Dealer Intelligence KPI guardrails',()=>{
  it('keeps central Google spend separate and reports incomplete CRM coverage',()=>{
    const s=selectedStats(snapshot,snapshot.periods[0],'all','all');
    expect(s.rooftopSpend).toBe(21);expect(s.groupSpend).toBe(10);
    expect(s.crmLeads).toBe(11);expect(s.retailCandidates).toBe(1);
    expect(s.sourceCoverage.crm).toBe(false);
  });
  it('never allocates unclassified advertising spend to new or used cars',()=>{
    const s=selectedStats(snapshot,snapshot.periods[0],'nissan','new');
    expect(s.rooftopSpend).toBeNull();expect(s.groupSpend).toBeNull();
    expect(s.crmLeads).toBe(11);
  });
  it('does not confuse no rows with zero business outcomes',()=>{
    const r={id:'p',label:'Aug',start:'2026-08-01',end:'2026-08-31'};
    const s=selectedStats(snapshot,r,'nissan','all');
    expect(s.crmLeads).toBeNull();expect(s.retailCandidates).toBeNull();
    expect(hasWholePeriod(snapshot.coverage.crm,r)).toBe(false);
  });
  it('compares provisional candidate cohorts without counting the current month',()=>{
    expect(completedMonthCandidates(snapshot,'nissan','2026-09')).toBe(2);
    expect(completedMonthCandidates(snapshot,'nissan','2026-10')).toBe(1);
  });
});