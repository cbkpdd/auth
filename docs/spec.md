# KPDD Auth Service — Spec v0.3

2026-10-08 · Todd Andrae

One auth service issues short-lived signed tokens that every KPDD app verifies on its own. Account and Listing Marketing are its first two consumers.

v0.3 moves storage to SQLite and takes Dash data from the kpdd.com staff API. v0.2 carried v0.1 forward with these fixes: milestones reordered so each consumer's dependencies ship first, magic links confirmed by POST, a refresh reuse grace window, a credential for service tokens, a home for the Dash webhook secret, and Google-to-user linking when emails differ.

## Overview

**Goals**

- One login across every KPDD app, with no passwords stored anywhere.
- Apps self-register on boot and declare their own scopes.
- Owners grant access by tier, approve exceptions in one panel, and cut off a departing user everywhere at once.
- Apps check tokens locally, so the auth service is never on the hot path of a normal request.

**Non-goals for v1**

- Acting as an identity provider for third parties outside KPDD.
- Consumer (buyer/seller) accounts.
- Fine-grained row-level permissions; each app enforces its own data rules.

**Stack constraints**

- Node LTS, Express, vanilla JS, Web Components, no build step on the front end.
- SQLite through Node's built-in `node:sqlite`, raw SQL, no ORM. The database is one file, `data/auth.db` (untracked). Moving to Postgres later means porting the migration and `src/db.js`.
- No auth framework (no Passport, Auth0 or Keycloak). Token signing uses `node:crypto` with Ed25519; OIDC sign-in is hand-rolled with `fetch`.
- Dependencies limited to `express` and `cookie-parser`. Email goes out through a provider's HTTP API with `fetch`.
- Tests use `node:test`; no test framework dependency.

## Architecture

The browser talks only to its own app, and to the auth service at sign-in. Each app checks tokens against cached public keys, so the auth service handles sign-in, refresh and admin work, not every request.

```
Browser ──► App (BFF, @kpdd/auth-client) ──► local JWT check (cached JWKS)
   │              │
   │              └──► auth.kpdd.com: /token, /me, /introspect, /apps/register
   └──► auth.kpdd.com: /authorize, sign-in pages (sign-in only)

Dash ──► auth.kpdd.com: /directory/sync (HMAC webhook) + nightly pull
Auth service ──► SQLite (data/auth.db)
```

## Identity

Users sign in with Google OAuth or an emailed magic link, and only people active in Dash can sign in.

**Sign-in methods**

1. **Google OAuth** (OIDC authorization code + PKCE). The primary path. The Google account's verified email must match a Dash user, or be linked to one (see below).
2. **Magic link** by email as the fallback. Single use, 15-minute expiry, token stored only as a SHA-256 hash.

No password table exists. Identities link to one user, so one person can use either method.

**Magic link confirmation.** `GET /login/email/verify` only renders a "Continue signing in" page; the token is consumed by `POST /login/email/verify`. Mail scanners and link previews follow GETs, so a GET must never use up the token.

**Linking Google when emails differ.** If a Google email matches no user, the sign-in page says so and offers a magic link. After a magic-link sign-in, the user can link their Google account from the sign-in page; the link is stored in `identities` and audited.

**Directory sync**

- Dash is the source of truth. Every `companyStaff` record in the Dash database gets an account, agents and non-licensed staff alike.
- KPDD dedupes Dash records and maps each person to their MLS IDs. One person can hold IDs in more than one MLS; the mapping lives in `user_mls_ids`.
- Sync runs nightly plus on a webhook from Dash when someone joins, changes role or leaves. The webhook is HMAC-SHA256 signed with `DASH_WEBHOOK_SECRET` from the environment, with a ±5 min timestamp.
- `dash_staff_id` is the join key for sync; verified email (or a linked identity) is the join key for sign-in.
- A user marked inactive in Dash is disabled, and all their sessions and refresh tokens are revoked in the same transaction.
- Tier: sync sets a new user's starting tier (`agent` if licensed, else `staff`). Director and above are set in the panel, and sync never changes a tier set in the panel (`tier_source = 'panel'`).

