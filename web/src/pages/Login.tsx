import { Provider } from '../api.js';

const LABEL: Record<Provider, string> = { google: 'Google', discord: 'Discord' };

/**
 * Sign-in is handed to a provider: the buttons are plain links to the server,
 * which sends the browser on and gets it back. There is no password to type
 * here because there is none to keep.
 */
export default function Login({ providers }: { providers: Provider[] }) {
  const error = new URLSearchParams(window.location.search).get('error');
  return (
    <div className="signin signin--page">
      <h2>Sign in</h2>
      {error && <p className="status-line error">{error}</p>}
      {providers.length === 0 && <p className="hint">Sign-in is not set up on this instance yet.</p>}
      <div className="signin__providers">
        {providers.map((p) => (
          <a key={p} className="button primary" href={`/api/auth/${p}/start`}>Continue with {LABEL[p]}</a>
        ))}
      </div>
      <p className="hint mt-12">
        We keep the name and picture your provider shows and nothing else: no email address, no password.
      </p>
      <p className="hint">
        By signing in you agree to the <a href="/terms">terms</a>. See how we handle your data in the <a href="/privacy">privacy policy</a>.
      </p>
    </div>
  );
}
