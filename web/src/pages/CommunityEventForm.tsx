import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Map as MlMap, Marker } from 'maplibre-gl';
import { api, type CommunityEventInput, type User } from '../api.js';
import { STYLE_URL } from '../map/layers.js';
import { fromLocalInput, toLocalInput } from '../kit.js';

/**
 * Make or edit a community event. The place is chosen by clicking the map or by
 * typing coordinates; nothing here looks an address up for the visitor.
 */
export default function CommunityEventForm({ user }: { user: User | null }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: '', description: '', start: '', end: '', venueName: '', address: '', priceText: '', lat: '', lng: '', visibility: 'public' as CommunityEventInput['visibility'] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!id) return;
    api.communityEvent(id).then((c) => setForm({
      title: c.title, description: c.description, start: toLocalInput(c.startTime), end: c.endTime ? toLocalInput(c.endTime) : '',
      venueName: c.venueName, address: c.address, priceText: c.priceText, lat: String(c.lat), lng: String(c.lng), visibility: c.visibility,
    })).catch((err) => setError((err as Error).message));
  }, [id]);

  if (!user) return <div className="page"><p className="hint">Sign in to add an event.</p></div>;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const startTime = fromLocalInput(form.start);
    const lat = form.lat.trim() === '' ? NaN : Number(form.lat);
    const lng = form.lng.trim() === '' ? NaN : Number(form.lng);
    if (!startTime) return setError('Choose when it starts');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return setError('Click the map or type a latitude and longitude');
    const body: CommunityEventInput = {
      title: form.title, description: form.description, startTime, endTime: fromLocalInput(form.end),
      venueName: form.venueName, address: form.address, lat, lng, priceText: form.priceText, visibility: form.visibility,
    };
    setBusy(true);
    try {
      if (id) await api.updateCommunityEvent(id, body);
      else await api.createCommunityEvent(body);
      navigate('/events');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function remove() {
    if (!id || !confirm('Delete this event?')) return;
    try { await api.deleteCommunityEvent(id); navigate('/events'); } catch (err) { setError((err as Error).message); }
  }

  const lat = Number(form.lat), lng = Number(form.lng);
  const hasPoint = form.lat.trim() !== '' && form.lng.trim() !== '' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return (
    <div className="page settings">
      <h1>{id ? 'Edit event' : 'Add an event'}</h1>
      <p className="hint">Shown as a Community event next to the ones we find. Up to 20 upcoming events each.</p>
      <form className="editor-form" onSubmit={save}>
        <label>Title <input value={form.title} maxLength={150} required onChange={(e) => set({ title: e.target.value })} /></label>
        <label>Description <textarea value={form.description} maxLength={4000} rows={5} onChange={(e) => set({ description: e.target.value })} /></label>
        <label>Starts <input type="datetime-local" value={form.start} required onChange={(e) => set({ start: e.target.value })} /></label>
        <label>Ends (optional, within 14 days of the start) <input type="datetime-local" value={form.end} onChange={(e) => set({ end: e.target.value })} /></label>
        <label>Venue <input value={form.venueName} maxLength={150} onChange={(e) => set({ venueName: e.target.value })} /></label>
        <label>Address <input value={form.address} maxLength={300} onChange={(e) => set({ address: e.target.value })} /></label>
        <label>Price (optional) <input value={form.priceText} maxLength={60} placeholder="Free, $10 entry…" onChange={(e) => set({ priceText: e.target.value })} /></label>
        <label>Who can find it
          <select value={form.visibility} onChange={(e) => set({ visibility: e.target.value as CommunityEventInput['visibility'] })}>
            <option value="public">Public: in the Events list, calendar and map</option>
            <option value="unlisted">Unlisted: only people with the link</option>
          </select>
        </label>
        <p className="hint">Location: click the map, or type the coordinates.</p>
        <LocationPicker point={hasPoint ? [lat, lng] : null} onPick={(la, ln) => set({ lat: la.toFixed(6), lng: ln.toFixed(6) })} />
        <div className="formrow">
          <label>Latitude</label><input inputMode="decimal" value={form.lat} onChange={(e) => set({ lat: e.target.value })} />
          <label>Longitude</label><input inputMode="decimal" value={form.lng} onChange={(e) => set({ lng: e.target.value })} />
        </div>
        <div className="eventcard__actions">
          <button type="submit" className="primary" disabled={busy}>{id ? 'Save changes' : 'Add event'}</button>
          {id && <button type="button" onClick={() => void remove()}>Delete</button>}
          <button type="button" onClick={() => navigate(-1)}>Cancel</button>
        </div>
        {error && <p className="status-line error">{error}</p>}
      </form>
    </div>
  );
}

/** A small map on the same base style as the main one: click to drop the pin, or move it by typing. */
function LocationPicker({ point, onPick }: { point: [number, number] | null; onPick: (lat: number, lng: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const start = useRef(point);

  useEffect(() => {
    const m = new MlMap({ container: container.current!, style: STYLE_URL, center: start.current ? [start.current[1], start.current[0]] : [149.577, -33.419], zoom: start.current ? 12 : 8 });
    map.current = m;
    m.on('click', (e) => pick.current(e.lngLat.lat, e.lngLat.lng));
    // With no pin yet, open where the instance says its home is.
    if (!start.current) api.settings().then((s) => { if (!marker.current) m.jumpTo({ center: [s.home.lng, s.home.lat], zoom: 9 }); }).catch(() => {});
    return () => { m.remove(); map.current = null; marker.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!point) { marker.current?.remove(); marker.current = null; return; }
    const lngLat: [number, number] = [point[1], point[0]];
    if (!marker.current) marker.current = new Marker().setLngLat(lngLat).addTo(m);
    else marker.current.setLngLat(lngLat);
    if (!m.getBounds().contains(lngLat)) m.easeTo({ center: lngLat });
  }, [point?.[0], point?.[1]]);

  return <div ref={container} className="locpicker" aria-label="Map: click to set the event location" />;
}
