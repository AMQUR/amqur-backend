/**
 * Customer-supplied identifier-like values (UTM parameters, lead source, preferred contact) that
 * end up inside a delimiter-structured line read by people and CRM parsers — the ADF `<comments>`
 * summary is `Label: value; Label: value` with `key=value` pairs. A value that could contain the
 * delimiters (`; `, `:`, `=`, `,`, spaces, parentheses) could forge a server-asserted segment such
 * as "Appointment: CONFIRMED by dealership" or "Consent: text=yes" (security review M3).
 *
 * Only RFC 3986 "unreserved" characters are allowed, 1-80 of them. Anything else is not
 * repaired or truncated — a partly-stripped value could still mislead — it is dropped.
 */
export const COMMENT_TOKEN_MAX = 80;
export const COMMENT_TOKEN_RE = /^[A-Za-z0-9._~-]{1,80}$/;

/** The value when it is a safe token, otherwise '' (dropped). */
export function commentToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return COMMENT_TOKEN_RE.test(s) ? s : '';
}

/**
 * DTO transform: a string that is not a safe token becomes `undefined` (the optional field is
 * simply absent) instead of failing the whole request — a visitor arriving with an odd
 * `utm_campaign` must still be able to chat. Non-strings pass through so type validation still
 * rejects them.
 */
export function commentTokenOrUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return commentToken(value) || undefined;
}
