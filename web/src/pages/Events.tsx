import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type User } from '../api.js';
import {
  applyFilters, type Card, categoriesOf, DATE_CHIPS, decodeEntities, DEFAULT_FILTERS, ELSEWHERE, type Filters, foldSeries, type Geo, isRecent, loadFilters, NEARBY, openKeyOf, placeLabel, placesOf, saveFilters, type SortKey, sourcesOf, UNKNOWN,
} from '../events.js';
import { haversineKm } from '../map/geo.js';
import { useEvents } from '../useEvents.js';
import EventCard, { EventCardSkeleton } from '../components/EventCard.js';
import EventDetail, { EventDetailSkeleton, EventNotFound } from '../components/EventDetail.js';
import InvitesButton from '../components/InvitesInbox.js';
import EventAdmin, { HiddenEvents } from '../components/EventAdmin.js';
import MultiSelect, { type MultiOption } from '../components/MultiSelect.js';
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

/** The filters that are narrowing the list, named, so an empty page can say what to undo. */
function activeFilters(f: Filters): string[] {
  const out: string[] = [];
  if (f.search.trim()) out.push(`search "${f.search.trim()}"`);
  if (f.dateChip !== 'all') out.push(DATE_CHIPS.find((c) => c.key === f.dateChip)?.label.toLowerCase() ?? f.dateChip);
  if (f.categories.length) out.push(f.categories.length === 1 ? `category ${f.categories[0]}` : `${f.categories.length} categories`);
  if (f.places.length) out.push(f.places.length === 1 ? 'a town' : `${f.places.length} towns`);
  if (f.source) out.push(`source ${f.source}`);
  if (f.recentOnly) out.push('new only');
  if (f.starredOnly) out.push('shortlist only');
  return out;
}

/**
 * Upcoming events from Event Scout and from people here, filtered in the browser. Anyone can read; a signed-in
 * user keeps a shortlist, hides events, says they are going and invites people.
 *
 * Which event is open is in the address (/events/<group> or /events/c/<id>), so it can be linked, Back closes it
 * and a page load straight onto one shows the list with it open. Opening pushes history; closing goes back
 * when this page pushed it, and otherwise swaps the address for /events.
 */
