import {
  DEFAULT_PUBLIC_BRANDING,
  mergePublicBranding,
} from './public-branding';

describe('mergePublicBranding', () => {
  it('uses defaults when configs empty', () => {
    const b = mergePublicBranding(null, null, null);
    expect(b.assistantDisplayName).toBe(
      DEFAULT_PUBLIC_BRANDING.assistantDisplayName,
    );
    expect(b.logoUrl).toBeNull();
  });

  it('merges location over tenant and prefers location phone', () => {
    const b = mergePublicBranding(
      {
        assistantDisplayName: 'Group Bot',
        primaryColor: '#111111',
        phone: '111',
      },
      {
        assistantDisplayName: 'Rooftop Bot',
        phone: '222',
      },
      '333',
    );
    expect(b.assistantDisplayName).toBe('Rooftop Bot');
    expect(b.phone).toBe('222');
    expect(b.primaryColor).toBe('#111111');
  });

  it('falls back to location.phone column when branding phone missing', () => {
    const b = mergePublicBranding({}, {}, '555-0100');
    expect(b.phone).toBe('555-0100');
  });
});
