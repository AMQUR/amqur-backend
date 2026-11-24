/**
 * Detection + redaction of sensitive customer data. Used for:
 *  - LLM egress minimization (never send contact PII or credentials to model providers)
 *  - customer-pasted credit-sensitive data (SSN, card, bank account) — never echoed/stored raw
 *  - log + analytics scrubbing
 */

export type SensitiveKind =
  | 'ssn'
  | 'card'
  | 'bank_account'
  | 'routing'
  | 'password'
  | 'email'
  | 'phone'
  | 'jwt'
  | 'api_key';

const SSN = /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const ROUTING_CTX =
  /\b(routing|aba)\s*(?:number|#|no\.?)?\s*[:#]?\s*(\d{9})\b/gi;
const ACCOUNT_CTX =
  /\b(account|acct)\s*(?:number|#|no\.?)?\s*[:#]?\s*(\d{6,17})\b/gi;
// Every quantifier below is bounded and no two adjacent parts can match the same text, so the
// patterns are linear in input length (the first login pattern was quadratic: see the spec).
const PASSWORD_CTX =
  /\b(pass(?:word|code|phrase)?|passw0rd|pwd|pw|pin|contrase(?:ñ|n)a|clave)(?:\s+(?:for|to|on|de|del|para)\s[^\n:="]{1,40}?)?(?:'s\s+|’s\s+|\s*(?:is|was|es|:|=)\s*:?\s*)("[^"\n]{1,200}"?|\S{1,80})/gi;
/** "my login is alex@example.com / Hunter2": the secret after a slash or pipe near a login word. */
const LOGIN_SLASH =
  /(\b(?:log[- ]?in|sign[- ]?in|username|credentials?)\b[^\n/|]{0,80}(?<![:/])[/|](?!\/)\s{0,3})(\S{4,80})/gi;
/** "sign in with samdemo:Tr0ub4dor": id:secret right after a login verb. */
const LOGIN_COLON =
  /(\b(?:log[- ]?in|sign[- ]?in)\s{1,3}(?:with|as|using)\s{1,3}[\w.@+-]{3,64}:)(\S{4,80})/gi;
/** "username: samdemo : Hunter2", "login = alex | Hunter2": a labelled id, then a separator. */
const LOGIN_LABELLED =
  /(\b(?:user(?:name)?|credentials?|log[- ]?in|sign[- ]?in)\s{0,3}[:=]\s{0,3}[\w.@+-]{3,64}\s{0,3}[:/|]\s{0,3})(?!\/\/)(\S{4,80})/gi;
/** "my login is alex:Hunter2", "user alex@example.com:Hunter2": a tight id:secret near a login word. */
const LOGIN_TIGHT =
  /(\b(?:user(?:name)?|credentials?|log[- ]?in|sign[- ]?in)\b[^\n:]{0,40}?\s[\w.@+-]{3,64}:)(?!\/\/)(\S{4,80})/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const API_KEY = /\b(sk|pk|rk|whsec|AKIA)[-_A-Za-z0-9]{16,}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Credit-sensitive values that must never be collected in normal chat. */
export function detectCreditSensitive(text: string): SensitiveKind[] {
  const kinds = new Set<SensitiveKind>();
  if (
    /\b(ssn|social security)\b/i.test(text) &&
    /\d{3}[- ]?\d{2}[- ]?\d{4}/.test(text)
  )
    kinds.add('ssn');
  for (const m of text.match(SSN) ?? []) {
    if (/^\d{3}-\d{2}-\d{4}$/.test(m)) kinds.add('ssn');
  }
  for (const m of text.match(CARD) ?? []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d))
      kinds.add('card');
  }
  if (new RegExp(ROUTING_CTX.source, 'i').test(text)) kinds.add('routing');
  if (new RegExp(ACCOUNT_CTX.source, 'i').test(text)) kinds.add('bank_account');
  if (new RegExp(PASSWORD_CTX.source, 'i').test(text)) kinds.add('password');
  return [...kinds];
}

/** Replace credit-sensitive values (keeps the rest of the message usable). */
export function redactCreditSensitive(text: string): string {
  let out = text
    .replace(LOGIN_SLASH, (_m, head: string) => `${head}[REDACTED]`)
    .replace(LOGIN_COLON, (_m, head: string) => `${head}[REDACTED]`)
    .replace(LOGIN_LABELLED, (_m, head: string) => `${head}[REDACTED]`)
    .replace(LOGIN_TIGHT, (_m, head: string) => `${head}[REDACTED]`);
  out = out.replace(PASSWORD_CTX, (_m, label: string) => `${label} [REDACTED]`);
  out = out.replace(ROUTING_CTX, (_m, label: string) => `${label} [REDACTED]`);
  out = out.replace(ACCOUNT_CTX, (_m, label: string) => `${label} [REDACTED]`);
  out = out.replace(CARD, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d) ? '[REDACTED-CARD]' : m;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  return out;
}

/** Strip everything a model provider does not need (contact PII + credentials + secrets). */
export function redactForLlm(text: string): string {
  let out = redactCreditSensitive(text);
  out = out.replace(JWT, '[REDACTED-TOKEN]').replace(API_KEY, '[REDACTED-KEY]');
  out = out.replace(EMAIL, '[email]');
  // VINs are 17 alphanumerics and must survive; phone regex requires separators/10 digits only
  out = out.replace(PHONE, (m) =>
    m.replace(/\D/g, '').length >= 10 ? '[phone]' : m,
  );
  return out;
}

/** For logs: also masks bearer/cookie headers embedded in strings. */
export function redactForLog(text: string): string {
  return redactForLlm(text)
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\n,;]+/gi,
      '$1: [REDACTED]',
    );
}
