# kpdd.com staff API — contract for the auth service

2026-10-08 · Todd Andrae

The auth service needs one read-only endpoint on kpdd.com that lists every `companyStaff` record, already deduped and mapped to MLS IDs, plus a webhook that says when a record changes. This is everything the auth service will call; nothing else on kpdd.com is needed.

kpdd.com built this on 2026-10-08 (build notes: https://claude.ai/artifact/67PTkhf12josQrZNCpQNrr). This file reflects the build as shipped; where it differs from the first draft, the build wins.

## Access

- HTTPS only, base URL in `KPDD_API_URL` (e.g. `https://kpdd.com/api/internal`).
- `Authorization: Bearer <KPDD_API_KEY>` on every request.
- The key grants read access to these routes and nothing else. It is stored only in the auth server's environment.
- Missing or wrong key → `401`. A valid key without the `staff:read` scope → `403`.
- 120 requests a minute per key; over that → `429` with `Retry-After`.

## Staff record

One record per person after dedupe. All fields are always present; use `null`, never omit.

```json
{
  "dash_staff_id": "02499996-4bd7-4ddb-97a4-7f4f2dac052f",
  "email": "jane.doe@kpdd.com",
  "name": "Jane Doe",
  "active": true,
  "licensed": true,
  "roles": ["SA", "OM"],
  "title": "Sales Associate",
  "office": "Columbus",
  "mls_ids": [
    { "mls": "CBOR", "mls_id": "52_2280" },
    { "mls": "GAMLS", "mls_id": "KW1239" }
  ],
  "merged_into": null,
  "updated_at": "2026-10-08T14:02:11Z"
}
```

| Field | Type | Rules |
| --- | --- | --- |
| `dash_staff_id` | string | Dash's `companyStaffGUID`. Stable forever and never reused. (The numeric `companyStaffID` is reused in Dash, so it is not used.) |
| `email` | string or null | The address the person signs in with: lowercase, one active record per email. Null if Dash has none (they can't sign in until it's set). If two active records share an email before an admin merges them, only the one with an agent profile carries it. |
| `name` | string | Display name. |
| `active` | boolean | False once they leave. Turning false disables sign-in and revokes every session. |
| `licensed` | boolean | True when the person has an open role in SA, SX, BR, RB, SM or PM. Sets the starting tier: licensed → agent, otherwise → staff. |
| `roles` | array of strings | Every open Dash role code, uppercase (e.g. `["SA", "OM"]`); empty if none. Opening or closing a role changes `updated_at`. Requested in Change Request 1. |
| `title`, `office` | string or null | Shown in the admin panel only. |
| `mls_ids` | array | Every MLS membership. `mls` is one of `CBOR`, `EABOR`, `LCAR`, `SWGAMLS`, `GAMLS` (from `MLSes.code`); `mls_id` passes through as stored. Can be empty, including for licensed agents whose profile lacks MLS IDs. |
| `merged_into` | string or null | Set when dedupe folds this record into another person: the surviving `dash_staff_id`. A merged record also has `active: false`. |
| `updated_at` | ISO 8601 UTC | Changes whenever any field above changes, including merges and deactivation. |

## Routes

### `GET /staff`

Lists records, oldest `updated_at` first, so a sync can resume where it stopped.

| Query | Default | Meaning |
| --- | --- | --- |
| `updated_since` | none (everything) | ISO 8601. Returns records with `updated_at` greater than or equal to this. |
| `cursor` | none | Opaque value from the previous page's `next_cursor`. |
| `limit` | 500 | Max 1000. |

```json
{
  "data": [ { "...": "staff record" } ],
  "next_cursor": "eyJ1IjoiMjAyNi0xMC0wOFQxNDowMjoxMVoiLCJpZCI6IjQ4MjEzIn0",
  "as_of": "2026-10-08T14:05:00Z"
}
```

- `next_cursor` is `null` on the last page.
- Inactive and merged records **must** appear in `updated_since` results. A record that disappears instead of turning inactive leaves its owner able to sign in.
- No hard deletes. A removed person is `active: false`.
- `as_of` is the server time minus 5 seconds, fixed for the whole paged listing; the auth service stores it and sends it as the next `updated_since`. A few records may come back twice; applying a record is idempotent.
- Paging is keyset, oldest first.

### `GET /staff/:dash_staff_id`

One record, same shape. `404` if the id never existed. A merged or inactive record still returns `200`.

## Webhook: kpdd.com → auth service

When a record changes, kpdd.com sends a thin event. The auth service then fetches the record with `GET /staff/:id`, so the event carries no personal data and replays are harmless.

```
POST https://auth.kpdd.com/directory/sync
Content-Type: application/json
X-KPDD-Timestamp: 1791468131
X-KPDD-Signature: <base64url HMAC-SHA256>

{ "event": "staff.updated", "dash_staff_id": "48213", "occurred_at": "2026-10-08T14:02:11Z" }
```

- `event`: `staff.created`, `staff.updated`, `staff.deactivated` or `staff.merged`. The auth service treats all four the same way (fetch and apply), so adding events later is safe.
- Signature: HMAC-SHA256 with the shared `DASH_WEBHOOK_SECRET` over these four lines joined by `\n`: the timestamp, `POST`, `/directory/sync`, and the base64url SHA-256 of the raw body. Timestamps more than 5 minutes off are rejected.
- The auth service answers `202` once the id is queued (durably, before replying), not after fetching it. A burst of events, like the ~1,125 `staff.created` events from the first refresh, must not turn into 1,125 fetches against the 120-a-minute limit.
- On any non-2xx or timeout, kpdd.com retries from 30 s doubling to 4 h, about 9 hours in all. The nightly sync catches anything that still slips through.
- Undoing a merge on kpdd.com makes the losing record active again with `merged_into: null`, sent as `staff.updated`.

## How the auth service uses it

1. **First import:** page through `GET /staff` with no `updated_since`, then create a user for every active record.
2. **Nightly:** `GET /staff?updated_since=<last as_of>`, applied in one transaction per page.
3. **Webhook:** queue the id and reply `202`. A worker drains the queue every few seconds: up to 20 queued ids are fetched one by one with `GET /staff/:id`; more than that runs an incremental `GET /staff?updated_since=` sync instead. On `429` it waits for `Retry-After`.
4. **Applying a record:** match on `dash_staff_id`, then update email, name, status and MLS IDs. `active: false` or `merged_into` set → disable the user and revoke every session in the same transaction. A merge also moves the losing record's linked sign-in identities to the surviving user. An undone merge re-enables the losing user; identities stay with the survivor, so that person signs in by magic link and re-links Google.

## Answered

- Licensed roles: SA, SX, BR, RB, SM and PM. Management roles are not licensed by themselves; a manager who sells also holds SA or BR. Dash never sets a tier above staff or agent; higher tiers come from the panel. Requested in Change Request 1: https://claude.ai/artifact/2GzYA4P1PwXRLSC4rTNaFm

- MLS codes: `CBOR`, `EABOR`, `LCAR`, `SWGAMLS`, `GAMLS`.
- Emails: 248 of 262 active people are @kpdd.com. 14 are personal or mistyped (e.g. `kpdd.ccom`) and sign in with that address until Dash is corrected; a mistyped one can't receive a magic link at all.
- The webhook is sent by kpdd.com after its own processing.

## Still open

- [ ] Should `mls_ids` be sent for everyone who has them, not only licensed people? Today 10 active non-licensed staff hold MLS IDs and arrive with an empty list.
- [ ] 92 of 245 licensed active agents have no MLS IDs on their profile. Doesn't block sign-in; a profile data cleanup.
