import { PlaybookService } from './playbook.service';

describe('PlaybookService.previewStyle', () => {
  const svc = new PlaybookService({} as never);

  it('accepts a short natural reply', () => {
    const r = svc.previewStyle(
      { oneQuestion: true, brevity: 'short', forbiddenPhrases: [] },
      'Yes, we have two that match. Want to see both?',
    );
    expect(r.ok).toBe(true);
    expect(r.questions).toBe(1);
  });

  it('rejects stacked questions and forbidden filler', () => {
    const r = svc.previewStyle(
      {
        oneQuestion: true,
        brevity: 'short',
        forbiddenPhrases: ["I'd be more than happy"],
      },
      "I'd be more than happy to help. What is your phone? What is your email?",
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('multiple_questions'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('forbidden_phrase'))).toBe(true);
  });
});

describe('MessagingService.nextAllowed DST-safe quiet hours', () => {
  // Import lazily to avoid pulling Nest module graph into this unit file.

  const { MessagingService } = require('../../messaging/messaging.service');

  it('defers during overnight quiet window in America/Chicago', () => {
    // 2026-03-08 22:30 CDT-ish local — quiet 21:00–08:00
    const now = new Date('2026-03-09T03:30:00.000Z'); // 22:30 CST (UTC-6) approx before DST
    const deferred = MessagingService.nextAllowed(now, {
      tz: 'America/Chicago',
      start: 21 * 60,
      end: 8 * 60,
    });
    expect(deferred).not.toBeNull();
    expect(deferred!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('allows send outside quiet hours', () => {
    const now = new Date('2026-07-15T17:00:00.000Z'); // midday Chicago
    const deferred = MessagingService.nextAllowed(now, {
      tz: 'America/Chicago',
      start: 21 * 60,
      end: 8 * 60,
    });
    expect(deferred).toBeNull();
  });
});
