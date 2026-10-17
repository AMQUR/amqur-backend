import { LeadStatus } from '@prisma/client';
import { resolveLeadStatus } from './leads.service';

describe('resolveLeadStatus', () => {
  it('stays OPEN without contact', () => {
    expect(resolveLeadStatus({ score: 20, stage: 'hot' })).toBe(
      LeadStatus.OPEN,
    );
  });

  it('marks CONTACTED when contact exists but signals are light', () => {
    expect(
      resolveLeadStatus({
        score: 3,
        stage: 'cold',
        phone: '+15551234567',
      }),
    ).toBe(LeadStatus.CONTACTED);
  });

  it('marks QUALIFIED for hot score with contact', () => {
    expect(
      resolveLeadStatus({
        score: 14,
        stage: 'hot',
        email: 'a@b.com',
      }),
    ).toBe(LeadStatus.QUALIFIED);
  });

  it('marks QUALIFIED for vehicle interest with moderate score', () => {
    expect(
      resolveLeadStatus({
        score: 7,
        stage: 'warm',
        phone: '+15551234567',
        interestedVin: '1C4HJXDG5JW123456',
      }),
    ).toBe(LeadStatus.QUALIFIED);
  });
});
