import { useMemo, useState } from 'react';
import type { User } from '../api.js';
import { applyFilters, categoriesOf, DATE_CHIPS, DEFAULT_FILTERS, type Filters, foldSeries } from '../events.js';
import { useEvents } from '../useEvents.js';
import EventCard from '../components/EventCard.js';
import EventDetail from '../components/EventDetail.js';

/** Upcoming events from Event Scout, filtered in the browser. Anyone can read; a signed-in user keeps a shortlist and hides events. */
export default function Events({ user }: { user: User | null }) {
  const { events, error, mark } = useEvents();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const onMark = user ? mark : undefined;

  const all = events ?? [];
  const filtered = useMemo(() => applyFilters(all, filters), [events, filters]);
  const cards = useMemo(() => foldSeries(filtered), [filtered]);
  const categories = useMemo(() => categoriesOf(all), [events]);
  const folded = filtered.length - cards.length;
  const openEvent = open ? all.find((e) => e.group === open) : undefined;

  return (
    <div className="page">
      <div className="filterbar">
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
        {user && (
          <label className="toggle">
            <input type="checkbox" checked={filters.starredOnly} onChange={(e) => set({ starredOnly: e.target.checked })} />
            ★ Shortlist only
          </label>
        )}
        <label className="toggle">
          <input type="checkbox" checked={filters.showHidden} onChange={(e) => set({ showHidden: e.target.checked })} />
          Show hidden
        </label>
      </div>

      {error && <p className="status-line error">{error}</p>}
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
        <div className="spotgrid">
          {cards.map(({ ev, dates }) => <EventCard key={ev.group} ev={ev} dates={dates} onOpen={(e) => setOpen(e.group)} onMark={onMark} />)}
        </div>
      )}

      {openEvent && <EventDetail ev={openEvent} onClose={() => setOpen(null)} onMark={onMark} />}
    </div>
  );
}
