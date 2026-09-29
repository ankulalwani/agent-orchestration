# API

- Base path: `/api/v1`.
- The OpenAPI 3.1 document is generated from the same Zod contracts that validate requests: `GET /api/v1/openapi.json`.
- Contracts live in `packages/contracts`, shared by the API, web app, worker and CLI.

## Authentication

| Client | How |
|---|---|
| Web | `POST /auth/login` with header `x-client: web`. The access token (15 min) comes in the body; the refresh token is set as an httpOnly `SameSite=Strict` cookie. `POST /auth/refresh` with `x-client: web` rotates it. |
| CLI / mobile / integrations | The refresh token is returned in the body. Send `Authorization: Bearer <accessToken>`. |
| CLI and mobile app, any sign-in method | Device sign-in: `POST /auth/device/start` returns a code and a link; the person approves it in the web app (signed in there with a password, Google, GitHub, SSO, two-factor); the client polls `POST /auth/device/poll` every `intervalSec` until it gets its session. Codes expire after 10 minutes and work once. `agentctl login --server <url>` and **Sign in with your browser** in the app use it. |
| Scripts, CI, IDE extensions | A personal API token `aot_…` (**Settings → Your account → API tokens**, or `POST /me/tokens` with a signed-in session). Send `Authorization: Bearer aot_…`. A token works only in its organization, with the role it was created with, capped at the owner's current role. It can't use `/me/tokens`, two-factor setup or `/admin/*`. Only a hash is stored. `agentctl` reads `AO_SERVER`, `AO_TOKEN` and `AO_ORG`. |
| Worker | Device-code pairing (`POST /worker/pairing`, then `/worker/pairing/poll`) issues a worker credential `aow_…`. Send `Authorization: Bearer aow_…`. |

Refresh tokens rotate on every use. Presenting an already-used token revokes the whole session family.

## Organization-scoped resources

Everything owned by an organization lives under `/orgs/:orgId/…`. The server checks the caller's membership and role on every request. Non-members get `404` rather than `403`, so organization IDs cannot be probed.

Main resources: `projects`, `tasks` (plus `/events` and `/actions`), `workers`, `capabilities`, `capability-installations`, `providers`, `secrets`, `members`, `invitations`, `teams`, `audit`, `notifications`, `usage`, `overview`.

## Errors

```json
{ "error": { "code": "INVALID_TRANSITION", "message": "…", "correlationId": "cor_…", "retryable": false, "context": { } } }
```

Every response carries `x-correlation-id`. Unknown server errors never include internal details.

## Idempotency

- `POST /orgs/:orgId/tasks` accepts `idempotencyKey` in the body or an `Idempotency-Key` header. The same key returns the same task.
- Worker transitions carry a `transitionId`, and worker events carry an `eventId`. Replays are no-ops.

## Live updates

`GET /api/v1/live` (WebSocket). The first message must be `{"type":"auth","token":"<accessToken>","organizationId":"…"}`. The server then streams `task.updated`, `task.event`, `worker.updated` and `notification` messages for that organization.

## Worker protocol

HTTP for state changes (claim, transition, events) and a WebSocket (`/api/v1/worker/ws`) for offers, control messages and heartbeats. See `packages/contracts/src/worker-protocol.ts`.
