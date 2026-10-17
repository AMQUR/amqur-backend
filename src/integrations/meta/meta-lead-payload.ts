/**
 * Strict extraction of Meta leadgen webhook event ids. Does not create Lead rows —
 * intake only stores WebhookInbox records for downstream processing (not enabled here).
 */
export function extractMetaLeadgenExternalEventId(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  if (root.object !== 'page') return null;
  if (!Array.isArray(root.entry) || root.entry.length === 0) return null;

  for (const entry of root.entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const entryObj = entry as Record<string, unknown>;
    if (!Array.isArray(entryObj.changes)) continue;
    for (const change of entryObj.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        continue;
      }
      const changeObj = change as Record<string, unknown>;
      if (changeObj.field !== 'leadgen') continue;
      const value = changeObj.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const leadgenId = (value as Record<string, unknown>).leadgen_id;
      if (typeof leadgenId === 'string' && leadgenId.length > 0) {
        return leadgenId.slice(0, 200);
      }
      if (typeof leadgenId === 'number' && Number.isFinite(leadgenId)) {
        return String(leadgenId).slice(0, 200);
      }
    }
  }
  return null;
}

export function payloadAsJsonRecord(
  body: unknown,
): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}
