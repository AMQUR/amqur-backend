import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseInput, sevenDays, createReport } from './scorecard.mjs';

const keys = ['chevy', 'nissan', 'infiniti', 'cdjr-south', 'jeep-north', 'group'];
const registry = { rooftops: keys.filter(k => k !== 'group').map(key => ({ key, displayName: key })) };
const adsHeader = 'date,store,platform,business_line,spend_usd,impressions,clicks,reported_conversions\n';
const crmHeader = 'date,store,business_line,leads,appointments,shows,sold\n';

test('CSV parser handles quoted commas, escaping and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"with,comma","hello""world"\r\n'), [['a','b'],['with,comma','hello"world']]);
});
test('rejects arbitrary personal-information columns', () => {
  assert.throws(() => parseInput('crm', crmHeader.trim() + ',customer_email\n', keys), /headers must be exactly/);
});
test('rejects negative and malformed numerics', () => {
  assert.throws(() => parseInput('ads', adsHeader + '2026-11-10,nissan,google_ads,new,-20,1,1,1\n', keys), /invalid spend_usd/);
  assert.throws(() => parseInput('crm', crmHeader + '2026-11-10,nissan,new,1,1,1,1.5\n', keys), /invalid sold/);
});
test('rejects unknown tenant and malformed calendar date', () => {
  assert.throws(() => parseInput('ads', adsHeader + '2026-11-10,other,google_ads,new,2,1,1,1\n', keys), /unknown store/);
  assert.throws(() => parseInput('ads', adsHeader + '2026-02-30,nissan,google_ads,new,2,1,1,1\n', keys), /invalid date/);
});
test('rejects duplicate aggregates to avoid double-counting', () => {
  const row = '2026-11-10,nissan,google_ads,new,2,1,1,1\n';
  assert.throws(() => parseInput('ads', adsHeader + row + row, keys), /duplicate aggregate key/);
});
test('7-day window uses complete dates and excludes older observations', () => {
  assert.deepEqual(sevenDays('2026-11-10'), ['2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08','2026-11-09','2026-11-10']);
  const ads = parseInput('ads', adsHeader + '2026-11-03,nissan,google_ads,unclassified,99,1,1,1\n2026-11-10,nissan,google_ads,unclassified,10,1,1,1\n', keys);
  const r = createReport({ registry, datasets: { ads }, asOf: '2026-11-10' }).json;
  assert.equal(r.stores.find(x=>x.id==='nissan').metrics.ad_spend_connected_usd, 10);
});
test('missing CRM is unknown, not zero, and produces unapproved action', () => {
  const ads = parseInput('ads', adsHeader + '2026-11-10,nissan,google_ads,unclassified,10,2,1,1.5\n2026-11-10,group,google_ads,unclassified,3,2,1,1\n', keys);
  const r = createReport({ registry, datasets: { ads }, asOf: '2026-11-10' }).json;
  assert.equal(r.stores.find(x=>x.id==='nissan').metrics.crm_leads, null);
  assert.equal(r.group.central_campaign_spend_usd, 3);
  assert.equal(r.group.rooftop_spend_usd, 10);
  assert.equal(r.group.connected_platform_ad_spend_usd, 13);
  assert.equal(r.action_register[0].approval_status, 'Needs Review');
  assert.equal(r.action_register[0].implemented, 'No');
});
test('preserves fractional platform-reported conversions without relabeling as leads', () => {
  const ads = parseInput('ads', adsHeader + '2026-11-10,nissan,google_ads,unclassified,10,1,1,2.25\n', keys);
  const r = createReport({ registry, datasets: { ads }, asOf: '2026-11-10' }).json;
  assert.equal(r.stores.find(x=>x.id==='nissan').metrics.reported_platform_conversions, 2.25);
  assert.equal(r.stores.find(x=>x.id==='nissan').metrics.crm_leads, null);
});
