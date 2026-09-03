import { Router } from 'express';

import { all, one, run } from '../db.js';
import { field } from '../validate.js';
import { verifyPassword, hashPassword } from '../auth/passwords.js';
import {
  createSession, destroySession, destroySessionsFor, purgeExpiredSessions, sessionCookie,
} from '../auth/sessions.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export const auth = Router();

/**
 * A small in-memory brake on password guessing. Not a substitute for a real
 * rate limiter in front of the app, but enough that a single host cannot sit
 * there trying passwords.
 */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function tooManyAttempts(key) {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function noteFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  record.count += 1;
}

const publicUser = (user) => ({
  id: user.id, name: user.name, email: user.email, role: user.role,
});

auth.post('/login', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');

    // Keyed on the address being tried as well as the caller, so one noisy
    // client cannot lock out everyone.
    const key = `${req.ip}:${email}`;
    if (tooManyAttempts(key)) {
      res.status(429).json({
        error: 'Too many sign-in attempts. Wait a few minutes and try again.',
        code: 'RATE_LIMITED',
      });
      return;
    }

    const employee = email
      ? one('SELECT * FROM employees WHERE lower(email) = :email', { email })
      : null;

    const ok = employee && employee.active
      ? await verifyPassword(password, employee.password_hash)
      : await verifyPassword(password, ''); // keep the work constant-ish

    if (!employee || !employee.active || !ok) {
      noteFailure(key);
      // One message for every failure: never reveal whether an address exists.
      res.status(401).json({ error: 'Those details were not recognised.', code: 'BAD_CREDENTIALS' });
      return;
    }

    attempts.delete(key);
    purgeExpiredSessions();

    const { token } = createSession(employee.id, { userAgent: req.get('user-agent') ?? '' });
    run("UPDATE employees SET last_login_at = datetime('now') WHERE id = :id", { id: employee.id });

    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ user: publicUser(employee) });
  } catch (error) {
    next(error);
  }
});

auth.post('/logout', (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
  res.json({ ok: true });
});

/** Who am I — the frontend's session check on load. */
auth.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

/** Anyone may change their own password; doing so ends their other sessions. */
auth.post('/password', requireAuth, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const current = String(body.current_password ?? '');
    const next_ = String(body.new_password ?? '');

    const employee = one('SELECT * FROM employees WHERE id = :id', { id: req.user.id });
    if (!await verifyPassword(current, employee.password_hash)) {
      res.status(401).json({ error: 'Your current password was not correct.', code: 'BAD_CREDENTIALS' });
      return;
    }
    if (next_.length < 10) {
      res.status(400).json({ error: 'The new password must be at least 10 characters.' });
      return;
    }

    run('UPDATE employees SET password_hash = :hash WHERE id = :id', {
      id: req.user.id, hash: await hashPassword(next_),
    });
    destroySessionsFor(req.user.id);

    const { token } = createSession(req.user.id, { userAgent: req.get('user-agent') ?? '' });
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ ok: true, note: 'Your other sessions have been signed out.' });
  } catch (error) {
    next(error);
  }
});

/* ---------------- Administration ---------------- */

/** Listed without password hashes, and flagged if they cannot sign in yet. */
auth.get('/employees', requireRole('admin'), (_req, res) => {
  res.json(all(
    `SELECT id, name, email, role, active, created_at, last_login_at,
            (password_hash <> '') AS can_sign_in
     FROM employees ORDER BY name`,
  ));
});

auth.post('/employees/:id/password', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const employee = one('SELECT * FROM employees WHERE id = :id', { id });
    if (!employee) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }
    const password = field(req.body ?? {}, 'password', { type: 'string', max: 200 });
    run('UPDATE employees SET password_hash = :hash WHERE id = :id', {
      id, hash: await hashPassword(password),
    });
    // Setting someone's password ends whatever sessions they had.
    destroySessionsFor(id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
