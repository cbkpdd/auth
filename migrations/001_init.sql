-- KPDD auth service: initial schema (docs/spec.md, "Data model"). SQLite, STRICT tables.
-- Every secret is stored as a hash or encrypted, never in the clear.
-- Conventions: ids are TEXT UUIDs made by the app; times are ISO 8601 UTC TEXT
-- (sortable as text); arrays and objects are JSON TEXT; booleans are 0/1.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT COLLATE NOCASE UNIQUE,
  name          TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'agent' CHECK (tier IN ('agent', 'staff', 'director', 'leadership', 'owner')),
  tier_source   TEXT NOT NULL DEFAULT 'dash' CHECK (tier_source IN ('dash', 'panel')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  dash_staff_id TEXT UNIQUE,
  dash_roles    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dash_roles)),
  licensed      INTEGER NOT NULL DEFAULT 0 CHECK (licensed IN (0, 1)),
  title         TEXT,
  office        TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE user_mls_ids (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mls     TEXT NOT NULL,
  mls_id  TEXT NOT NULL,
  PRIMARY KEY (mls, mls_id)
) STRICT;
CREATE INDEX user_mls_ids_user ON user_mls_ids (user_id);

CREATE TABLE identities (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  provider_sub TEXT NOT NULL,
  email        TEXT COLLATE NOCASE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider, provider_sub)
) STRICT;
CREATE INDEX identities_user ON identities (user_id);

CREATE TABLE apps (
  id                    TEXT PRIMARY KEY CHECK (id GLOB '[a-z]*' AND id NOT GLOB '*[^a-z0-9-]*' AND length(id) BETWEEN 2 AND 40),
  name                  TEXT NOT NULL,
  owner_user_id         TEXT REFERENCES users (id),
  base_url              TEXT,
  redirect_uris         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redirect_uris)),
  pending_redirect_uris TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_redirect_uris)),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  manifest              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(manifest)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE registrants (
  id               TEXT PRIMARY KEY,
  app_id           TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  secret_hash      TEXT NOT NULL,
  prev_secret_hash TEXT,
  prev_expires_at  TEXT,
  allowed_cidrs    TEXT NOT NULL CHECK (json_valid(allowed_cidrs)),
  last_seen_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX registrants_app ON registrants (app_id);

CREATE TABLE scopes (
  app_id           TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  scope            TEXT NOT NULL CHECK (scope GLOB '[a-z]*:[a-z]*:[a-z]*' AND scope NOT GLOB '*[^a-z0-9_:-]*'
                          AND length(scope) - length(replace(scope, ':', '')) = 2),
  description      TEXT NOT NULL DEFAULT '',
  default_min_tier TEXT NOT NULL CHECK (default_min_tier IN ('agent', 'staff', 'director', 'leadership', 'owner')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  PRIMARY KEY (app_id, scope)
) STRICT;

CREATE TABLE grants (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app_id     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  effect     TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  granted_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, app_id, scope),
  FOREIGN KEY (app_id, scope) REFERENCES scopes (app_id, scope) ON DELETE CASCADE
) STRICT;

CREATE TABLE access_requests (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app_id     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by TEXT REFERENCES users (id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (app_id, scope) REFERENCES scopes (app_id, scope) ON DELETE CASCADE
) STRICT;
CREATE INDEX access_requests_pending ON access_requests (created_at) WHERE status = 'pending';

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
) STRICT;
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  app_id     TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  family_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  revoked_at TEXT
) STRICT;
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);

CREATE TABLE auth_codes (
  code_hash      TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
) STRICT;

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL COLLATE NOCASE,
  return_to  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  ip         TEXT
) STRICT;

CREATE TABLE signing_keys (
  kid             TEXT PRIMARY KEY,
  public_jwk      TEXT NOT NULL CHECK (json_valid(public_jwk)),
  private_key_enc TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retiring', 'retired')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  rotated_at      TEXT  -- when it stopped signing; JWKS keeps it until tokens expire
) STRICT;
CREATE UNIQUE INDEX signing_keys_one_active ON signing_keys (status) WHERE status = 'active';

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_user_id TEXT,
  actor_app_id  TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  ip            TEXT,
  detail        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
) STRICT;
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- Directory sync (docs/kpdd-api.md): webhook ids wait here until the worker fetches them.
CREATE TABLE directory_queue (
  dash_staff_id TEXT PRIMARY KEY,
  queued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
) STRICT;

-- Small key/value state, e.g. the directory sync's last as_of.
CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