## App registration

Each app registers itself on Express boot. A new app or a new scope only goes live after an owner approves it.

1. **Mint a registrant.** An owner runs `npm run auth:registrant -- --app marketing --cidr 10.0.0.0/24` on the auth server. It prints the registrant secret once and stores only its scrypt hash and the allowed IP ranges. Add `--approve` to create the app as active, for bootstrapping before the panel exists.
2. **Boot call.** On startup the app sends `POST /apps/register` with its manifest: app id, name, base URL, redirect URIs, and its scope list with a default minimum tier per scope. The body is signed with HMAC-SHA256 using the registrant secret, plus a timestamp to block replays (±5 min).
3. **Checks.** The auth service verifies the source IP against the registrant's ranges, then the signature and the timestamp.
4. **Approval.** A first-time app is stored as pending and shows in the admin panel. Later boots update the manifest silently unless they add scopes or redirect URIs; those additions stay pending until approved. Scopes in the manifest of an app approved with `--approve` start active.
5. **Response.** The service returns the issuer, token endpoint, JWKS URL and the app's approval status. A pending app can boot but cannot complete a sign-in.

Registrant secrets rotate from the panel with a 24-hour overlap, so a deploy can pick up the new secret without downtime. The same secret authenticates the app's `/token` calls (below).

## Tokens

Access tokens are 10-minute Ed25519 JWTs checked locally; refresh tokens are opaque, rotate on every use, and are the revocation lever.

| Token | Format | Lifetime | Stored where | Notes |
| --- | --- | --- | --- | --- |
| Access | JWT, EdDSA (Ed25519) | 10 min | App server, httpOnly cookie | Audience = one app; verified against cached JWKS |
| Refresh | Opaque, 256-bit random | 30 days sliding | App server, httpOnly cookie; hash in the database | Rotates on every use; see reuse rules below |
| Auth session | Opaque | 30 days | Auth domain cookie | Gives single sign-on across apps |
| Auth code | Opaque, single use | 60 s | Hash in the database | Bound to app, redirect URI and PKCE challenge |
| Service | JWT, client credentials | 10 min | Calling app memory | App-to-app calls, e.g. Marketing reading the MLS platform |

**Access token claims:** `iss`, `aud` (app id), `sub` (user id), `sid` (session id), `tier`, `scp` (scopes for that app only), `iat`, `exp`, `jti`.

**App authentication at `/token`.** Every `/token` call is HMAC-signed with the app's registrant secret, the same scheme as `/apps/register`. That covers all three grant types, including `client_credentials`; no separate client secret exists.

**Refresh reuse.** A refresh token used a second time within 30 s of its first use gets a new token pair in the same family, so parallel requests from one app don't log the user out. A reuse after 30 s revokes the whole family. The SDK also runs one refresh at a time per session within a process.

**Keys:** signing keys live in `signing_keys`, private halves encrypted with `AUTH_MASTER_KEY` from the environment. Keys rotate every 90 days; the old key stays in JWKS until its last token expires.

**Revocation:** revoking a session or user kills every refresh family at once, so access ends within 10 minutes. High-value actions (publish a post, send a blast, change grants) also call `/introspect`, which checks the session live and makes revocation instant for those actions.

## Permissions

A user's scopes for an app = every scope their tier meets by default, plus explicit grants, minus explicit denies.

**Tiers** (each includes the ones before it): agent → staff → director → leadership → owner.

**Scope format:** `app:resource:action`. Each app's manifest sets a default minimum tier per scope.

**Access requests:** when a user lacks a scope, the app shows a request button. The request lands in the owner's queue with the user, app, scope and reason. Approve creates a grant; deny is logged and the user is told.

First scopes, as the two launch apps would declare them:

