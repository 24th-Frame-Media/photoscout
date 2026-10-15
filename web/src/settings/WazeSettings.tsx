import { useEffect, useState } from 'react';
import { api, type WazeStatus } from '../api.js';
import { logActivity } from '../activity.js';

// The server adds first_run for every visitor, but `how` (operator instructions) only for admins.
type SetupWithFirstRun = WazeStatus['setup'] & { first_run?: { detected_at?: number | null; how?: string } };

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Clipboard access is blocked here; use the selection fallback. */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  return copied;
}

/** Police and hazard reports from Waze. Admins set the feed up; everyone can test it. */
export default function WazeSettings({ isAdmin = false }: { isAdmin?: boolean }) {
  const [status, setStatus] = useState<WazeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => { if (error) logActivity('Police and hazards setup', error, 'error'); }, [error]);
  useEffect(() => {
    if (status?.setup) logActivity('Police and hazards setup', status.setup.message, status.setup.state === 'failed' ? 'error' : status.setup.state === 'ready' ? 'success' : 'info');
    if (status?.checked) logActivity('Police and hazards', status.liveMapStatus.accessible ? `Connected; ${status.alertCount ?? 0} reports returned` : 'Not connected; reports unavailable', status.liveMapStatus.accessible ? 'success' : 'error');
  }, [status?.setup?.message, status?.setup?.state, status?.checked, status?.alertCount, status?.liveMapStatus.accessible]);
  async function load(check = false) {
    setLoading(true);
    setError(null);
    try { setStatus(await api.wazeStatus(check)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Status unavailable'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const settingUp = status?.setup && ['installing', 'starting'].includes(status.setup.state);
  const waitingForPerson = status?.setup.state === 'needs_first_run';
  const firstRunHow = (status?.setup as SetupWithFirstRun | undefined)?.first_run?.how;
  useEffect(() => {
    if (!settingUp && !waitingForPerson) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [settingUp, waitingForPerson]);
  async function setup() {
    setError(null);
    try { await api.wazeSetup(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Setup failed'); }
  }
  async function copyInstructions() {
    setCopy((await copyText(firstRunHow ?? '')) ? 'copied' : 'failed');
  }
  const setupTone = status?.setup.state === 'failed' ? 'error' : status?.setup.state === 'ready' ? 'ok' : '';
  // Plain words for what a user needs to know. A zero count is not an all-clear, and raw service messages are for admins only.
  const connection = !status ? null
    : waitingForPerson ? { tone: '', text: isAdmin ? 'Waze is waiting for its first-run screen. Finish it with the steps below.' : 'Police & hazard reports are being set up.' }
    : !status.configured ? { tone: '', text: isAdmin ? 'Not set up yet. Use Set up Waze reports above.' : 'Not set up on this server yet.' }
    : !status.checked ? { tone: '', text: 'Not checked yet. Press Test connection to check.' }
    : status.liveMapStatus.accessible ? { tone: 'ok', text: status.alertCount ? `Connected. ${status.alertCount} reports are available right now.` : 'Connected. No reports are available right now, which does not mean the roads are clear.' }
    : { tone: 'error', text: `Not connected. Reports can't load right now.${isAdmin ? ` (${status.liveMapStatus.message})` : ''}` };
  return <section>
    <h2>👮 Police &amp; hazards</h2>
    <p className="hint">Community reports from Waze: police, crashes, hazards and roadworks. They show on the map under Live, and Drive warns you about the ones ahead on your route.</p>
    {error && <p role="alert" className="status-line error">{error}</p>}
    {isAdmin && <div className="waze-status-card">
      <h3>Set up reports</h3>
      <p className="hint">Uses an Android test device already connected to this computer, or starts one in Docker. Setup installs Waze, connects the reports and saves the connection. The first start can take 15–30 minutes.</p>
      <button type="button" disabled={!!settingUp} onClick={() => void setup()}>{settingUp ? 'Setting up…' : 'Set up Waze reports'}</button>
      {status?.setup && <p className={`status-line${setupTone ? ` ${setupTone}` : ''}`} role="status">{status.setup.message}</p>}
    </div>}
    {isAdmin && waitingForPerson && <div className="waze-status-card">
      <h3>Finish Waze's first-run screen</h3>
      <p className="hint">Waze shows a welcome screen the first time it runs on this server. Someone with server access completes it once; the result is kept, and reports start after that.</p>
      <pre><code>{firstRunHow ?? 'Waze needs its first-run screen completed once. See services/waze-harvester/README.md for the steps.'}</code></pre>
      <button type="button" onClick={() => void copyInstructions()} disabled={!firstRunHow}>{copy === 'copied' ? 'Copied' : 'Copy instructions'}</button>
      {copy === 'failed' && <p className="status-line error" role="status">Copy did not work. Select the instructions and copy them by hand.</p>}
    </div>}
    {status && <div className="waze-status-card">
      <h3>Connection</h3>
      {connection && <p className={`status-line${connection.tone ? ` ${connection.tone}` : ''}`}>{connection.text}</p>}
      {status.checked && status.observedAt && <p className="hint">Last read from Waze: {new Date(status.observedAt).toLocaleString()}</p>}
      {status.coverage === 'route' && <p className="hint">Only reports along the route in the Waze app are included, so other roads may show none.</p>}
      {status.coverage === 'viewport' && <p className="hint">Reports cover the areas you look at on the map. A new area takes a moment to load.</p>}
    </div>}
    <button type="button" className="primary mt-12" disabled={loading} onClick={() => void load(true)}>
      {loading ? 'Checking…' : 'Test connection'}
    </button>
    <p className="hint">Showing reports sends the map area you look at to Waze. Turn them off on the map or in Drive to stop. Data: Waze / Google.</p>
  </section>;
}
