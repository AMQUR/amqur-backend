/**
 * Last deterministic check on a conversation-lane reply. The lane cannot perform actions, so
 * a reply must never assert that one happened, that financing was approved, or expose a
 * credential-shaped string. Explanations and negations ("nothing is booked", "I can't confirm
 * an appointment", "no one can guarantee approval") pass.
 */

const NEGATION =
  /\b(?:not|no|never|none|nothing|nobody|cannot|can't|can’t|couldn't|couldn’t|won't|won’t|wouldn't|wouldn’t|isn't|isn’t|aren't|aren’t|hasn't|hasn’t|haven't|haven’t|didn't|didn’t|don't|don’t|doesn't|doesn’t|unable|without|until|unless|once|after|before|if|when|whether|only|would|could|should|might|may|sin|nunca|nadie|ningún|ninguna|nada|hasta|si|cuando)\b/i;

const ACTION_CLAIMS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\b(?:your|the|that|this)\s+(?:appointment|test[- ]drive|visit|booking|reservation|service (?:appointment|visit))\s+(?:is|has been|was|’s|'s)\s+(?:now\s+)?(?:confirmed|booked|scheduled|set|reserved)\b/i,
    reason: 'claimed an appointment was confirmed or booked',
  },
  {
    re: /\bI(?:'ve| have|’ve)?\s+(?:just\s+|now\s+|already\s+|gone ahead and\s+)?(?:booked|scheduled|reserved|confirmed|submitted|sent|forwarded|notified|emailed|texted|placed|put (?:a|the) hold)\b/i,
    reason: 'claimed to have performed an action',
  },
  {
    re: /\byou(?:'re| are|’re)\s+(?:all\s+)?(?:pre[- ]?)?approved\b|\byou(?:'ve| have|’ve)\s+been\s+(?:pre[- ]?)?approved\b|\byour\s+(?:loan|financing|credit|application)\s+(?:is|has been|was)\s+approved\b/i,
    reason: 'declared a financing approval',
  },
  {
    re: /\b(?:su|tu)\s+cita\s+(?:está|ha sido|quedó)\s+(?:confirmada|reservada|agendada)\b|\b(?:está|estás)\s+(?:pre)?aprobad[oa]\b/i,
    reason: 'claimed a confirmation or approval',
  },
];

ACTION_CLAIMS.push(
  {
    re: /\b(?:appointment|test[- ]drive|booking|reservation)\s+(?:is\s+|has been\s+)?(?:confirmed|booked)\b/i,
    reason: 'claimed an appointment was confirmed or booked',
  },
  {
    re: /\bwe(?:'ve| have|’ve)?\s+(?:just\s+|now\s+|already\s+)?(?:booked|scheduled|reserved|confirmed|submitted|sent|notified)\b/i,
    reason: 'claimed to have performed an action',
  },
  {
    re: /\b(?:the\s+)?(?:lender|bank|finance (?:team|company))\s+(?:has\s+)?approved\s+(?:you|your)\b/i,
    reason: 'declared a financing approval',
  },
  {
    re: /\b(?:su|tu)\s+cita\s+(?:ya\s+)?(?:está|ha sido|quedó)\s+(?:confirmada|reservada|agendada)\b|\b(?:le|te)\s+he\s+(?:reservado|agendado|confirmado)\b/i,
    reason: 'claimed a confirmation or approval',
  },
);

const SECRET =
  /\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/;

function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?。؟])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkConversationReply(
  reply: string,
  opts: { confirmedInContext?: boolean } = {},
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons = new Set<string>();
  if (SECRET.test(reply)) reasons.add('contained a credential-shaped string');
  for (const s of sentences(reply)) {
    // Quoted examples of what a customer or scammer might say are not claims.
    const bare = s.replace(/["“][^"”]{0,200}["”]/g, ' ');
    for (const { re, reason } of ACTION_CLAIMS) {
      const m = re.exec(bare);
      if (!m) continue;
      if (NEGATION.test(bare.slice(0, m.index + m[0].length))) continue;
      if (
        opts.confirmedInContext &&
        /appointment|visit|test[- ]drive|cita/i.test(m[0])
      )
        continue;
      // "I've sent you a list above" style self-reference to the chat itself is fine.
      if (
        reason === 'claimed to have performed an action' &&
        /\b(?:listed|included|put together|written|drafted|summarized|outlined|laid out|kept|assumed|used|added|rounded|calculated)\b/i.test(
          m[0],
        )
      )
        continue;
      reasons.add(reason);
    }
  }
  return reasons.size ? { ok: false, reasons: [...reasons] } : { ok: true };
}
