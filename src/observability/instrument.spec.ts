import { scrubForMonitoring } from './instrument';

describe('error-monitoring redaction', () => {
  it('scrubs database connection strings', () => {
    expect(
      scrubForMonitoring('failed: postgresql://user:pw@host:5432/db timeout'),
    ).toBe('failed: [REDACTED] timeout');
    expect(scrubForMonitoring('redis://default:pw@redis:6379 down')).toBe(
      '[REDACTED] down',
    );
  });

  it('scrubs bearer tokens and JWT-like strings', () => {
    expect(
      scrubForMonitoring(
        'auth failed for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y',
      ),
    ).not.toContain('eyJ');
  });

  it('scrubs customer emails and phone numbers', () => {
    const out = scrubForMonitoring(
      'lead failed for jane.doe@example.com at +1 (312) 555-0142',
    );
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).not.toContain('555');
  });

  it('scrubs key=value secrets', () => {
    const out = scrubForMonitoring('config error: API_KEY=sk-abc123xyz oops');
    expect(out).not.toContain('sk-abc123xyz');
  });

  it('leaves ordinary error text intact', () => {
    expect(scrubForMonitoring('Tenant not found: jeep-of-chicago')).toBe(
      'Tenant not found: jeep-of-chicago',
    );
  });
});
