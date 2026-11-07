/** Staging-only release attestation guards; no network or secrets. */
const SHA_RE = /^[a-f0-9]{7,40}$/;

/** Neither an empty API commit nor a malformed expected SHA may pass. */
export function matchesExpectedCommit(actual, expected) {
  const observed = String(actual ?? '').trim().toLowerCase();
  const required = String(expected ?? '').trim().toLowerCase();
  return SHA_RE.test(observed) && SHA_RE.test(required)
    && (observed.startsWith(required) || required.startsWith(observed));
}

/** Fail closed: the generative probe must never target a production or unknown host. */
export function isApprovedStagingEndpoint(apiBase) {
  try {
    const url = new URL(apiBase);
    return url.protocol === 'https:'
      && url.hostname === 'staging-api.dialusnow.com'
      && !url.port && !url.username && !url.password
      && (url.pathname === '/' || url.pathname === '')
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Safety-only responses must never satisfy the generative release gate. */
export function isGenerativeConfigured(llm) {
  return llm === 'configured';
}