| Scope | Default min tier | What it allows |
| --- | --- | --- |
| `account:entry:write` | director | Log and classify your own time |
| `account:entry:read_own` | director | See your own reds, purples and history |
| `account:team:read` | leadership | See directors' persistent reds and purples |
| `marketing:post:draft` | agent | Generate and edit posts for your own listings |
| `marketing:post:publish` | agent | Publish to your connected business pages |
| `marketing:blast:send` | agent | Send a board email blast for your own listing |
| `marketing:list:manage` | staff | Import lists, manage unsubscribes |
| `marketing:template:admin` | staff | Edit branded templates |
| `marketing:compliance:review` | staff | Approve or reject flagged posts and blasts |

"Your own listing" is enforced inside Marketing, not by auth.

## Data model

Sixteen SQLite tables (STRICT); every secret is stored as a hash, never in the clear. Ids are app-made UUIDs, times are ISO 8601 UTC text, arrays and objects are JSON text.

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, email (case-insensitive, unique), name, tier, tier_source, status, dash_staff_id unique, dash_roles, licensed, title, office | Status follows Dash sync; tier_source: dash or panel; dash_staff_id is Dash's companyStaffGUID |
| `user_mls_ids` | user_id, mls, mls_id | Unique on (mls, mls_id); one person, many MLSs |
| `identities` | user_id, provider, provider_sub, email | Unique on (provider, provider_sub) |
| `apps` | id slug, name, owner_user_id, base_url, redirect_uris, pending_redirect_uris, status, manifest | Status: pending, active, disabled; new redirect URIs wait in pending_redirect_uris |
| `registrants` | id, app_id, secret_hash, prev_secret_hash, prev_expires_at, allowed_cidrs, last_seen_at | prev_secret_hash supports the 24 h rotation overlap |
| `scopes` | app_id, scope, description, default_min_tier, status | PK (app_id, scope); new scopes start pending |
| `grants` | user_id, app_id, scope, effect, granted_by, created_at | effect: allow or deny |
| `access_requests` | id, user_id, app_id, scope, reason, status, decided_by, decided_at | Feeds the panel queue |
| `sessions` | id, token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at | The auth-domain SSO session; cookie holds the token, table holds its hash |
| `refresh_tokens` | id, session_id, app_id, family_id, token_hash, expires_at, used_at, revoked_at | Reuse after the 30 s grace revokes its family |
| `auth_codes` | code_hash, app_id, user_id, session_id, redirect_uri, pkce_challenge, expires_at, used_at | 60 s, single use |
| `magic_links` | token_hash, email, return_to, created_at, expires_at, used_at, ip | 15 min, single use; return_to resumes the /authorize request |
| `signing_keys` | kid, public_jwk, private_key_enc, status, created_at, rotated_at | Status: active, retiring, retired; one active at a time |
| `audit_log` | id, at, actor_user_id, actor_app_id, action, target, ip, detail | Append only |
| `directory_queue` | dash_staff_id, queued_at, attempts, last_error | Webhook ids waiting for the sync worker |
| `sync_state` | key, value, updated_at | e.g. the directory sync's last `as_of` |

Migrations are plain numbered `.sql` files, applied on server start and by `npm run migrate`, recorded in a `schema_migrations` table.

## API endpoints

