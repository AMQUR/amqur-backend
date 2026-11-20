# Dial Difference SFTP host-key provenance

**Fingerprint in use:** `SHA256:RB74t0jOln5yBXsa35xeTZgIfpynQSiTKnn0xzHK11Y` (ED25519, port 2022)

## What has been proven

| Check | Result |
|---|---|
| Independent `ssh-keyscan -p 2022 -t ed25519 sftp.dialdifference.com` (agent) | Same SHA256 |
| Runbook / Railway `AMQUR_VAUTO_SFTP_HOST_FINGERPRINT` | Same prefix/value |
| Live worker hostVerifier | **MATCH** |

## What this does **not** prove

Matching a fresh `ssh-keyscan` to an earlier scan (or to a configured env var) is **consistency**, not independent authority.

An attacker who already controls DNS/routing to a host presenting a sticky forged key could produce a stable fingerprint across scans.

## Authoritative trust (required for production)

Authoritative provenance requires Dial Difference / DigitalOcean feed operators to attest the ED25519 host key from **SFTPGo admin / install records** (or a signed change ticket), independent of client-side keyscan.

Until that attestation is filed:

- **Staging read-only diagnostics** may continue with the consistent pin (fail-closed on mismatch).
- **Production ingest enablement** should remain blocked on owner attestation.

**Status:** `CONSISTENCY_VERIFIED` · `AUTHORITATIVE_PROVENANCE: OWNER_ATTESTATION_REQUIRED`
