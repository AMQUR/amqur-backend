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
    ['password is: hunter2', 'hunter2'],
    ['my password for the portal is Hunter2!', 'Hunter2!'],
    ["my password's Hunter2now", 'Hunter2now'],
    ['mi contraseña es Hunter2', 'Hunter2'],
    ['password is "my dog Rex 2019"', 'Rex 2019'],
    ['username: samdemo : Hunter2-demo', 'Hunter2-demo'],
    ['login = alex.sample | Hunter2-demo', 'Hunter2-demo'],
    ['my login is alexsample:Hunter2-demo', 'Hunter2-demo'],
    ['user alex.sample@example.com:Hunter2-demo thanks', 'Hunter2-demo'],
    ['credentials: samdemo/Hunter2-demo', 'Hunter2-demo'],
    [
      'password is "' +
        'correct horse battery staple '.repeat(4) +
        'zebra-tail"',
      'zebra-tail',
    ],
    ['password is "never closed quote ends-here', 'ends-here'],
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
    'my account was charged twice: please check',
    'user alex signed in fine yesterday',
    'my login time was around 10:30 today',
    'login help: please call me back',
    'the login page is https://example.com/owners',
    'sign in here: it keeps failing',
  ])('leaves ordinary sentences alone: %s', (text) => {
    expect(redactCreditSensitive(text)).toBe(text);
  });

  it('stays linear on hostile input (the first login pattern was quadratic)', () => {
    for (const unit of [
      'user.',
      'account.',
      'login /',
      'password ',
      'sign in with a',
      'login a',
      'user: abc ',
      'username x.y ',
    ]) {
      const text = unit.repeat(Math.ceil(20_000 / unit.length));
      const started = Date.now();
      redactCreditSensitive(text);
      expect(Date.now() - started).toBeLessThan(150);
    }
  });
});