Twenty-two routes on one Express app, grouped by who calls them.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| GET | `/.well-known/kpdd-auth` | Any app | Discovery: issuer, endpoints, JWKS URL |
| GET | `/.well-known/jwks.json` | Any app | Public signing keys |
| POST | `/apps/register` | App on boot (HMAC) | Register or update manifest |
| GET | `/authorize` | Browser | Start sign-in: app_id, redirect_uri, state, code_challenge |
| GET | `/login/:provider` | Browser | Redirect to Google |
| GET | `/callback/:provider` | Browser | OIDC return; creates auth session |
| POST | `/login/email` | Browser | Send magic link |
| GET | `/login/email/verify` | Browser | Confirm page only; consumes nothing |
| POST | `/login/email/verify` | Browser | Consume magic link; creates auth session |
| POST | `/link/:provider` | Browser (signed in) | Link a Google account to the signed-in user |
| POST | `/token` | App server (HMAC) | Grant types: authorization_code, refresh_token, client_credentials |
| POST | `/revoke` | App server (HMAC) | Revoke a refresh token family |
| POST | `/introspect` | App server (HMAC) | Live check of a token for high-value actions |
| POST | `/logout` | Browser | End auth session and all its refresh families |
| GET | `/me` | App server | Profile, tier, scopes for the calling app |
| POST | `/access-requests` | App server for user | File a scope request |
| GET | `/admin/access-requests` | Owner panel | Pending queue |
| POST | `/admin/access-requests/:id/decision` | Owner panel | Approve or deny |
| GET/PATCH | `/admin/users`, `/admin/users/:id` | Owner panel | Tier, status, sessions |
| GET/PATCH | `/admin/apps`, `/admin/apps/:id` | Owner panel | Approve apps and scopes, rotate secrets |
| GET | `/admin/audit` | Owner panel | Filterable audit log |
| POST | `/directory/sync` | Dash (HMAC) | Push joins, tier changes, departures |

## Client SDK

A small local package, `@kpdd/auth-client`, gives each app three lines of server setup and two custom elements; the browser never holds a token.

**Server (Express)**

```js
import { kpddAuth, requireScope } from '@kpdd/auth-client';

app.use(kpddAuth({ issuer: 'https://auth.kpdd.com', appId: 'marketing', registrantSecret: process.env.KPDD_REGISTRANT_SECRET, manifest }));
app.post('/api/blasts', requireScope('marketing:blast:send', { introspect: true }), sendBlast);
```

- `req.user = { id, email, name, tier, scopes }`.
- Unauthenticated page requests redirect to `/authorize`; API requests get 401 with a `login_url`.
- Missing scope returns 403 with `{ scope, request_url }` so the front end can offer a request button.
- Refresh runs single-flight per session within the process.

**Browser (Web Components, no build step)**

- `<kpdd-user>` shows the signed-in user and a sign-out menu, reading `/auth/me` on the app's own origin.
- `<kpdd-gate scope="marketing:blast:send">` renders its slot when the scope is present, otherwise a "Request access" button that posts the request.

The app is a backend-for-frontend: tokens stay in httpOnly cookies on the app server, and front-end code only ever calls its own app's API.

## Admin panel

The auth service serves its own owner panel, built on the same vanilla JS and Web Components. It opens on the access-request queue.

1. **Requests** (default view): pending access requests, plus pending apps and scopes from registrations. One-click approve or deny with an optional note.
2. **Users:** search, tier, status, active sessions with a revoke button, and effective scopes per app.
3. **Apps:** manifest, scopes with default tiers, registrants with IP ranges and last-seen times, secret rotation.
4. **Audit:** filter by user, app, action and date.

