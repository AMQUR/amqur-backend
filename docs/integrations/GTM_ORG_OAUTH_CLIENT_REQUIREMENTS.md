# Organization-controlled Google OAuth client — Tag Manager (Path B)

**Status:** REQUIREMENTS PREPARED — awaiting AMQUR / dealership org approval  
**Use when:** Direct [tagmanager.google.com](https://tagmanager.google.com) operator access is unsuitable, and the organization can own its own OAuth client.

## Permanently unsupported path

Do **not** use the stock Google Cloud SDK OAuth client (`764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur`) for Tag Manager scopes. Google blocks that client for sensitive Tag Manager access (“This app is blocked”). That path is **unsupported** for AMQUR GTM deployment.

Normal `gcloud` use for unrelated Cloud products is unaffected.

## Owner

The OAuth project must be controlled by **AMQUR** or the **authorized dealership organization** — not a personal throwaway project.

Project owner who must approve: _TBD (AMQUR GCP / Dial Auto Group digital)_

## Application identity

| Field | Requirement |
|---|---|
| App name | AMQUR GTM Canary Operator (or org-chosen equivalent) |
| User type | Internal (Google Workspace) preferred during pilot |
| Publishing status | Testing / Internal until verified |
| Test users | Approved AMQUR operators only |

## Redirect URIs

Document exact URIs once the approved operator tool is chosen. Typical options:

- Installed-app / loopback: `http://127.0.0.1:<port>/` (local operator CLI only)
- Or a single HTTPS callback on an AMQUR-controlled host

Do not register third-party or personal redirect hosts.

## Least-privilege scopes

Request **only** what unpublished internal-canary preparation needs:

| Scope | Why required |
|---|---|
| `https://www.googleapis.com/auth/tagmanager.readonly` | List accounts/containers; verify Jeep of Chicago container access |
| `https://www.googleapis.com/auth/tagmanager.edit.containers` | Create unpublished workspace, tags, triggers, Preview — **not** live publish |

Do **not** request for this task:

- `tagmanager.publish` (publication is forbidden here)
- Broad unrelated Google scopes beyond what the approved client platform requires

If the platform forces `cloud-platform`, document that separately and still never call publish APIs.

## Secret storage

- Client secret → Railway / macOS Keychain / org secret store only  
- Never commit client secret, refresh tokens, or ADC JSON to Git  
- Never embed secrets in widget JavaScript or GTM Custom HTML  
- Do not print refresh tokens in logs or chat  

## After approval

1. Run official OAuth for the **org** client only  
2. Verify access to the correct Jeep of Chicago container (observed public ID `GTM-MP5XGBXQ` is discovery only)  
3. Create unpublished workspace `AMQUR Internal Employee Canary`  
4. Preview only — **do not publish**  

## Stop at approval boundary

Until the org project owner creates/approves this client and adds test users, Path B remains **BLOCKED BY BUSINESS APPROVAL / ACCESS**.

Preferred interim path: Path A — authorized operator signs into [tagmanager.google.com](https://tagmanager.google.com) and applies the existing GTM package manually / via Preview.

Fallback: Path C — TeamVelocity / Apollo support request (see `amqur-widget/docs/deployment/jeep-of-chicago-teamvelocity-request.md`).
