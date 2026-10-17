import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CatalogItem, type Gear, type GearInput, type Profile, type Ride, type RideInput, type User } from '../api.js';
import { gearTitle, rideTitle } from '../kit.js';
import { prepareUpload } from '../photos.js';

/**
 * Your own profile and Kit: a bio, an Instagram handle, the cars and bikes you
 * drive (with up to six photos each) and the camera gear you shoot with. What
 * is typed here is sent as text; the server checks every field again.
 */
export default function Kit({ user, onChange }: { user: User | null; onChange: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const load = () => (user ? api.profile(user.username).then(setProfile).catch((err) => setError((err as Error).message)) : Promise.resolve());
  useEffect(() => { void load(); }, [user?.username]);

  if (!user) return <div className="page"><p className="hint">Sign in to keep your profile and Kit.</p></div>;
  return (
    <div className="page settings">
      <h1>Kit</h1>
      <p className="hint">What other people see on <Link to={`/u/${encodeURIComponent(user.username)}`}>your profile</Link>.</p>
      {error && <p className="status-line error">{error}</p>}
      <AboutYou user={user} onChange={onChange} />
      {profile && (
        <>
          <Rides rides={profile.rides} reload={load} />
          <Garage gear={profile.gear} reload={load} />
        </>
      )}
    </div>
  );
}

function AboutYou({ user, onChange }: { user: User; onChange: () => void }) {
  const [bio, setBio] = useState(user.bio);
  const [instagram, setInstagram] = useState(user.instagram);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(''); setMessage('');
    try {
      await api.saveProfile({ bio, instagram });
      setMessage('Saved');
      onChange();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <section>
      <h2>About you</h2>
      <form className="editor-form" onSubmit={save}>
        <label>Bio
          <textarea value={bio} maxLength={500} rows={3} onChange={(e) => setBio(e.target.value)} />
        </label>
        <label>Instagram handle
          <input value={instagram} maxLength={31} placeholder="yourhandle" pattern="@?[A-Za-z0-9._]{1,30}" onChange={(e) => setInstagram(e.target.value)} />
        </label>
        <p className="hint">Just the handle, not a link: letters, digits, dots and underscores.</p>
        <button type="submit" className="primary">Save</button>
        {message && <span className="status-line ok"> {message}</span>}
        {error && <p className="status-line error">{error}</p>}
      </form>
    </section>
  );
}

const BLANK_RIDE: RideInput = { kind: 'car', make: '', model: '', year: null, nickname: '', notes: '' };

function Rides({ rides, reload }: { rides: Ride[]; reload: () => Promise<unknown> }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await reload(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <section>
      <h2>Rides</h2>
      <p className="hint">Cars and motorbikes, up to 30.</p>
      {rides.map((r) => (
        <div key={r.id} className="kititem">
          <div className="feedrow">
            <strong className="grow">{r.kind === 'motorbike' ? '🏍️' : '🚗'} {rideTitle(r)}</strong>
            <button onClick={() => setEditing(editing === r.id ? null : r.id)}>{editing === r.id ? 'Close' : 'Edit'}</button>
            <button className="danger" onClick={() => { if (confirm(`Remove ${rideTitle(r)}?`)) void run(() => api.deleteRide(r.id)); }}>Remove</button>
          </div>
          {editing === r.id && <RideForm initial={r} onSave={(v) => run(async () => { await api.updateRide(r.id, v); setEditing(null); })} />}
          <div className="kitphotos">
            {r.photos.map((p) => (
              <span key={p.id} className="kitphotos__item">
                <img src={p.thumbUrl} alt="" loading="lazy" />
                <button type="button" className="iconbtn iconbtn--ghost" aria-label="Remove photo" onClick={() => void run(() => api.deleteRidePhoto(p.id))}>✕</button>
              </span>
            ))}
            {r.photos.length < 6 && (
              <label className="kitphotos__add">+ Photo
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void run(async () => { const p = await prepareUpload(file); await api.uploadRidePhoto(r.id, p.photo, p.thumb, { w: p.w, h: p.h }); });
                }} />
              </label>
            )}
          </div>
        </div>
      ))}
      {editing === 'new'
        ? <RideForm initial={BLANK_RIDE} onSave={(v) => run(async () => { await api.createRide(v); setEditing(null); })} />
        : <button onClick={() => setEditing('new')}>+ Add a ride</button>}
      {error && <p className="status-line error">{error}</p>}
    </section>
  );
}