Only the owner tier can open the panel in v1. Delegating approvals per app (an app owner approving their own app's requests) is a later step.

## Security and ops

The service holds no passwords and only hashes of its own secrets; the private signing key is the single high-value item.

- **Cookies:** httpOnly, Secure, SameSite=Lax on every cookie. All cookies are host-only (no `Domain=.kpdd.com`), so one subdomain can never read another app's tokens.
- **CSRF:** SameSite plus an Origin header check on every state-changing route; OIDC and `/authorize` use state and PKCE.
- **Redirects:** exact match against the app's approved redirect URIs, never prefix match.
- **Rate limits:** magic-link sends per email and per IP, `/token` per app, failed registrations per registrant. In-memory for v1 (single instance).
- **Secrets at rest:** registrant secrets as scrypt hashes; refresh tokens, codes and magic links as SHA-256 hashes; signing keys encrypted with `AUTH_MASTER_KEY`, held outside the database.
- **Environment:** `DATABASE_PATH`, `KPDD_API_URL`, `KPDD_API_KEY`, `AUTH_ISSUER`, `AUTH_MASTER_KEY`, `DASH_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EMAIL_API_KEY`.
- **Audit:** sign-ins, failed sign-ins, identity links, grants, denials, approvals, revocations, registrations and key rotations all write to `audit_log`.
- **Offboarding:** a departure from the directory disables the user and revokes every session in one transaction, with an emergency "revoke now" button in the panel.
- **Backups:** nightly `VACUUM INTO` copy of `data/auth.db` to off-server storage; losing the database logs everyone out but exposes nothing.

## Milestones

Account goes live after milestone 1; Listing Marketing goes live after milestone 3.

1. **Core tokens and users.** Migrations, signing keys, JWKS, discovery, one-shot Dash import (`npm run auth:import-dash`), magic-link sign-in, `/authorize`, `/token`, refresh rotation with grace, `/me`, registrant CLI with `--approve`, `/apps/register`, default-tier scopes, `@kpdd/auth-client` middleware and `requireScope`. Account integrates here.
2. **SSO and directory.** Google OAuth, identity linking, Dash nightly sync and webhook, MLS ID mapping, offboarding.
3. **Permissions and panel.** Pending apps and scopes, grants, access requests, `<kpdd-gate>`, owner panel, `/introspect`, service tokens. Listing Marketing integrates here; its publish and blast routes use introspect.
4. **Hardening.** Rate limits, key rotation job, registrant secret rotation, audit views, backups.

**Milestone 1 checklist**

- [x] Repo scaffold: `package.json`, `src/`, `migrations/`, `scripts/`, `packages/auth-client/`, `test/`
- [x] Migration runner and the SQLite schema, tested
- [x] Ed25519 key generation, encrypted storage, JWKS
- [x] JWT sign and verify (`node:crypto`, EdDSA)
- [x] HMAC request signing (shared by registration, `/token` and the Dash webhook)
- [ ] Dash import from the kpdd.com staff API (`docs/kpdd-api.md`)
- [ ] Magic link send, confirm page, consume
- [ ] `/authorize` + auth session cookie + auth codes with PKCE
- [ ] `/token`: authorization_code and refresh_token with rotation and grace
- [ ] Registrant CLI and `/apps/register` with HMAC and CIDR checks
- [ ] `@kpdd/auth-client`: `kpddAuth`, `requireScope`, `/auth/me`, `<kpdd-user>`
- [ ] Account wired up end to end

## Repo layout

```
docs/spec.md
migrations/001_init.sql …
data/auth.db             SQLite database (untracked)
scripts/migrate.js, keys.js, registrant.js, import-dash.js
src/server.js            boot: config, migrations, key check, listen
src/app.js               Express app and route mounting
src/db.js                node:sqlite connection and helpers
src/migrate.js           migration runner
src/crypto/              jwt.js, keys.js, hmac.js, hash.js
src/routes/              wellknown, apps, authorize, login, token, me, admin, directory
src/views/               sign-in and confirm pages (static HTML + Web Components)
packages/auth-client/    SDK: server middleware + browser components
test/                    node:test suites
```

## Open questions

- [ ] Email provider for magic links (Postmark, SES, SendGrid, or Google Workspace SMTP relay)?
- [ ] Target dates for each milestone?
- [ ] Existing logins (Connect, Agent OS dashboard): who migrates them, and by when?

**Decided:** SQLite in `data/auth.db` · Dash data through the kpdd.com staff API (`docs/kpdd-api.md`), licensed = open role in SA, SX, BR, RB, SM or PM · Google OAuth for SSO · Dash as source of truth, KPDD dedupes and maps MLS IDs · auth domain `auth.kpdd.com` · apps move off ngrok onto `*.kpdd.com` subdomains (`connect.kpdd.com`, etc.) · every `companyStaff` record gets an account, mapped like agents.
