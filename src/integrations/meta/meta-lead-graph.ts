/**
 * Parse Meta Graph API Leadgen `field_data` — only values Meta returned; never invent PII.
 */

export type MetaLeadgenVerifiedFields = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  zipCode?: string;
};

function firstFieldValue(
  fieldData: unknown,
  names: string[],
): string | undefined {
  if (!Array.isArray(fieldData)) return undefined;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const row of fieldData) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const name = (row as Record<string, unknown>).name;
    if (typeof name !== 'string' || !wanted.has(name.toLowerCase())) continue;
    const values = (row as Record<string, unknown>).values;
    if (!Array.isArray(values) || values.length === 0) continue;
    const v = values[0];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 500);
  }
  return undefined;
}

function splitFullName(full: string): { firstName?: string; lastName?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) {
    return { firstName: parts[0].slice(0, 120) };
  }
  return {
    firstName: parts[0].slice(0, 120),
    lastName: parts.slice(1).join(' ').slice(0, 120),
  };
}

/** Map Graph `field_data` array to lead columns; missing keys stay undefined. */
export function parseMetaGraphLeadFieldData(
  fieldData: unknown,
): MetaLeadgenVerifiedFields {
  const firstName =
    firstFieldValue(fieldData, ['first_name', 'first name']) ??
    undefined;
  const lastName =
    firstFieldValue(fieldData, ['last_name', 'last name']) ?? undefined;
  const fullName = firstFieldValue(fieldData, ['full_name', 'full name']);
  const fromFull = !firstName && !lastName && fullName ? splitFullName(fullName) : {};

  return {
    firstName: firstName ?? fromFull.firstName,
    lastName: lastName ?? fromFull.lastName,
    phone: firstFieldValue(fieldData, ['phone_number', 'phone', 'mobile_phone']),
    email: firstFieldValue(fieldData, ['email', 'work_email']),
    zipCode: firstFieldValue(fieldData, ['zip_code', 'zip', 'post_code']),
  };
}

export type MetaGraphLeadFetchResult =
  | { ok: true; fieldData: unknown; graphLeadId?: string }
  | {
      ok: false;
      reason:
        | 'not_configured'
        | 'http_error'
        | 'malformed'
        | 'lead_not_found';
      statusCode?: number;
      message?: string;
    };