function RideForm({ initial, onSave }: { initial: RideInput; onSave: (v: RideInput) => Promise<void> }) {
  const [v, setV] = useState<RideInput>({ kind: initial.kind, make: initial.make, model: initial.model, year: initial.year, nickname: initial.nickname, notes: initial.notes });
  const set = (patch: Partial<RideInput>) => setV((cur) => ({ ...cur, ...patch }));
  return (
    <form className="editor-form" onSubmit={(e) => { e.preventDefault(); void onSave(v); }}>
      <label>Type
        <select value={v.kind} onChange={(e) => set({ kind: e.target.value as RideInput['kind'] })}>
          <option value="car">Car</option>
          <option value="motorbike">Motorbike</option>
        </select>
      </label>
      <label>Make <input value={v.make} maxLength={60} required onChange={(e) => set({ make: e.target.value })} /></label>
      <label>Model <input value={v.model} maxLength={60} required onChange={(e) => set({ model: e.target.value })} /></label>
      <label>Year (optional)
        <input type="number" min={1886} max={new Date().getFullYear() + 1} value={v.year ?? ''} onChange={(e) => set({ year: e.target.value === '' ? null : Number(e.target.value) })} />
      </label>
      <label>Nickname (optional) <input value={v.nickname} maxLength={60} onChange={(e) => set({ nickname: e.target.value })} /></label>
      <label>Notes <textarea value={v.notes} maxLength={2000} rows={3} onChange={(e) => set({ notes: e.target.value })} /></label>
      <button type="submit" className="primary">Save ride</button>
    </form>
  );
}

const BLANK_GEAR: GearInput = { kind: 'camera', brand: '', name: '', notes: '' };

function Garage({ gear, reload }: { gear: Gear[]; reload: () => Promise<unknown> }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await reload(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <section>
      <h2>Gear</h2>
      <p className="hint">Cameras, lenses and anything else you shoot with, up to 100.</p>
      {gear.map((g) => (
        <div key={g.id} className="kititem">
          <div className="feedrow">
            <span className="eventbadge">{g.kind}</span>
            <strong className="grow">{gearTitle(g)}</strong>
            <button onClick={() => setEditing(editing === g.id ? null : g.id)}>{editing === g.id ? 'Close' : 'Edit'}</button>
            <button className="danger" onClick={() => { if (confirm(`Remove ${gearTitle(g)}?`)) void run(() => api.deleteGear(g.id)); }}>Remove</button>
          </div>
          {editing === g.id && <GearForm initial={g} onSave={(v) => run(async () => { await api.updateGear(g.id, v); setEditing(null); })} />}
        </div>
      ))}
      {editing === 'new'
        ? <GearForm initial={BLANK_GEAR} onSave={(v) => run(async () => { await api.createGear(v); setEditing(null); })} />
        : <button onClick={() => setEditing('new')}>+ Add gear</button>}
      {error && <p className="status-line error">{error}</p>}
    </section>
  );
}

/** Free text, with suggestions from the film-era catalog as you type a name; picking one fills the brand and type. */
function GearForm({ initial, onSave }: { initial: GearInput; onSave: (v: GearInput) => Promise<void> }) {
  const [v, setV] = useState<GearInput>({ kind: initial.kind, brand: initial.brand, name: initial.name, notes: initial.notes });
  const [options, setOptions] = useState<CatalogItem[]>([]);
  const set = (patch: Partial<GearInput>) => setV((cur) => ({ ...cur, ...patch }));

  function typeName(name: string) {
    const picked = options.find((o) => o.name === name);
    set(picked ? { name, brand: picked.brand, kind: picked.kind } : { name });
    if (name.trim().length >= 2) api.gearCatalog(name).then(setOptions).catch(() => setOptions([]));
    else setOptions([]);
  }

  return (
    <form className="editor-form" onSubmit={(e) => { e.preventDefault(); void onSave(v); }}>
      <label>Type
        <select value={v.kind} onChange={(e) => set({ kind: e.target.value as GearInput['kind'] })}>
          <option value="camera">Camera</option>
          <option value="lens">Lens</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label>Name
        <input value={v.name} maxLength={100} required list="gear-suggestions" onChange={(e) => typeName(e.target.value)} />
        <datalist id="gear-suggestions">{options.map((o) => <option key={`${o.brand}${o.name}`} value={o.name}>{o.brand}</option>)}</datalist>
      </label>
      <label>Brand <input value={v.brand} maxLength={60} required onChange={(e) => set({ brand: e.target.value })} /></label>
      <label>Notes <textarea value={v.notes} maxLength={500} rows={2} onChange={(e) => set({ notes: e.target.value })} /></label>
      <button type="submit" className="primary">Save gear</button>
    </form>
  );
}
