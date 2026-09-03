import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';

import { db, one, run } from '../src/db.js';
import { ensureTestClient } from './fixtures.mjs';
import { hashPassword, verifyPassword, generatePassword } from '../src/auth/passwords.js';
import {
  COOKIE_NAME, createSession, destroySession, readCookie, resolveSession, sessionCookie,
} from '../src/auth/sessions.js';
import { attachUser, requireAuth, requireRole } from '../src/auth/middleware.js';

let adminId;
let consultantId;
let server;
let base;

/**
 * A miniature app carrying the same three surfaces as the real one, so the
 * guard wiring is exercised rather than just the middleware in isolation.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.get('/open', (_req, res) => res.json({ ok: true }));
  app.get('/internal', requireAuth, (req, res) => res.json({ who: req.user.name }));
  app.get('/admin', requireRole('admin'), (_req, res) => res.json({ ok: true }));
  return app;
}

const get = (path, token) => fetch(`${base}${path}`, {
  headers: token ? { cookie: `${COOKIE_NAME}=${token}` } : {},
});

before(async () => {
  const clientId = ensureTestClient();
  assert.ok(clientId);

  run("DELETE FROM employees WHERE email LIKE 'authtest%'");
  const admin = run(
    `INSERT INTO employees (name, email, role, password_hash)
     VALUES ('Auth Admin', 'authtest-admin@test.invalid', 'admin', :hash)`,
    { hash: await hashPassword('admin-password-1') },
  );
  adminId = Number(admin.lastInsertRowid);

  const consultant = run(
    `INSERT INTO employees (name, email, role, password_hash)
     VALUES ('Auth Consultant', 'authtest-con@test.invalid', 'consultant', :hash)`,
    { hash: await hashPassword('consultant-password-1') },
  );
  consultantId = Number(consultant.lastInsertRowid);

  server = await new Promise((resolve) => {
    const s = buildApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => {
  db.exec("DELETE FROM employees WHERE email LIKE 'authtest%'");
  server.close(resolve);
}));

test('passwords are salted, so identical passwords hash differently', async () => {
  const a = await hashPassword('the-same-password');
  const b = await hashPassword('the-same-password');
  assert.notEqual(a, b, 'a shared salt would let one crack reveal every match');
  assert.ok(await verifyPassword('the-same-password', a));
  assert.ok(await verifyPassword('the-same-password', b));
});

test('password verification fails closed on anything malformed', async () => {
  for (const stored of ['', 'not-a-hash', 'scrypt$1$2$3', 'scrypt$16384$8$1$$', null, undefined]) {
    assert.equal(await verifyPassword('anything', stored), false, `stored: ${stored}`);
  }
  // An account created without a password cannot be signed into.
  const fresh = one('SELECT password_hash FROM employees WHERE id = :id', { id: adminId });
  assert.equal(await verifyPassword('', fresh.password_hash), false);
});

test('short passwords are refused', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 10/);
  assert.ok(generatePassword().length >= 12);
});

test('anonymous callers cannot reach internal routes', async () => {
  assert.equal((await get('/open')).status, 200, 'public routes stay open');
  assert.equal((await get('/internal')).status, 401);
  assert.equal((await get('/admin')).status, 401);

  const body = await (await get('/internal')).json();
  assert.equal(body.code, 'UNAUTHENTICATED');
});

test('a session grants access, and signing out ends it immediately', async () => {
  const { token } = createSession(adminId);
  assert.equal((await get('/internal', token)).status, 200);

  destroySession(token);
  assert.equal((await get('/internal', token)).status, 401, 'the session is gone at once');
});

test('a garbage or expired token is refused', async () => {
  assert.equal((await get('/internal', 'not-a-real-token')).status, 401);

  const { token } = createSession(adminId);
  run("UPDATE sessions SET expires_at = datetime('now','-1 minute') WHERE token = :token", { token });

  assert.equal(resolveSession(token), null, 'expired sessions do not resolve');
  assert.equal((await get('/internal', token)).status, 401);
  assert.equal(
    one('SELECT COUNT(*) AS n FROM sessions WHERE token = :token', { token }).n,
    0,
    'and the expired row is cleaned up',
  );
});

test('deactivating an employee locks them out of their live session', async () => {
  const { token } = createSession(consultantId);
  assert.equal((await get('/internal', token)).status, 200);

  run('UPDATE employees SET active = 0 WHERE id = :id', { id: consultantId });
  assert.equal((await get('/internal', token)).status, 401, 'access ends on the next request');

  run('UPDATE employees SET active = 1 WHERE id = :id', { id: consultantId });
});

test('roles gate what a session can reach', async () => {
  const admin = createSession(adminId).token;
  const consultant = createSession(consultantId).token;

  assert.equal((await get('/admin', admin)).status, 200);
  assert.equal((await get('/internal', consultant)).status, 200, 'day-to-day work is open');

  const refused = await get('/admin', consultant);
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.code, 'FORBIDDEN');
  assert.match(body.error, /consultant/, 'the message says what they are signed in as');
});

test('the session cookie is httpOnly and same-site', () => {
  const header = sessionCookie('abc123');
  assert.match(header, /HttpOnly/, 'script must not be able to read the session');
  assert.match(header, /SameSite=Lax/, 'blocks the cookie on cross-site posts');
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=\d+/);

  const cleared = sessionCookie('', { clear: true });
  assert.match(cleared, /Max-Age=0/);
});

test('cookie parsing picks the right value and ignores the rest', () => {
  assert.equal(readCookie(`other=1; ${COOKIE_NAME}=wanted; another=2`, COOKIE_NAME), 'wanted');
  assert.equal(readCookie('other=1', COOKIE_NAME), null);
  assert.equal(readCookie('', COOKIE_NAME), null);
  assert.equal(readCookie(undefined, COOKIE_NAME), null);
  // A cookie whose name merely contains the session name must not match.
  assert.equal(readCookie(`not_${COOKIE_NAME}=nope`, COOKIE_NAME), null);
});

test('session tokens are long and unpredictable', () => {
  const tokens = new Set();
  for (let i = 0; i < 40; i += 1) {
    const { token } = createSession(adminId);
    assert.ok(token.length >= 40, 'a guessable token would be as good as no auth');
    tokens.add(token);
  }
  assert.equal(tokens.size, 40, 'every session token is distinct');
  db.exec(`DELETE FROM sessions WHERE employee_id = ${adminId}`);
});
