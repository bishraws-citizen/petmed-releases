import { randomBytes } from 'node:crypto';

import { all, one, run } from '../db.js';

/**
 * Server-side sessions.
 *
 * Kept in the database rather than encoded into a signed token so that signing
 * out — or disabling an account — ends access immediately, instead of leaving a
 * valid token in the wild until it expires.
 */

export const COOKIE_NAME = 'voyager_session';

const LIFETIME_HOURS = Number(process.env.SESSION_HOURS) || 12;

const expiryFrom = (hours) =>
  new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

export function createSession(employeeId, { userAgent = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  run(
    `INSERT INTO sessions (token, employee_id, expires_at, user_agent)
     VALUES (:token, :employee_id, :expires_at, :user_agent)`,
    {
      token,
      employee_id: employeeId,
      expires_at: expiryFrom(LIFETIME_HOURS),
      user_agent: String(userAgent).slice(0, 200),
    },
  );
  return { token, expiresAt: expiryFrom(LIFETIME_HOURS) };
}

/**
 * Resolves a session token to its employee, or null.
 *
 * A disabled account resolves to nothing even while its session row survives,
 * so revoking someone takes effect on their very next request.
 */
export function resolveSession(token) {
  if (!token) return null;

  const row = one(
    `SELECT s.token, s.expires_at, e.id, e.name, e.email, e.role, e.active
     FROM sessions s
     JOIN employees e ON e.id = s.employee_id
     WHERE s.token = :token`,
    { token },
  );
  if (!row) return null;

  if (new Date(`${row.expires_at.replace(' ', 'T')}Z`) <= new Date()) {
    destroySession(token);
    return null;
  }
  if (!row.active) return null;

  // Rolling expiry: an employee working through the day is not signed out
  // mid-task, but an abandoned session still lapses.
  run(
    `UPDATE sessions SET last_seen_at = datetime('now'), expires_at = :expires_at
     WHERE token = :token`,
    { token, expires_at: expiryFrom(LIFETIME_HOURS) },
  );

  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

export const destroySession = (token) =>
  run('DELETE FROM sessions WHERE token = :token', { token });

export const destroySessionsFor = (employeeId) =>
  run('DELETE FROM sessions WHERE employee_id = :id', { id: employeeId });

/** Housekeeping so expired rows do not accumulate forever. */
export const purgeExpiredSessions = () =>
  run("DELETE FROM sessions WHERE expires_at <= datetime('now')");

export const listSessionsFor = (employeeId) =>
  all('SELECT token, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE employee_id = :id',
    { id: employeeId });

/** Minimal cookie header parsing — not worth a dependency. */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function sessionCookie(token, { clear = false } = {}) {
  const attributes = [
    `${COOKIE_NAME}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    // Blocks the cookie on cross-site POSTs, which is the practical CSRF
    // defence for a JSON API like this one.
    'SameSite=Lax',
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  attributes.push(clear ? 'Max-Age=0' : `Max-Age=${LIFETIME_HOURS * 3600}`);
  return attributes.join('; ');
}