export default function Events({ user }: { user: User | null }) {
  const { events, error, mark, rsvp, find, fetchOne, reload } = useEvents();
  const admin = user?.role === 'admin';
  const [adminNote, setAdminNote] = useState('');
  const [filters, setFilters] = useState<Filters>(loadFilters);
  useEffect(() => saveFilters(filters), [filters]);
  // Home and the areas events are looked for in, for "Nearby" and "Nearest first". Without them those two just are not offered.
  const [geo, setGeo] = useState<Geo | null>(null);
  useEffect(() => { api.settings().then((s) => setGeo({ home: s.home, areas: s.areas })).catch(() => {}); }, []);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const onMark = user ? mark : undefined;
  const onRsvp = user ? rsvp : undefined;

  const all = events ?? [];
  const filtered = useMemo(() => applyFilters(all, filters, new Date(), geo), [events, filters, geo]);
  const cards = useMemo(() => foldSeries(filtered), [filtered]);
  const categories = useMemo(() => categoriesOf(all), [events]);
  const sourceNames = useMemo(() => sourcesOf(all), [events]);
  const recentCount = useMemo(() => all.filter((e) => !e.hidden && isRecent(e)).length, [events]);
  const { places, nearby, elsewhere, unknown } = useMemo(() => placesOf(all, geo), [events, geo]);
  const placeOptions = useMemo<MultiOption[]>(
    () => [
      ...(nearby > 0 ? [{ value: NEARBY, label: 'Nearby', count: nearby }] : []),
      ...places.map((p, i) => ({ value: p.name, label: decodeEntities(p.name), count: p.count, divider: i === 0 && nearby > 0 })),
      ...(elsewhere > 0 ? [{ value: ELSEWHERE, label: 'Elsewhere', count: elsewhere, divider: true }] : []),
      ...(unknown > 0 ? [{ value: UNKNOWN, label: 'Unknown location', count: unknown, divider: elsewhere === 0 && (nearby > 0 || places.length > 0) }] : []),
    ],
    [places, nearby, elsewhere, unknown]
  );
  const categoryOptions = useMemo<MultiOption[]>(() => {
    const counts = new Map<string, number>();
    for (const e of all) if (e.category) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return categories.map((c) => ({ value: c, label: c, count: counts.get(c) ?? 0 }));
  }, [events, categories]);
  const folded = filtered.length - cards.length;

  // --- the open event, from the address ---
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const key = openKeyOf(params);
  const openEvent = key ? find(key.group) : undefined;
  // `?open=<community id>` is how the feed and a convoy link to an event: send it to the event's own address.
  const legacy = search.get('open');
  useEffect(() => {
    if (legacy) navigate(`/events/c/${encodeURIComponent(legacy)}`, { replace: true });
  }, [legacy, navigate]);

  // A link to an event that is not on the list: ask for it by name once the list has had its say.
  const [lookup, setLookup] = useState<{ group: string; state: 'loading' | 'missing' } | null>(null);
  const settled = events !== null || Boolean(error);
  useEffect(() => {
    if (!key || openEvent || !settled) { if (!key) setLookup(null); return; }
    let stop = false;
    setLookup({ group: key.group, state: 'loading' });
    fetchOne(key.group, key.communityId)
      .then(() => { if (!stop) setLookup(null); })
      .catch(() => { if (!stop) setLookup({ group: key.group, state: 'missing' }); });
    return () => { stop = true; };
    // `openEvent` is left out on purpose: it appearing is the answer, not a reason to ask again.
  }, [key?.group, key?.communityId, settled]);

  const close = useCallback(() => {
    // Pushed by a card on this page: Back is exactly "close". Arrived by link or reload: replace the address.
    if ((location.state as { modal?: boolean } | null)?.modal) navigate(-1);
    else navigate('/events', { replace: true });
  }, [location.state, navigate]);
  const returnFocusTo = useCallback((): HTMLElement | null => {
    const group = key?.group;
    return group ? document.querySelector<HTMLElement>(`[data-group="${CSS.escape(group)}"] .evcard__title a`) : null;
  }, [key?.group]);

  const unlocated = key && !openEvent;
  // An edit or a merge changes the event's id, so the open card is closed rather than left pointing at nothing.
  const changed = () => { close(); reload(); };
  const archive = () => adminApi.archivePast().then((r) => { setAdminNote(`Archived ${r.archived ?? 0} past events.`); reload(); }).catch((err) => setAdminNote((err as Error).message));

  const distanceOf = (ev: { lat: number | null; lng: number | null }): number | null =>
    geo && ev.lat != null && ev.lng != null ? haversineKm(geo.home.lat, geo.home.lng, ev.lat, ev.lng) : null;
  const filtersOn = activeFilters(filters);
  const clearFilters = () => setFilters({ ...DEFAULT_FILTERS, showHidden: filters.showHidden });

  return (
    <div className="page events">
      <div className="events__head">
        <h1>Events</h1>
        <div className="events__headactions">
          {user && <InvitesButton onChanged={reload} />}
          {user && <Link className="button primary" to="/events/new">+ Add an event</Link>}
        </div>
      </div>

      <div className="filterbar">
        <div className="chiprow">
          <Link className="chip active" to="/events">List</Link>
          <Link className="chip" to="/calendar">Calendar</Link>
        </div>
        <input className="search" type="search" aria-label="Search events and venues" placeholder="Search events, venues…" value={filters.search} onChange={(e) => set({ search: e.target.value })} />
        <div className="chiprow" role="group" aria-label="When">
          {DATE_CHIPS.map((c) => (
            <button key={c.key} type="button" aria-pressed={filters.dateChip === c.key} className={`chip ${filters.dateChip === c.key ? 'active' : ''}`} onClick={() => set({ dateChip: c.key })}>{c.label}</button>
          ))}
        </div>
        <MultiSelect
          label="Categories"
          allLabel="All categories"
          title="Filter by category"
          options={categoryOptions}
          value={filters.categories}
          onChange={(categories) => set({ categories })}
        />
        {(placeOptions.length > 0 || filters.places.length > 0) && (
          <MultiSelect
            label="Towns"
            allLabel="Anywhere"
            title="Filter by town"
            options={placeOptions}
            value={filters.places}
            onChange={(places) => set({ places })}
          />
        )}
        <select aria-label="Sort" value={filters.sort} title="Sort" onChange={(e) => set({ sort: e.target.value as SortKey })}>
          <option value="date">Soonest first</option>
          <option value="photo">Best for photos</option>
          {(geo || filters.sort === 'distance') && <option value="distance">Nearest first</option>}
          <option value="place">By place</option>
        </select>
        {sourceNames.length > 1 && (
          <select aria-label="Source" value={filters.source} title="Filter by source" onChange={(e) => set({ source: e.target.value })}>
            <option value="">All sources</option>
            {sourceNames.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <label className="toggle" title="Found in the last week">
          <input type="checkbox" checked={filters.recentOnly} onChange={(e) => set({ recentOnly: e.target.checked })} />
          New ({recentCount})
        </label>
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
        {admin && <button type="button" title="Move events that have been and gone out of the list" onClick={() => void archive()}>Archive past events</button>}
        <label className="toggle">
          <input type="checkbox" checked={filters.showHidden} onChange={(e) => set({ showHidden: e.target.checked })} />
          Show hidden
        </label>
      </div>

      {error && <p className="status-line error" role="alert">{error} <button type="button" className="linkbtn" onClick={reload}>Try again</button></p>}
      {adminNote && <p className="hint">{adminNote}</p>}
      {events && (
        <p className="events__count" aria-live="polite">
          {filtered.length} of {all.length} events
          {folded > 0 && ` · ${folded} repeat date${folded === 1 ? '' : 's'} folded into ${folded === 1 ? 'its' : 'their'} series`}
        </p>
      )}

      {!events ? (
        !error && (
          <div className="evgrid" aria-busy="true" aria-label="Loading events">
            {Array.from({ length: 6 }, (_, i) => <EventCardSkeleton key={i} />)}
          </div>
        )
      ) : cards.length === 0 ? (
        <div className="empty events__empty">
          {all.length === 0 ? (
            <>
              <p className="events__empty-title">No events yet</p>
              <p>Events the crawler finds, and ones people here add, show up on this page.</p>
              {user
                ? <p><Link className="button primary" to="/events/new">Add the first one</Link></p>
                : <p><Link to="/login">Sign in</Link> to add one yourself.</p>}
            </>
          ) : (
            <>
              <p className="events__empty-title">Nothing matches</p>
              <p>{filtersOn.length > 0 ? `These are narrowing the list: ${filtersOn.join(', ')}.` : 'Everything left is hidden or online. Try showing hidden events or turning off Hide online.'}</p>
              {filtersOn.length > 0 && <p><button type="button" className="primary" onClick={clearFilters}>Clear filters</button></p>}
            </>
          )}
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
            <div className="evgrid">
              {list.map(({ ev, dates }) => <EventCard key={ev.group} ev={ev} dates={dates} onMark={onMark} onRsvp={onRsvp} distanceKm={distanceOf(ev)} />)}
            </div>
          </section>
        ))
      )}

      {admin && <HiddenEvents refreshKey={events?.length ?? 0} onChanged={reload} />}

      {openEvent && (
        <EventDetail
          ev={openEvent}
          user={user}
          geo={geo}
          onClose={close}
          onMark={onMark}
          onRsvp={onRsvp}
          returnFocusTo={returnFocusTo}
          adminSlot={admin && !openEvent.community ? <EventAdmin ev={openEvent} others={all} onChanged={changed} /> : undefined}
        />
      )}
      {unlocated && (lookup?.state === 'missing' ? <EventNotFound onClose={close} /> : <EventDetailSkeleton onClose={close} />)}
    </div>
  );
}
