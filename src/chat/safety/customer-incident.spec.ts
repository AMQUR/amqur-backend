import { classifyCustomerIncident } from './customer-incident';

describe('classifyCustomerIncident', () => {
  it('separates rudeness, allegations, and immediate danger', () => {
    expect(
      classifyCustomerIncident('the manager was mean to me')?.severity,
    ).toBe('dissatisfaction');
    expect(classifyCustomerIncident('they yelled at me')?.severity).toBe(
      'allegation',
    );
    expect(
      classifyCustomerIncident('they tried to steal my car')?.severity,
    ).toBe('allegation');
    expect(classifyCustomerIncident('they tried to hit me')?.severity).toBe(
      'danger',
    );
  });

  it('keeps a reported name unverified and attachable to an open report', () => {
    const n = classifyCustomerIncident('his name was steve', {
      incidentActive: true,
      incidentSeverity: 'dissatisfaction',
    });
    expect(n).toMatchObject({
      reportedName: 'Steve',
      continuing: true,
      severity: 'dissatisfaction',
    });
  });

  it('treats "I am okay" as safety only after an incident is open', () => {
    expect(classifyCustomerIncident('no im okay')).toBeNull();
    expect(
      classifyCustomerIncident('no im okay', {
        incidentActive: true,
        incidentSeverity: 'danger',
      })?.safeNow,
    ).toBe(true);
  });

  it('hears that the customer is inside the dealership', () => {
    const n = classifyCustomerIncident('no im not im inside the dealership', {
      incidentActive: true,
      incidentSeverity: 'danger',
    });
    expect(n?.insideDealership).toBe(true);
    expect(n?.severity).toBe('danger');
  });

  it('does not treat "hit me up" as danger', () => {
    expect(classifyCustomerIncident('hit me up about the price')).toBeNull();
  });
});
