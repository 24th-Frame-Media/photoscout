import { useEffect, useState } from 'react';
import type { EventItem } from '../api.js';
import { api, type AdminEvent, type EventEdit } from '../settings/events/api.js';
import { decodeEntities } from '../events.js';

type Key = 'title' | 'startTime' | 'venueName' | 'address' | 'category' | 'priceText' | 'photoScore' | 'imageUrl' | 'description';
const FIELDS: { key: Key; label: string; type?: 'textarea' | 'datetime-local' | 'number' }[] = [
  { key: 'title', label: 'Title' },
  { key: 'startTime', label: 'Starts', type: 'datetime-local' },
  { key: 'venueName', label: 'Venue' },
  { key: 'address', label: 'Address' },
  { key: 'category', label: 'Category' },
  { key: 'priceText', label: 'Price' },
  { key: 'photoScore', label: 'Photo score (0 to 100)', type: 'number' },
  { key: 'imageUrl', label: 'Image address' },
  { key: 'description', label: 'Description', type: 'textarea' },
];

/** An instant as the local wall time a datetime-local box wants; toISOString would show UTC and a time nobody recognises. */
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function initialFor(ev: AdminEvent, key: Key): string {
  if (key === 'startTime') return toLocalInput(ev.startTime);
  if (key === 'photoScore') return String(Math.round(ev.photoScore));
  return String(ev[key] ?? '');
}

/** Events an admin has hidden from everyone. They are not on the public list, so this is the only way back to one. */
export function HiddenEvents({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [hidden, setHidden] = useState<AdminEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api.events().then((all) => setHidden(all.filter((e) => e.hidden))).catch((err) => setError((err as Error).message));
  }, [refreshKey]);
  if (hidden.length === 0 && !error) return null;
  return (
    <details className="eventadmin">
      <summary>Hidden from everyone ({hidden.length})</summary>
      <ul className="eventadmin__members">
        {hidden.map((e) => (
          <li key={e.group}>
            <span className="grow">{decodeEntities(e.title)} <span className="hint">{new Date(e.startTime).toLocaleDateString()}</span></span>
            <button className="linkbtn" onClick={() => void api.hideEventForAll(e.group, false).then(onChanged).catch((err) => setError((err as Error).message))}>Show again</button>
          </li>
        ))}
      </ul>
      {error && <p className="status-line error">{error}</p>}
    </details>
  );
}

/**
 * Admin tools for one event, shown under it on the Events page.
 *
 * Edit: what is typed wins over the listing, the flyer and the model; clearing a
 * field (Revert) puts back what they said. Merge: fold other listings of the
 * same event into this one, and split them again. Hide: take it off every
 * list for everybody, which is how a single event is retired.
 * Editing or merging changes the event's id, so the caller reloads the list and closes.
 */
export default function EventAdmin({ ev, others, onChanged }: { ev: EventItem; others: EventItem[]; onChanged: () => void }) {
  const [full, setFull] = useState<AdminEvent | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [merging, setMerging] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.event(ev.group)
      .then((e) => { setFull(e); setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, initialFor(e, f.key)]))); })
      .catch((err) => setError((err as Error).message));
  }, [ev.group]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await fn(); onChanged(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!full) return <div className="eventadmin"><h3>Admin</h3>{error ? <p className="status-line error">{error}</p> : <p className="hint">Loading…</p>}</div>;

  const edited = new Set(full.edited);
  const dirty = FIELDS.some((f) => draft[f.key] !== initialFor(full, f.key));
  const save = () => run(() => {
    // Only what changed, so an untouched field never becomes an override pinned to what it happened to show.
    const patch: EventEdit = {};
    for (const f of FIELDS) {
      const now = draft[f.key];
      if (now === initialFor(full, f.key)) continue;
      if (f.key === 'photoScore') patch.photoScore = now === '' ? null : Number(now);
      else if (f.key === 'startTime') patch.startTime = now ? new Date(now).toISOString() : null;
      else patch[f.key] = now;
    }
    return api.editEvent(full.group, patch);
  });

  const needle = search.trim().toLowerCase();
  const candidates = others.filter((o) => o.group !== ev.group && (!needle || `${o.title} ${o.venueName}`.toLowerCase().includes(needle))).slice(0, 40);

  return (
    <div className="eventadmin">
      <h3>Admin: edit</h3>
      {FIELDS.map((f) => (
        <label key={f.key}>
          <span>
            {f.label}{' '}
            {edited.has(f.key) && <button type="button" className="linkbtn" disabled={busy} onClick={() => void run(() => api.editEvent(full.group, { [f.key]: null }))}>revert</button>}
          </span>
          {f.type === 'textarea'
            ? <textarea rows={4} value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
            : <input type={f.type ?? 'text'} min={f.type === 'number' ? 0 : undefined} max={f.type === 'number' ? 100 : undefined}
                value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />}
        </label>
      ))}
      <div className="eventcard__actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>Save changes</button>
        <button disabled={busy} title="Take this event off every list, for everybody" onClick={() => void run(() => api.hideEventForAll(full.group, !full.hidden))}>
          {full.hidden ? 'Show to everyone again' : 'Hide from everyone'}
        </button>
      </div>

      <h3>Admin: listings behind it</h3>
      <ul className="eventadmin__members">
        {full.members.map((m) => (
          <li key={m.id}>
            <span className="eventbadge">{m.source}</span>
            <span className="grow">{decodeEntities(m.title)}{m.parent && <span className="hint"> · main</span>}</span>
            {full.members.length > 1 && !m.parent && <button className="linkbtn" disabled={busy} onClick={() => void run(() => api.setEventParent(full.group, m.id))}>make main</button>}
          </li>
        ))}
      </ul>
      <div className="eventcard__actions">
        <button disabled={busy} onClick={() => setMerging(!merging)}>{merging ? 'Cancel merge' : 'Merge with others…'}</button>
        {(full.manual || full.mergedBy) && <button disabled={busy} onClick={() => void run(() => api.unmergeEvent(full.group))}>Split apart</button>}
      </div>
      {merging && (
        <>
          <input className="search" placeholder="Find the other listings…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="eventadmin__pick">
            {candidates.map((o) => (
              <label key={o.group}>
                <input type="checkbox" checked={picked.has(o.group)} onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(o.group); else next.delete(o.group);
                  setPicked(next);
                }} />
                <span>{decodeEntities(o.title)} <span className="hint">{new Date(o.startTime).toLocaleDateString()}</span></span>
              </label>
            ))}
            {candidates.length === 0 && <p className="hint">Nothing matches.</p>}
          </div>
          <button className="primary" disabled={busy || picked.size === 0} onClick={() => void run(() => api.mergeEvents([full.group, ...picked], full.group))}>
            Merge {picked.size + 1} events into this one
          </button>
        </>
      )}
      {error && <p className="status-line error">{error}</p>}
    </div>
  );
}
