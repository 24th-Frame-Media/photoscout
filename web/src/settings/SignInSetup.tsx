import { useEffect, useState } from 'react';
import { api, AuthConfig, Provider } from '../api.js';

const LABEL: Record<Provider, string> = { discord: 'Discord', google: 'Google' };
const WHERE: Record<Provider, { url: string; steps: string }> = {
  discord: { url: 'https://discord.com/developers/applications', steps: 'Your app → OAuth2: copy the Client ID and Client Secret, and add the redirect above.' },
  google: { url: 'https://console.cloud.google.com/apis/credentials', steps: 'Create an OAuth client ID (Web application) and add the redirect above as an authorised redirect URI.' },
};

/**
 * Settings → Sign-in: which providers people can sign in with, and their keys.
 * Anything set in the environment is shown as such and left alone here.
 */
export default function SignInSetup() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.authConfig().then(setConfig).catch((err) => setError((err as Error).message)); }, []);

  if (!config) return <section><h2>🔑 Sign-in</h2>{error ? <p className="status-line error">{error}</p> : <p className="hint">Loading…</p>}</section>;
  return (
    <section>
      <h2>🔑 Sign-in</h2>
      <p className="hint">
        People sign in with any provider set up here. Providers send them back to{' '}
        <code>{config.publicUrl}</code>{config.publicUrlFromEnv ? ' (PUBLIC_URL)' : ' — set PUBLIC_URL in the environment to this site\'s real address'}.
      </p>
      {config.providers.map((p) => <ProviderRow key={p.name} p={p} onSaved={setConfig} />)}
      <h3>Admins</h3>
      <p className="hint">
        {config.adminIdsSet
          ? <>Accounts named in <code>ADMIN_IDS</code> become admins when they sign in.</>
          : <>No <code>ADMIN_IDS</code> set. Admins can still promote others under Users.</>}
        {' '}An account's id is shown under <a href="#account">Account</a>.
      </p>
    </section>
  );
}

function ProviderRow({ p, onSaved }: { p: AuthConfig['providers'][number]; onSaved: (c: AuthConfig) => void }) {
  const [clientId, setClientId] = useState(p.clientId);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const send = async (body: Parameters<typeof api.saveAuthProvider>[1], done: string) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const next = await api.saveAuthProvider(p.name, body);
      onSaved(next);
      setSecret('');
      setClientId(next.providers.find((x) => x.name === p.name)?.clientId ?? '');
      setMsg(done);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="signinsetup">
      <h3>
        {LABEL[p.name]}{' '}
        <span className={`status-line ${p.ready ? 'ok' : ''}`}>{p.ready ? '● on' : '○ off'}</span>
      </h3>
      <div className="formrow"><label>Redirect</label>
        <input readOnly value={p.redirectUrl} onFocus={(e) => e.target.select()} aria-label={`${LABEL[p.name]} redirect URL`} />
      </div>
      {p.fromEnv ? (
        <p className="hint">Set by <code>{p.name.toUpperCase()}_CLIENT_ID</code> and <code>{p.name.toUpperCase()}_CLIENT_SECRET</code> in the environment — change it there.</p>
      ) : (
        <>
          <div className="formrow"><label>Client ID</label>
            <input value={clientId} autoComplete="off" maxLength={200} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="formrow"><label>Client secret</label>
            <input type="password" autoComplete="off" maxLength={200} value={secret}
              placeholder={p.secretSet ? '•••••••• (saved — enter a new one to replace)' : 'Paste the client secret'}
              onChange={(e) => setSecret(e.target.value)} />
          </div>
          <div className="eventcard__actions">
            <button className="primary" disabled={busy || !clientId.trim() || (!secret.trim() && !p.secretSet)}
              onClick={() => void send({ clientId: clientId.trim(), clientSecret: secret.trim() }, 'Saved.')}>Save</button>
            {(p.clientId || p.secretSet) && <button disabled={busy} onClick={() => void send({ clear: true }, 'Turned off.')}>Turn off</button>}
            {msg && <span className="hint">{msg}</span>}
          </div>
          <p className="hint">
            From <a href={WHERE[p.name].url} target="_blank" rel="noreferrer">{WHERE[p.name].url.replace('https://', '')}</a>. {WHERE[p.name].steps}
            {' '}The secret is never shown again.
          </p>
        </>
      )}
      {error && <p className="status-line error">{error}</p>}
    </div>
  );
}
