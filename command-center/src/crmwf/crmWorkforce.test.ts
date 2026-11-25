import { describe, expect, it } from 'vitest';
import { actionLabel, actionTone, blockText, capabilityTone, countTasks, duration, sendingState, usd, workforceState, type Status } from './crmWorkforce';

const base: Status = { featureFlag: true, processEnabled: true, externalSendEnv: false, emergencyStopEnv: false, globalHalted: false, controls: [], workers: [{ workerId: 'w', role: 'worker', state: 'RUNNING', lastBeatAt: '', startedAt: '' }], connectors: [] };
const loc = (p: object) => ({ id: 'c', scope: 'LOCATION', scopeKey: 'L', tenantId: 't', locationId: 'l1', department: null, subjectKey: null, halted: false, mode: 'SUPERVISED' as const, externalSendEnabled: true, reason: null, updatedAt: '', ...p });

describe('CRM Workforce view logic', () => {
  it('shows off, stopped, paused, disconnected, degraded and live accurately', () => {
    expect(workforceState({ ...base, featureFlag: false }).label).toBe('OFF');
    expect(workforceState({ ...base, globalHalted: true }).label).toBe('STOPPED');
    expect(workforceState({ ...base, emergencyStopEnv: true }).label).toBe('STOPPED');
    expect(workforceState({ ...base, processEnabled: false }).label).toBe('PAUSED');
    expect(workforceState({ ...base, workers: [] }).label).toBe('DISCONNECTED');
    expect(workforceState({ ...base, workers: [{ ...base.workers[0], state: 'DOWN' }] }).label).toBe('DISCONNECTED');
    expect(workforceState({ ...base, controls: [loc({ halted: true })] }).label).toBe('PARTLY PAUSED');
    expect(workforceState({ ...base, connectors: [{ adapterKey: 'x', label: 'x', requiresAuthorization: false, capabilities: [], connections: [{ id: '1', locationId: 'l1', enabled: true, status: 'SESSION_EXPIRED', statusReason: null, authorizationRef: null, authorizedAt: null, lastHealthAt: null, lastSyncAt: null, lastError: null }] }] }).label).toBe('DEGRADED');
    expect(workforceState(base).label).toBe('LIVE');
  });

  it('never implies customer sending is on unless every switch is', () => {
    expect(sendingState(base, 'l1').label).toBe('Customer sending: OFF');
    expect(sendingState({ ...base, controls: [loc({})] }, 'l1').label).toBe('Customer sending: OFF');
    expect(sendingState({ ...base, externalSendEnv: true, controls: [loc({ mode: 'ASSIST' })] }, 'l1').label).toContain('OFF');
    expect(sendingState({ ...base, externalSendEnv: true, controls: [loc({ externalSendEnabled: null })] }, 'l1').label).toBe('Customer sending: OFF');
    expect(sendingState({ ...base, externalSendEnv: true, controls: [loc({})] }, 'l2').label).toBe('Customer sending: OFF');
    expect(sendingState({ ...base, externalSendEnv: true, controls: [loc({})] }, 'l1').label).toBe('Customer sending: ON (Supervised)');
  });

  it('only a CRM-confirmed message is called sent', () => {
    expect(actionLabel('VERIFIED')).toBe('Sent (confirmed in CRM)');
    for (const s of ['APPROVED', 'QUEUED', 'SENT_UNVERIFIED', 'UNCERTAIN', 'BLOCKED', 'FAILED', 'CANCELLED', 'PENDING_APPROVAL', 'DRAFT'])
      expect(actionLabel(s)).not.toMatch(/^Sent/);
    expect(actionLabel('STAFF_CONFIRMED')).toContain('their statement');
    expect(actionTone('VERIFIED')).toBe('ok');
    expect(actionTone('UNCERTAIN')).toBe('bad');
    expect(actionTone('SENT_UNVERIFIED')).toBe('bad');
  });

  it('only verified capabilities are green; demo and blocked are not', () => {
    expect(capabilityTone('LIVE VERIFIED')).toBe('ok');
    expect(capabilityTone('SANDBOX VERIFIED')).toBe('ok');
    expect(capabilityTone('DEMO')).toBe('info');
    expect(capabilityTone('BLOCKED')).toBe('warn');
    expect(capabilityTone('NOT TESTED')).toBe('neutral');
  });

  it('explains compliance blocks in plain words', () => {
    expect(blockText({ rule: 'no_consent' })).toBe('No consent on record for this channel');
    expect(blockText({ rule: 'control', detail: 'send_disabled:L:t:l' })).toContain('switched off');
    expect(blockText({ rule: 'control', detail: 'external_send_env_off' })).toBe('Customer sending is off for this deployment');
    expect(blockText({ rule: 'something_new' })).toBe('something new');
  });

  it('shows missing numbers as missing, not as zero', () => {
    expect(usd(null)).toBe('No data yet');
    expect(usd(0)).toBe('$0.00');
    expect(usd(90)).toBe('$0.0001');
    expect(usd(2_500_000)).toBe('$2.50');
    expect(duration(null)).toBe('No data yet');
    expect(duration(45)).toBe('45s');
    expect(duration(600)).toBe('10 min');
    expect(countTasks(null, () => true)).toBe(0);
  });
});
