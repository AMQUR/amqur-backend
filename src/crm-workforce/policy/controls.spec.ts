import {
  ControlRow,
  isCompleteAuthorization,
  resolveControl,
  scopeKeys,
} from './controls';

const T = {
  tenantId: 't1',
  locationId: 'l1',
  department: 'SALES' as const,
  workflowKey: 'first_response' as const,
};
const ON = {
  CRM_WORKFORCE_ENABLED: 'true',
  CRM_WORKFORCE_EXTERNAL_SEND_ENABLED: 'true',
} as NodeJS.ProcessEnv;
const row = (
  scope: ControlRow['scope'],
  scopeKey: string,
  p: Partial<ControlRow> = {},
): ControlRow => ({
  scope,
  scopeKey,
  halted: false,
  mode: 'SUPERVISED',
  externalSendEnabled: true,
  ...p,
});
const auth = {
  documentRef: 'DOC-1',
  authorizedBy: 'gm',
  authorizedAt: '2026-11-01T00:00:00Z',
  audience: 'new internet leads',
  channels: ['SMS'],
  dailyLimit: 25,
  window: { start: '09:00', end: '18:00' },
};

describe('CRM Workforce controls', () => {
  it('starts every rooftop in OBSERVE with external sending off', () => {
    const c = resolveControl(T, [], ON);
    expect(c.mode).toBe('OBSERVE');
    expect(c.externalSendAllowed).toBe(false);
    expect(c.externalSendBlocks).toContain('location_not_configured');
  });

  it('is off when the process switch is off, whatever the rows say', () => {
    const c = resolveControl(
      T,
      [row('LOCATION', scopeKeys.location('t1', 'l1'))],
      {} as NodeJS.ProcessEnv,
    );
    expect(c.processEnabled).toBe(false);
    expect(c.externalSendAllowed).toBe(false);
    expect(c.externalSendBlocks).toEqual(
      expect.arrayContaining(['process_switch_off', 'external_send_env_off']),
    );
  });

  it.each([
    ['global', row('GLOBAL', scopeKeys.global(), { halted: true })],
    ['tenant', row('TENANT', scopeKeys.tenant('t1'), { halted: true })],
    [
      'department',
      row('DEPARTMENT', scopeKeys.department('t1', 'l1', 'SALES'), {
        halted: true,
      }),
    ],
    [
      'workflow',
      row('WORKFLOW', scopeKeys.workflow('t1', 'l1', 'first_response'), {
        halted: true,
      }),
    ],
  ])('%s kill switch halts the work', (_n, kill) => {
    const c = resolveControl(
      T,
      [row('LOCATION', scopeKeys.location('t1', 'l1')), kill],
      ON,
    );
    expect(c.halted).toBe(true);
    expect(c.externalSendAllowed).toBe(false);
  });

  it('a kill switch for another rooftop, department or workflow does not apply', () => {
    const c = resolveControl(
      T,
      [
        row('LOCATION', scopeKeys.location('t1', 'l1')),
        row('LOCATION', scopeKeys.location('t2', 'l9'), { halted: true }),
        row('DEPARTMENT', scopeKeys.department('t1', 'l1', 'SERVICE'), {
          halted: true,
        }),
        row(
          'WORKFLOW',
          scopeKeys.workflow('t1', 'l1', 'recovery_reactivation'),
          { halted: true },
        ),
      ],
      ON,
    );
    expect(c.halted).toBe(false);
  });

  it("pausing a salesperson halts only that salesperson's leads", () => {
    const rows = [
      row('LOCATION', scopeKeys.location('t1', 'l1')),
      row('SALESPERSON', scopeKeys.salesperson('t1', 'l1', 'Pat Lee'), {
        halted: true,
      }),
    ];
    expect(
      resolveControl({ ...T, assignedTo: ' pat lee ' }, rows, ON).halted,
    ).toBe(true);
    expect(
      resolveControl({ ...T, assignedTo: 'Sam Roe' }, rows, ON).halted,
    ).toBe(false);
  });

  it('the least autonomous mode on the path wins', () => {
    const c = resolveControl(
      T,
      [
        row('LOCATION', scopeKeys.location('t1', 'l1'), {
          mode: 'CONTROLLED_AUTONOMOUS',
        }),
        row('DEPARTMENT', scopeKeys.department('t1', 'l1', 'SALES'), {
          mode: 'ASSIST',
        }),
      ],
      ON,
    );
    expect(c.mode).toBe('ASSIST');
    expect(c.externalSendAllowed).toBe(false);
  });

  it('the emergency env stop halts without any database row', () => {
    const c = resolveControl(
      T,
      [row('LOCATION', scopeKeys.location('t1', 'l1'))],
      { ...ON, CRM_WORKFORCE_EMERGENCY_STOP: 'true' },
    );
    expect(c.haltedBy).toContain('ENV:EMERGENCY_STOP');
  });

  it('controlled autonomy needs a complete, unexpired workflow authorization', () => {
    const loc = row('LOCATION', scopeKeys.location('t1', 'l1'), {
      mode: 'CONTROLLED_AUTONOMOUS',
    });
    expect(resolveControl(T, [loc], ON).externalSendBlocks).toContain(
      'workflow_not_authorized',
    );
    const wf = row(
      'WORKFLOW',
      scopeKeys.workflow('t1', 'l1', 'first_response'),
      { mode: 'CONTROLLED_AUTONOMOUS', authorization: auth },
    );
    expect(resolveControl(T, [loc, wf], ON).externalSendAllowed).toBe(true);
    expect(isCompleteAuthorization({ ...auth, dailyLimit: 0 })).toBe(false);
    expect(isCompleteAuthorization({ ...auth, channels: [] })).toBe(false);
    expect(
      isCompleteAuthorization({ ...auth, expiresAt: '2020-01-01T00:00:00Z' }),
    ).toBe(false);
  });

  it('a row that only carries a kill switch changes nothing once it is released', () => {
    const loc = row('LOCATION', scopeKeys.location('t1', 'l1'));
    const kill = (halted: boolean) => [
      row('GLOBAL', scopeKeys.global(), {
        halted,
        mode: null,
        externalSendEnabled: null,
      }),
      row('DEPARTMENT', scopeKeys.department('t1', 'l1', 'SALES'), {
        halted,
        mode: null,
        externalSendEnabled: null,
      }),
    ];
    expect(resolveControl(T, [loc, ...kill(true)], ON).halted).toBe(true);
    const released = resolveControl(T, [loc, ...kill(false)], ON);
    expect(released).toMatchObject({
      halted: false,
      mode: 'SUPERVISED',
      externalSendAllowed: true,
    });
  });

  it('a rooftop row that does not explicitly allow sending keeps it off', () => {
    const c = resolveControl(
      T,
      [
        row('LOCATION', scopeKeys.location('t1', 'l1'), {
          externalSendEnabled: null,
        }),
      ],
      ON,
    );
    expect(c.externalSendBlocks).toContain('send_disabled:L:t1:l1');
  });

  it('supervised sending needs every configured row to allow it', () => {
    const c = resolveControl(
      T,
      [
        row('GLOBAL', scopeKeys.global(), { mode: 'CONTROLLED_AUTONOMOUS' }),
        row('LOCATION', scopeKeys.location('t1', 'l1')),
        row('DEPARTMENT', scopeKeys.department('t1', 'l1', 'SALES'), {
          externalSendEnabled: false,
        }),
      ],
      ON,
    );
    expect(c.externalSendAllowed).toBe(false);
    expect(c.externalSendBlocks).toContain('send_disabled:D:t1:l1:SALES');
  });
});
