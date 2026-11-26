import { checkConversationReply } from './reply-guard';

describe('conversation reply guard', () => {
  it.each([
    'Your appointment is confirmed for Saturday at 10.',
    "I've booked your test drive for tomorrow.",
    'Good news — you are approved for financing.',
    "You've been pre-approved, so come on in.",
    'I have sent your details to the sales team.',
    'Su cita está confirmada para el sábado.',
    'Here is the key: sk-ant-api03-abcdefghijklmnop',
  ])('rejects %j', (reply) => {
    expect(checkConversationReply(reply).ok).toBe(false);
  });

  it.each([
    'Nothing is booked yet — your appointment is not confirmed until the store replies.',
    "I can't tell you that you're approved; only a lender can do that after an application.",
    'No one can guarantee you are approved before a credit application.',
    '17% of $42,500 is **$7,225**.',
    'Islamabad is the capital of Pakistan.',
    'Once your appointment is confirmed by the store, you will get a reference number.',
    'A scammer might say "you are approved" to rush you — be careful.',
    "I've listed the three options below so you can compare them.",
    'If you are approved, the lender sets the APR based on your credit.',
  ])('accepts %j', (reply) => {
    expect(checkConversationReply(reply)).toEqual({ ok: true });
  });

  it('allows a confirmation the tools recorded', () => {
    expect(
      checkConversationReply('Your appointment is confirmed for Saturday.', {
        confirmedInContext: true,
      }).ok,
    ).toBe(true);
  });
});
