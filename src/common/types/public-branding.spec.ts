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
    expect(b.logoAlt).toBeNull();
  });

  it('projects logoAlt when provided', () => {
    const b = mergePublicBranding(
      { logoUrl: 'https://widget.dialusnow.com/assets/tenants/x/logo.abc.svg', logoAlt: 'X logo' },
      null,
      null,
    );
    expect(b.logoUrl).toContain('widget.dialusnow.com');
    expect(b.logoAlt).toBe('X logo');
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

  it('supports locales array and feature booleans', () => {
    const b = mergePublicBranding(
      { supportedLocales: ['en', 'es', '', 1], serviceEnabled: true },
      { partsEnabled: true },
      null,
    );
    expect(b.supportedLocales).toEqual(['en', 'es']);
    expect(b.serviceEnabled).toBe(true);
    expect(b.partsEnabled).toBe(true);
  });

  it('ignores non-string colors and keeps defaults', () => {
    const b = mergePublicBranding({ primaryColor: 123 }, null, null);
    expect(b.primaryColor).toBe(DEFAULT_PUBLIC_BRANDING.primaryColor);
  });
});
