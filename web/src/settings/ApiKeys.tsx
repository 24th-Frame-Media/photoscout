import { useEffect, useState } from 'react';
import { api, UserApiKeys } from '../api.js';

export default function ApiKeys({ onKeyChange }: { onKeyChange?: () => void }) {
  const [keys, setKeys] = useState<UserApiKeys | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // TfNSW state
  const [tfnswInput, setTfnswInput] = useState('');
  const [tfnswBusy, setTfnswBusy] = useState(false);
  const [tfnswMsg, setTfnswMsg] = useState('');

  // OpenAIP state
  const [openaipInput, setOpenaipInput] = useState('');
  const [openaipBusy, setOpenaipBusy] = useState(false);
  const [openaipMsg, setOpenaipMsg] = useState('');

  useEffect(() => {
    api.userApiKeys()
      .then((k) => { setKeys(k); setLoading(false); })
      .catch((err) => { setError((err as Error).message); setLoading(false); });
  }, []);

  const saveTfnsw = async (clear: boolean) => {
    setTfnswBusy(true);
    setTfnswMsg('');
    try {
      const next = await api.saveUserApiKey('tfnsw', { ...(clear ? { clear: true } : { apiKey: tfnswInput.trim() }) });
      setKeys(next);
      setTfnswInput('');
      setTfnswMsg(clear ? 'Key cleared.' : 'Key saved — importing timetables in the background.');
      onKeyChange?.();
    } catch (err) {
      setTfnswMsg(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setTfnswBusy(false);
    }
  };

  const saveOpenaip = async (clear: boolean) => {
    setOpenaipBusy(true);
    setOpenaipMsg('');
    try {
      const next = await api.saveUserApiKey('openaip', { ...(clear ? { clear: true } : { apiKey: openaipInput.trim() }) });
      setKeys(next);
      setOpenaipInput('');
      setOpenaipMsg(clear ? 'Key cleared.' : 'Key saved.');
      onKeyChange?.();
    } catch (err) {
      setOpenaipMsg(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setOpenaipBusy(false);
    }
  };

  if (loading) return <section><h2>🔑 API keys</h2><p className="hint">Loading…</p></section>;
  if (error) return <section><h2>🔑 API keys</h2><p className="status-line error">{error}</p></section>;

  return (
    <section>
      <h2>🔑 API keys</h2>
      <p className="hint">
        Configure your personal third-party API credentials. Keys are write-only, stored only for your account, and never sent back to the browser.
      </p>

      <h3>TfNSW Open Data</h3>
      <div className="formrow">
        <label>Status</label>
        <span className={`status-line ${keys?.tfnswKeySet ? 'ok' : ''}`}>
          {keys?.tfnswKeySet ? '● Saved' : '○ Not saved'}
        </span>
      </div>
      <div className="formrow">
        <label>API key</label>
        <input
          type="password"
          autoComplete="off"
          value={tfnswInput}
          placeholder={keys?.tfnswKeySet ? '•••••••• (saved — enter a new one to replace)' : 'Paste your Open Data API key'}
          onChange={(e) => { setTfnswInput(e.target.value); setTfnswMsg(''); }}
        />
        <button type="button" onClick={() => void saveTfnsw(false)} disabled={!tfnswInput.trim() || tfnswBusy}>Save key</button>
        {keys?.tfnswKeySet && <button type="button" onClick={() => void saveTfnsw(true)} disabled={tfnswBusy}>Clear</button>}
      </div>
      <p className="hint">
        {keys?.tfnswKeySet ? 'A key is saved' : 'No key saved'} — powers live trains and traffic camera feeds.
        Get one free from <a href="https://opendata.transport.nsw.gov.au/" target="_blank" rel="noreferrer">TfNSW Open Data</a>.
        {tfnswMsg && <> {tfnswMsg}</>}
      </p>

      <h3>OpenAIP</h3>
      <div className="formrow">
        <label>Status</label>
        <span className={`status-line ${keys?.openaipKeySet ? 'ok' : ''}`}>
          {keys?.openaipKeySet ? '● Saved' : '○ Not saved'}
        </span>
      </div>
      <div className="formrow">
        <label>API key</label>
        <input
          type="password"
          autoComplete="off"
          value={openaipInput}
          placeholder={keys?.openaipKeySet ? '•••••••• (saved — enter a new one to replace)' : 'Paste your OpenAIP API key'}
          onChange={(e) => { setOpenaipInput(e.target.value); setOpenaipMsg(''); }}
        />
        <button type="button" onClick={() => void saveOpenaip(false)} disabled={!openaipInput.trim() || openaipBusy}>Save key</button>
        {keys?.openaipKeySet && <button type="button" onClick={() => void saveOpenaip(true)} disabled={openaipBusy}>Clear</button>}
      </div>
      <p className="hint">
        {keys?.openaipKeySet ? 'A key is saved' : 'No key saved'} — aviation data and airspace for drone operations.
        Get one from <a href="https://www.openaip.net/" target="_blank" rel="noreferrer">https://www.openaip.net/</a>.
        {openaipMsg && <> {openaipMsg}</>}
      </p>
    </section>
  );
}
