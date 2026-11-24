import { redactCreditSensitive } from './sensitive-data';

describe('passwords and logins are redacted before a message is stored', () => {
  it.each([
    [
      'my login is alex.sample@example.com / Passw0rd-demo, go look at my account',
      'Passw0rd-demo',
    ],
    ['username: samdemo password: hunter2-test', 'hunter2-test'],
    ['sign in with samdemo:Tr0ub4dor-test please', 'Tr0ub4dor-test'],
    ['my password is CorrectHorse-9', 'CorrectHorse-9'],
    ['pw = abc12345', 'abc12345'],
    ['PIN: 4821', '4821'],
  ])('%s', (text, secret) => {
    const out = redactCreditSensitive(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it.each([
    'I forgot my password, can you help?',
    'How do I reset my password for the owner portal?',
    'Is the password policy strict?',
    'What is a good password manager?',
    'My account is fine, thanks.',
    'Can I log in to see my service history?',
    'The ratio is 3:1 on that axle.',
  ])('leaves ordinary sentences alone: %s', (text) => {
    expect(redactCreditSensitive(text)).toBe(text);
  });
});
