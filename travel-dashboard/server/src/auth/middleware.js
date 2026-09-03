import { COOKIE_NAME, readCookie, resolveSession } from './sessions.js';

/**
 * Attaches the signed-in employee to the request, if there is one.
 *
 * Deliberately does not reject: some routes are public by design, so the
 * decision to refuse belongs to `requireAuth` further down.
 */
export function attachUser(req, _res, next) {
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  req.sessionToken = token;
  req.user = token ? resolveSession(token) : null;
  next();
}

/** Everything internal sits behind this. */
export function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Please sign in to continue.', code: 'UNAUTHENTICATED' });
    return;
  }
  next();
}

const RANK = { consultant: 1, manager: 2, admin: 3 };

/**
 * Role gate. Agency configuration — exchange rates especially, since they price
 * every future quotation — is limited to administrators.
 */
export function requireRole(minimum) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Please sign in to continue.', code: 'UNAUTHENTICATED' });
      return;
    }
    if ((RANK[req.user.role] ?? 0) < (RANK[minimum] ?? 99)) {
      res.status(403).json({
        error: `This needs ${minimum} access. You are signed in as ${req.user.role}.`,
        code: 'FORBIDDEN',
      });
      return;
    }
    next();
  };
}
