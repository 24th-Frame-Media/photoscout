import { useEffect, useState } from 'react';
import { api, AccessConfig } from '../api.js';

/**
 * Settings → Instance: who may look at this instance without signing in.
 *
 * Private is the default and the safe choice: nothing but signing in is open.
 * Turning it off allows public read access, so a visitor can browse the public
 * map. The choice saves as soon as it changes. When PUBLIC_READS is set in the
 * server's environment it wins, and the control is shown but locked.
 */
export default function AccessSetting() {
  const [config, setConfig] = useState<AccessConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError('');
    api.getAccess().then(setConfig).catch((err) => setLoadError((err as Error).message));
  };
  useEffect(load, []);

  if (!config) {
    return (
      <div>
        <h3>Who can view</h3>
        {loadError
          ? <><p className="status-line error">{loadError}</p><button type="button" className="sm" onClick={load}>Try again</button></>
          : <p className="hint">Loading…</p>}
      </div>
    );
  }

  const locked = config.source === 'env';
  const priv = !config.publicReads;

  // Checked means private, so the request is for public reads when the box is being cleared.
  const change = async (nowPrivate: boolean) => {
    setBusy(true); setError(''); setMsg('');
    try {
      setConfig(await api.setAccess(!nowPrivate));
      setMsg('Saved.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <h3>Who can view</h3>
      <label className="toggle">
        <input type="checkbox" checked={priv} disabled={busy || locked} aria-describedby="access-hint"
          onChange={(e) => void change(e.target.checked)} />
        Require sign-in to view (private instance)
      </label>
      <p className="hint" id="access-hint">
        {priv
          ? 'Private: nobody sees the map, events or feed until they sign in. Sign-in itself, share links and calendar links still work.'
          : 'Allow public read access: visitors who have not signed in can browse the public map, events and feed. Writes always need a sign-in.'}
        {' '}Saved as soon as you change it.
        {msg && <> {msg}</>}
      </p>
      {locked && (
        <p className="hint">
          Set by <code>PUBLIC_READS</code> in the environment ({config.publicReads ? 'public reads on' : 'private'}) — change it there.
        </p>
      )}
      {error && <p className="status-line error">{error}</p>}
    </div>
  );
}
