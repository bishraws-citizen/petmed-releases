import { useState } from 'react';

import { useAuth } from '../lib/auth';

/** The only agency screen reachable without a session. */
export function SignInPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin-page">
      <form className="signin-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <span className="brand-mark" aria-hidden>V</span>
          <span>
            <div className="brand-name">Voyager</div>
            <div className="brand-sub">Travel agency ops</div>
          </span>
        </div>

        <h1 className="signin-title">Sign in</h1>
        <p className="card-sub" style={{ marginBottom: 16 }}>
          This workspace holds customer passport details and agency pricing.
        </p>

        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="field">
          <label className="field-label" htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label className="field-label" htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
          style={{ width: '100%', marginTop: 18, padding: '10px 16px' }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
