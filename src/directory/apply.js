import { randomUUID } from 'node:crypto';
import { now } from '../db.js';

// Applies one staff record from the kpdd.com API to the database. Must run inside
// db.tx(). Returns { action, warnings } where action is one of:
//   created, updated, unchanged, disabled, merged, reactivated, skipped
//
// Rules (docs/kpdd-api.md, "How the auth service uses it"):
// - Users are created only for active records; an inactive record with no user is skipped.
// - Inactive or merged → disable and revoke every session in the same transaction.
// - Tier follows `licensed` (agent/staff) only while tier_source is 'dash'.
// - An email held by another user: taken over if that user is disabled, otherwise
//   left off this user and reported, so one bad record never blocks the rest.
export function applyStaffRecord(db, record, { actor = 'directory-sync' } = {}) {
  const warnings = [];
  const id = record.dash_staff_id;
  const existing = db.get('SELECT * FROM users WHERE dash_staff_id = ?', [id]);
  const live = record.active && !record.merged_into;

  if (!live) {
    if (!existing) return { action: 'skipped', warnings };
    let action = 'unchanged';
    if (existing.status !== 'disabled') {
      disableUser(db, existing.id, record.merged_into ? 'merged' : 'inactive', actor);
      action = 'disabled';
    }
    if (record.merged_into) {
      const moved = moveIdentitiesToSurvivor(db, existing.id, record.merged_into);
      if (moved || action === 'disabled') action = 'merged';
    }
    const changed = updateProfile(db, existing, record, null, warnings);
    return { action: action === 'unchanged' && changed ? 'updated' : action, warnings };
  }

  const email = claimEmail(db, record.email, existing?.id, id, warnings);

  if (!existing) {
    const userId = randomUUID();
    db.run(
      `INSERT INTO users (id, email, name, tier, tier_source, status, dash_staff_id, dash_roles, licensed, title, office)
       VALUES (?, ?, ?, ?, 'dash', 'active', ?, ?, ?, ?, ?)`,
      [userId, email, record.name, startingTier(record), id, JSON.stringify(record.roles ?? []),
        record.licensed ? 1 : 0, record.title, record.office],
    );
    setMlsIds(db, userId, record.mls_ids);
    audit(db, actor, 'user.created', userId, { dash_staff_id: id });
    return { action: 'created', warnings };
  }

  let action = 'unchanged';
  if (existing.status === 'disabled') {
    db.run("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", [now(), existing.id]);
    audit(db, actor, 'user.reactivated', existing.id, { dash_staff_id: id });
    action = 'reactivated';
  }
  const changed = updateProfile(db, existing, record, email, warnings);
  return { action: action === 'unchanged' && changed ? 'updated' : action, warnings };
}

const startingTier = (record) => (record.licensed ? 'agent' : 'staff');

// Updates profile fields, tier and MLS IDs; returns true if anything changed.
// `email` null on an inactive record means "keep what's there".
function updateProfile(db, user, record, email, warnings) {
  const next = {
    email: record.active && !record.merged_into ? email : user.email,
    name: record.name,
    tier: user.tier_source === 'dash' && record.active ? startingTier(record) : user.tier,
    dash_roles: JSON.stringify(record.roles ?? []),
    licensed: record.licensed ? 1 : 0,
    title: record.title,
    office: record.office,
  };
  const fields = Object.keys(next).filter((k) => (user[k] ?? null) !== (next[k] ?? null));
  if (fields.length) {
    db.run(
      `UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...fields.map((f) => next[f]), now(), user.id],
    );
    if (fields.includes('tier')) {
      audit(db, 'directory-sync', 'user.tier_changed', user.id, { from: user.tier, to: next.tier });
    }
  }
  const mlsChanged = setMlsIds(db, user.id, record.mls_ids);
  return fields.length > 0 || mlsChanged;
}

function claimEmail(db, email, userId, dashStaffId, warnings) {
  if (!email) {
    warnings.push({ dash_staff_id: dashStaffId, code: 'no_email' });
    return null;
  }
  const holder = db.get('SELECT id, status FROM users WHERE email = ? AND id IS NOT ?', [email, userId ?? null]);
  if (!holder) return email;
  if (holder.status === 'disabled') {
    db.run('UPDATE users SET email = NULL, updated_at = ? WHERE id = ?', [now(), holder.id]);
    return email;
  }
  warnings.push({ dash_staff_id: dashStaffId, code: 'email_in_use' });
  return null;
}

function setMlsIds(db, userId, mlsIds = []) {
  const want = new Set(mlsIds.map((m) => `${m.mls}\u0000${m.mls_id}`));
  const have = new Set(db.all('SELECT mls, mls_id FROM user_mls_ids WHERE user_id = ?', [userId]).map((m) => `${m.mls}\u0000${m.mls_id}`));
  if (want.size === have.size && [...want].every((k) => have.has(k))) return false;
  db.run('DELETE FROM user_mls_ids WHERE user_id = ?', [userId]);
  for (const k of want) db.run('INSERT INTO user_mls_ids (user_id, mls, mls_id) VALUES (?, ?, ?)', [userId, ...k.split('\u0000')]);
  return true;
}

export function disableUser(db, userId, reason, actor) {
  const t = now();
  db.run("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?", [t, userId]);
  db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [t, userId]);
  db.run(
    `UPDATE refresh_tokens SET revoked_at = ?
     WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
    [t, userId],
  );
  audit(db, actor, 'user.disabled', userId, { reason });
}

function moveIdentitiesToSurvivor(db, loserId, survivorDashId) {
  const survivor = db.get('SELECT id FROM users WHERE dash_staff_id = ?', [survivorDashId]);
  if (!survivor) return false;
  const { changes } = db.run('UPDATE identities SET user_id = ? WHERE user_id = ?', [survivor.id, loserId]);
  if (changes) audit(db, 'directory-sync', 'identities.moved', survivor.id, { from_user: loserId, count: changes });
  return changes > 0;
}

function audit(db, actor, action, target, detail) {
  db.run('INSERT INTO audit_log (actor_app_id, action, target, detail) VALUES (?, ?, ?, ?)',
    [actor, action, target, JSON.stringify(detail)]);
}
