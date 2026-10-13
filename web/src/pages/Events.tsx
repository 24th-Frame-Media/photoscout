import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventItem, type User } from '../api.js';
import {
  applyFilters, type Card, categoriesOf, DATE_CHIPS, decodeEntities, ELSEWHERE, type Filters, foldSeries, type Geo, loadFilters, NEARBY, placeLabel, placesOf, saveFilters, type SortKey, UNKNOWN,
} from '../events.js';
import { useEvents } from '../useEvents.js';
import EventCard from '../components/EventCard.js';
import EventDetail from '../components/EventDetail.js';
import EventAdmin, { HiddenEvents } from '../components/EventAdmin.js';
import { api as adminApi } from '../settings/events/api.js';

/** Only the "By place" sort wants headed sections; any other sort is one run. The sort has already put a venue's events side by side. */
function placeGroups(list: Card[], sort: SortKey): [string, Card[]][] {
  if (sort !== 'place') return [['', list]];
  const out: [string, Card[]][] = [];
  for (const card of list) {
    const place = placeLabel(card.ev);
    const last = out[out.length - 1];
    if (last && last[0] === place) last[1].push(card);
    else out.push([place, [card]]);
  }
  return out;
}

/** Upcoming events from Event Scout, filtered in the browser. Anyone can read; a signed-in user keeps a shortlist and hides events. */
export default function Events({ user }: { user: User | null }) {
  const { events, error, mark, setGoing, reload } = useEvents();
  const admin = user?.role === 'admin';
  const [adminNote, setAdminNote] = useState('');
  const [filters, setFilters] = useState<Filters>(loadFilters);
  useEffect(() => saveFilters(filters), [filters]);
  // Home and the areas events are looked for in, for "Nearby" and "Nearest first". Without them those two just are not offered.
  const [geo, setGeo] = useState<Geo | null>(null);
  useEffect(() => { api.settings().then((s) => setGeo({ home: s.home, areas: s.areas })).catch(() => {}); }, []);
  const [open, setOpen] = useState<string | null>(null);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const onMark = user ? mark : undefined;

  const all = events ?? [];
  const filtered = useMemo(() => applyFilters(all, filters, new Date(), geo), [events, filters, geo]);
  const cards = useMemo(() => foldSeries(filtered), [filtered]);
  const categories = useMemo(() => categoriesOf(all), [events]);
  const { places, nearby, elsewhere, unknown } = useMemo(() => placesOf(all, geo), [events, geo]);
  const folded = filtered.length - cards.length;
  // `?open=<community id>` is how the feed links to an event.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('open');
  const openEvent = open ? all.find((e) => e.group === open) : wanted ? all.find((e) => e.communityId === wanted) : undefined;
  const close = () => { setOpen(null); if (wanted) setParams({}, { replace: true }); };

  // An edit or a merge changes the event's id, so the open card is closed rather than left pointing at nothing.
  const changed = () => { close(); reload(); };
  const archive = () => adminApi.archivePast().then((r) => { setAdminNote(`Archived ${r.archived ?? 0} past events.`); reload(); }).catch((err) => setAdminNote((err as Error).message));

  return (
    <div className="page">
      <div className="filterbar">
        <div className="chiprow">
          <Link className="chip active" to="/events">List</Link>
          <Link className="chip" to="/calendar">Calendar</Link>
        </div>
        <input className="search" placeholder="Search events, venues…" value={filters.search} onChange={(e) => set({ search: e.target.value })} />
        <div className="chiprow">
          {DATE_CHIPS.map((c) => (
            <button key={c.key} className={`chip ${filters.dateChip === c.key ? 'active' : ''}`} onClick={() => set({ dateChip: c.key })}>{c.label}</button>
          ))}
        </div>
        <select value={filters.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {(nearby > 0 || places.length > 0 || elsewhere > 0 || unknown > 0) && (
          <select value={filters.place} title="Filter by town" onChange={(e) => set({ place: e.target.value })}>
            <option value="">Anywhere</option>
            {nearby > 0 && <option value={NEARBY}>Nearby ({nearby})</option>}
            {places.map((p) => <option key={p.name} value={p.name}>{decodeEntities(p.name)} ({p.count})</option>)}
            {elsewhere > 0 && <option value={ELSEWHERE}>Elsewhere ({elsewhere})</option>}
            {unknown > 0 && <option value={UNKNOWN}>Unknown location ({unknown})</option>}
          </select>
        )}
        <select value={filters.sort} title="Sort" onChange={(e) => set({ sort: e.target.value as SortKey })}>
          <option value="date">Soonest first</option>
          <option value="photo">Best for photos</option>
          {(geo || filters.sort === 'distance') && <option value="distance">Nearest first</option>}
          <option value="place">By place</option>
        </select>
        <label className="toggle">
          <input type="checkbox" checked={filters.hideOnline} onChange={(e) => set({ hideOnline: e.target.checked })} />
          Hide online
        </label>
        {user && (
          <label className="toggle">
            <input type="checkbox" checked={filters.starredOnly} onChange={(e) => set({ starredOnly: e.target.checked })} />
            ★ Shortlist only
          </label>
        )}
        {user && <Link className="button" to="/events/new">+ Add an event</Link>}
        {admin && <button title="Move events that have been and gone out of the list" onClick={() => void archive()}>Archive past events</button>}
        <label className="toggle">
          <input type="checkbox" checked={filters.showHidden} onChange={(e) => set({ showHidden: e.target.checked })} />
          Show hidden
        </label>
      </div>

      {error && <p className="status-line error">{error}</p>}
      {adminNote && <p className="hint">{adminNote}</p>}
      {events && (
        <p className="hint">
          {filtered.length} of {all.length} events
          {folded > 0 && ` · ${folded} repeat date${folded === 1 ? '' : 's'} folded into ${folded === 1 ? 'its' : 'their'} series`}
        </p>
      )}

      {!events ? (
        !error && <p className="hint">Loading…</p>
      ) : cards.length === 0 ? (
        <div className="empty">
          <p>{all.length === 0 ? 'No events yet.' : 'Nothing matches these filters.'}</p>
        </div>
      ) : (
        placeGroups(cards, filters.sort).map(([place, list]) => (
          <section key={place} className="placegroup">
            {filters.sort === 'place' && (
              <h2 className="placegroup__head">
                <span className="placegroup__pin">📍</span>
                {decodeEntities(place) || 'Unknown location'}
                <span className="placegroup__count">{list.length}</span>
              </h2>
            )}
            <div className="spotgrid">
              {list.map(({ ev, dates }) => <EventCard key={ev.group} ev={ev} dates={dates} onOpen={(e: EventItem) => setOpen(e.group)} onMark={onMark} />)}
            </div>
          </section>
        ))
      )}

      {admin && <HiddenEvents refreshKey={events?.length ?? 0} onChanged={reload} />}

      {openEvent && <EventDetail ev={openEvent} user={user} onClose={close} onMark={onMark} onGoing={user ? setGoing : undefined}
        adminSlot={admin && !openEvent.community ? <EventAdmin ev={openEvent} others={all} onChanged={changed} /> : undefined} />}
    </div>
  );
}
