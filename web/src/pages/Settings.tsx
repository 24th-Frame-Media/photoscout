import { FormEvent, useEffect, useState } from 'react';
import { api, Area, GeocodeResult, Role, Settings as SettingsType, TaskStatus, TrainsStatus, User } from '../api.js';

import EventsGeneral from '../settings/events/General.js';
import EventsSources from '../settings/events/Sources.js';
import EventsCrawler from '../settings/events/Crawler.js';
import EventsDensity from '../settings/events/Density.js';
import EventsPlaces from '../settings/events/Places.js';
import EventsConditions from '../settings/events/Conditions.js';
import EventsBusyMap from '../settings/events/DensityView.js';
import EventsModel from '../settings/events/Model.js';
import EventsNotify from '../settings/events/Notify.js';
import EventTasks from '../settings/events/EventTasks.js';
import { GROUPS, Tab, tabFromHash } from '../settings/tabs.js';
import SignInSetup from '../settings/SignInSetup.js';
import AreaCategories from '../settings/AreaCategories.js';

export default function Settings({ user, account, onChange }: { user: User | null; account: string | null; onChange: () => void }) {
  const isAdmin = user?.role === 'admin';
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [geoQuery, setGeoQuery] = useState('');
  const [geoResults, setGeoResults] = useState<GeocodeResult[] | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [trains, setTrains] = useState<TrainsStatus | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState('');
  const [tab, setTabState] = useState<Tab>(() => tabFromHash(window.location.hash));
  const setTab = (t: Tab) => { setTabState(t); history.replaceState(null, '', `#${t}`); };
  // A link to another tab while already here changes only the hash.
  useEffect(() => {
    const follow = () => setTabState(tabFromHash(window.location.hash));
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  useEffect(() => { api.settings().then(setDraft).catch((err) => setError((err as Error).message)); }, []);
  useEffect(() => { api.trainsStatus().then(setTrains).catch(() => {}); }, []);
  if (!draft) return <div className="page">{error ? <p className="status-line error">{error}</p> : <p className="hint">Loading…</p>}</div>;

  const set = (patch: Partial<SettingsType>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
    setDirty(true);
  };

  const searchCity = async () => {
    if (!geoQuery.trim()) return;
    setGeoBusy(true);
    try {
      setGeoResults(await api.geocode(geoQuery));
    } catch (err) {
      alert(`Geocoding failed: ${(err as Error).message}`);
    } finally {
      setGeoBusy(false);
    }
  };

  const save = async () => {
    setError('');
    try {
      setDraft(await api.saveSettings(draft));
      setSaved(true);
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Saved on its own (not via the savebar) so the key is only ever sent when typed in.
  const saveKey = async (clear: boolean) => {
    setKeyBusy(true); setKeyMsg('');
    try {
      const next = await api.saveSettings(clear ? { clearTfnswApiKey: true } : { tfnswApiKey: keyInput.trim() });
      setDraft((d) => (d ? { ...d, tfnswApiKeySet: next.tfnswApiKeySet, tfnswApiKeyFromEnv: next.tfnswApiKeyFromEnv } : next));
      setKeyInput('');
      setKeyMsg(clear ? 'Key cleared.' : 'Key saved — importing timetables in the background.');
      api.trainsStatus().then(setTrains).catch(() => {});
    } catch (err) {
      setKeyMsg(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const fromResult = (r: GeocodeResult, radiusKm: number): Area => ({ name: r.displayName.split(',')[0], lat: r.lat, lng: r.lng, radiusKm, events: true, busy: false });
  // Home is area 0 of one list; the rest are draft.areas.
  const all = [draft.home, ...draft.areas];
  const setAll = (list: Area[]) => set({ home: list[0], areas: list.slice(1) });
  const setArea = (i: number, patch: Partial<Area>) => setAll(all.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const makeHome = (i: number) => setAll([all[i], ...all.filter((_, j) => j !== i)]);
  const groups = GROUPS.map((g) => ({ ...g, tabs: g.tabs.filter((t) => isAdmin || !t.admin) })).filter((g) => g.tabs.length > 0);

  return (
    <div className="page settings">
      <h1>Settings</h1>
      <div className="settings__layout">
      <nav className="settingsnav" aria-label="Settings">
        {groups.map((g) => (
          <div key={g.label} className="settingsnav__group">
            <h3>{g.label}</h3>
            {g.tabs.map((t) => (
              <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} className={`settingsnav__item${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        ))}
      </nav>
      {/* On a phone the list above would fill the screen: one picker instead. */}
      <select className="settingspick" aria-label="Settings section" value={tab} onChange={(e) => setTab(e.target.value as Tab)}>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </optgroup>
        ))}
      </select>
      <div className="settings__body">
      {/* Outside the fieldset below: your own account is yours to change, admin or not. */}
      {tab === 'account' && user && <><Account user={user} account={account} onChange={onChange} /><CalendarLink /></>}
      {!isAdmin && tab !== 'account' && <div className="banner">Only an admin can change these.</div>}
      <fieldset disabled={!isAdmin} className="bare">
        {tab === 'areas' && <section>
          <h2>📍 Areas</h2>
          <p className="hint">Every place the app looks around. The first is home, where the map opens; feeds and Plan a shoot search around all of them. The switches say where events are scraped and where venues are watched for how busy they are.</p>
          <div className="formrow">
            <label>Find a place</label>
            <input value={geoQuery} placeholder="e.g. Bathurst NSW" onChange={(e) => setGeoQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void searchCity(); } }} />
            <button onClick={() => void searchCity()} disabled={geoBusy}>{geoBusy ? 'Searching…' : 'Search'}</button>
          </div>
          {geoResults && (
            <div className="geocode-results">
              {geoResults.length === 0 && <span className="hint">No matches found.</span>}
              {geoResults.map((r) => (
                <div key={`${r.lat},${r.lng}`} className="feedrow">
                  <span style={{ flex: 1 }}>📍 {r.displayName}</span>
                  <button onClick={() => { setAll([fromResult(r, draft.home.radiusKm), ...all]); setGeoResults(null); }}>Make home</button>
                  <button onClick={() => { setAll([...all, fromResult(r, 30)]); setGeoResults(null); }}>+ Area</button>
                </div>
              ))}
            </div>
          )}
          <ul className="arealist">
            {all.map((a, i) => (
              <li key={i} className="arealist__row">
                <div className="arealist__head">
                  <input aria-label="Area name" value={a.name} maxLength={100} onChange={(e) => setArea(i, { name: e.target.value })} />
                  {i === 0 ? <span className="arealist__home">Home</span> : <button className="linkbtn" onClick={() => makeHome(i)}>Make home</button>}
                  {i > 0 && <button aria-label={`Remove ${a.name}`} onClick={() => setAll(all.filter((_, j) => j !== i))}>✕</button>}
                </div>
                <div className="arealist__opts">
                  <label>Reach <input type="number" min={1} max={1000} value={a.radiusKm} onChange={(e) => setArea(i, { radiusKm: Number(e.target.value) })} /> km</label>
                  <label className="toggle"><input type="checkbox" checked={a.events} onChange={(e) => setArea(i, { events: e.target.checked })} /> Events</label>
                  <label className="toggle"><input type="checkbox" checked={a.busy} onChange={(e) => setArea(i, { busy: e.target.checked })} /> Busy places</label>
                </div>
                {a.events && <AreaCategories area={a} onChange={(patch) => setArea(i, patch)} />}
                <p className="hint">{a.lat.toFixed(3)}, {a.lng.toFixed(3)} · {areaUses(a, i === 0)}</p>
              </li>
            ))}
          </ul>
        </section>}

        {tab === 'instance' && isAdmin && <section>
          <h2>🔗 Instance</h2>
          <div className="formrow"><label>Private remotes</label>
            <input type="checkbox" checked={draft.allowPrivateRemotes} onChange={(e) => set({ allowPrivateRemotes: e.target.checked })} />
            <span className="hint">Let remotes resolve to LAN addresses.</span></div>
        </section>}

        {tab === 'feeds' && <section>
          <h2>🚆 Trains</h2>
          <div className="formrow"><label>TfNSW trains</label>
            {trains ? (
              <span className={`status-line ${trains.configured ? 'ok' : ''}`}>
                {trains.configured ? '●' : '○'} {trains.configured ? `configured · ${trains.tripCount} trips imported` : 'not configured'}
                {trains.lastImport ? ` · last import ${new Date(trains.lastImport).toLocaleString()}` : ''}
              </span>
            ) : <span className="hint">Loading…</span>}
          </div>
          {draft.tfnswApiKeyFromEnv ? (
            <p className="hint">Set by the <code>TFNSW_API_KEY</code> environment variable — change it there.</p>
          ) : (
            <>
              <div className="formrow"><label>TfNSW API key</label>
                <input type="password" autoComplete="off" value={keyInput} placeholder={draft.tfnswApiKeySet ? '•••••••• (saved — enter a new one to replace)' : 'Paste your Open Data API key'}
                  onChange={(e) => { setKeyInput(e.target.value); setKeyMsg(''); }} />
                <button type="button" onClick={() => void saveKey(false)} disabled={!keyInput.trim() || keyBusy}>Save key</button>
                {draft.tfnswApiKeySet && <button type="button" onClick={() => void saveKey(true)} disabled={keyBusy}>Clear</button>}
              </div>
              <p className="hint">
                {draft.tfnswApiKeySet ? 'A key is saved' : 'No key saved'} — it's never shown or sent back here.
                Get one free from <a href="https://opendata.transport.nsw.gov.au/" target="_blank" rel="noreferrer">TfNSW Open Data</a>.
                {keyMsg && <> {keyMsg}</>}
              </p>
            </>
          )}
        </section>}
      </fieldset>

      {isAdmin && (tab === 'areas' || tab === 'instance') && (
        <div className="savebar">
          <button className="primary" onClick={() => void save()} disabled={!dirty}>Save</button>
          <span className="note">{error ? <span className="status-line error">{error}</span> : saved ? 'Saved.' : dirty ? 'Unsaved changes.' : ''}</span>
        </div>
      )}

      {isAdmin && (tab === 'events' || tab === 'sources' || tab === 'crawler' || tab === 'density' || tab === 'venues' || tab === 'busy' || tab === 'conditions' || tab === 'model' || tab === 'notify') && (
        <div className="evs">
          {tab === 'events' && <EventsGeneral />}
          {tab === 'sources' && <EventsSources />}
          {tab === 'crawler' && <EventsCrawler />}
          {tab === 'density' && <EventsDensity />}
          {tab === 'venues' && <EventsPlaces />}
          {tab === 'busy' && <EventsBusyMap />}
          {tab === 'conditions' && <EventsConditions />}
          {tab === 'model' && <EventsModel />}
          {tab === 'notify' && <EventsNotify />}
        </div>
      )}
      {isAdmin && tab === 'tasks' && <><Tasks /><div className="evs"><EventTasks /></div></>}
      {isAdmin && tab === 'signin' && <SignInSetup />}
      {isAdmin && tab === 'users' && <Users me={user!} />}
      </div>
      </div>
    </div>
  );
}

/** What looks at an area, for the line under it. */
function areaUses(a: Area, home: boolean): string {
  const uses = ['the map', 'feeds'];
  if (a.events) uses.push('events');
  if (a.busy) uses.push('busy venues (within 10 km)');
  return `${home ? 'The map opens here. ' : ''}Used for ${uses.join(', ')}`;
}

function Tasks() {
  const [tasks, setTasks] = useState<TaskStatus[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<string | null>(null);

  const load = () => api.tasks().then((r) => setTasks(r.tasks)).catch((err) => setError((err as Error).message));
  useEffect(() => { void load(); }, []);

  const run = async (name: string) => {
    setRunning(name);
    try { await api.runTask(name); await load(); } catch (err) { setError((err as Error).message); } finally { setRunning(null); }
  };

  return (
    <section>
      <h2>⚙ Background tasks</h2>
      <table className="triptable">
        <thead><tr><th>Task</th><th>Status</th><th>Last run</th><th /></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.name}>
              <td>{t.label}<div className="hint">{t.description}</div></td>
              <td>{!t.enabled ? 'off' : t.running ? 'running…' : t.lastOk == null ? '—' : t.lastOk ? '✓' : '✕ failed'}</td>
              <td className="hint">{t.lastRun ? `${new Date(t.lastRun).toLocaleString()} — ${t.lastResult ?? ''}` : 'never'}</td>
              <td><button onClick={() => void run(t.name)} disabled={running === t.name || t.running}>{running === t.name ? 'Running…' : 'Run now'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="status-line error">{error}</p>}
    </section>
  );
}

function Account({ user, account, onChange }: { user: User; account: string | null; onChange: () => void }) {
  const [handle, setHandle] = useState(user.username);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      await api.setHandle(handle.trim());
      setMessage('Saved');
      onChange();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <section>
      <h2>👤 Account</h2>
      <form className="formrow" onSubmit={save}>
        <label>Handle</label>
        <input value={handle} minLength={3} maxLength={24} pattern="[A-Za-z0-9_]+" onChange={(e) => setHandle(e.target.value)} required />
        <button type="submit" disabled={handle.trim() === user.username}>Save</button>
      </form>
      <p className="hint">3 to 24 letters, digits or underscores. This is the name other people see.</p>
      {message && <p className="status-line ok">{message}</p>}
      {error && <p className="status-line error">{error}</p>}
      {account && <p className="hint mt-12">Account id: <code>{account}</code></p>}
    </section>
  );
}

/**
 * The secret link a calendar app subscribes to: the public events plus your shortlist.
 * Only a hash is kept, so the link is shown once, when it is made; making another replaces the old one.
 */
function CalendarLink() {
  const [exists, setExists] = useState<boolean | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.calendarLink().then((r) => setExists(r.exists)).catch((err) => setError((err as Error).message)); }, []);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const make = () => run(async () => { setUrl((await api.makeCalendarLink()).url); setExists(true); });
  const revoke = () => run(async () => { await api.revokeCalendarLink(); setUrl(''); setExists(false); });

  return (
    <section className="calendarlink">
      <h2>📅 Calendar link</h2>
      <p className="hint">Subscribe from Google Calendar, Apple Calendar or Outlook to see the public events, minus any you have hidden. Add <code>?starred=1</code> to the end for your shortlist only. Anyone with the link can read the feed, so keep it to yourself.</p>
      {url && (
        <>
          <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Calendar link" />
          <p className="hint">Copy it now. It cannot be shown again; make a new one if you lose it.</p>
        </>
      )}
      <div className="eventcard__actions">
        <button className="primary" disabled={busy || exists === null} onClick={() => void make()}>{exists ? 'Make a new link' : 'Make a link'}</button>
        {exists && <button disabled={busy} onClick={() => void revoke()}>Turn it off</button>}
        {exists && !url && <span className="hint">You have a link. Making a new one stops the old one working.</span>}
      </div>
      {error && <p className="status-line error">{error}</p>}
    </section>
  );
}

function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');

  const load = () => api.users().then(setUsers).catch((err) => setError((err as Error).message));
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <section>
      <h2>👥 Users</h2>
      <table className="triptable">
        <thead><tr><th>User</th><th>Role</th><th>Since</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}{u.id === me.id && <span className="hint"> (you)</span>}{u.banned && <span className="hint"> · suspended</span>}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id} style={{ width: 'auto' }} onChange={(e) => void run(() => api.updateUser(u.id, { role: e.target.value as Role }))}>
                  <option value="contributor">contributor</option>
                  <option value="moderator">moderator</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td className="hint">{new Date(u.created_at).toLocaleDateString()}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {u.id !== me.id && <button onClick={() => void run(() => api.updateUser(u.id, { banned: !u.banned }))}>{u.banned ? 'Reinstate' : 'Suspend'}</button>}{' '}
                {u.id !== me.id && <button onClick={() => { if (confirm(`Delete ${u.username}?`)) void run(() => api.deleteUser(u.id)); }}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="status-line error">{error}</p>}
    </section>
  );
}
