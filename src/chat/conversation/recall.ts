/**
 * A question about what the customer themselves said earlier in this chat ("what am I trading
 * in?", "what's my budget now?", "what did I ask first?"). Only the conversation model has the
 * whole transcript, so these never belong to a keyword-matched tool, whatever nouns they hold.
 * Patterns are anchored on first-person recall phrasing; a request for the dealership to do
 * or look up something ("what's my trade worth?", "what's my payment on this one?") is not one.
 */
const RECALL: RegExp[] = [
  /\bwhat (?:am|was) i (?:trading(?: in)?|looking for|shopping for|asking(?: about| for)?|after)\b/i,
  /\bwhat(?:'s| is| was| are| were)? my (?:name|budget|price range|spending limit|limit|total|commute|trade(?:[- ]in)?(?![- ]in)(?! (?:worth|value|appraisal|offer))|first (?:\w+ )?(?:question|message)|last (?:\w+ )?(?:question|message))\b(?! (?:worth|value))/i,
  /\bwhat (?:did|have) i (?:just )?(?:say|said|tell|told|ask|asked|mention|mentioned|want|wanted)\b/i,
  /\bwhat (?:was|were) (?:the|my) (?:first|last|previous|earlier) (?:\w+ ){0,2}(?:questions?|messages?|things?) i\b/i,
  /\b(?:do|can) you (?:still )?(?:remember|recall)\b/i,
  /\bremind me (?:what|which|how)\b/i,
  /\bhow many (?:\w+ ){0,4}(?:did i (?:say|mention|tell)|are on (?:it|my trade))\b/i,
  /\b(?:what|which) (?:colou?r|body style|model|vehicle|car|truck|suv)(?: and [\w ]{1,20})? (?:am|was) i (?:looking|shopping|asking|after)\b/i,
  /\b(?:summary|summari[sz]e|recap)\b[^.?!\n]{0,40}\b(?:you know about me|what i (?:said|told|want|asked)|so far|our (?:chat|conversation))\b/i,
  /\bqu[eé] (?:te|le) (?:dije|pregunt[eé]|ped[ií])\b|\bcu[aá]l (?:es|era|fue) mi (?:presupuesto|nombre|primera pregunta)\b|\b(?:te|se) acuerdas?\b/i,
];

export function isRecallQuestion(message: string): boolean {
  const m = message.slice(0, 400);
  return RECALL.some((re) => re.test(m));
}
