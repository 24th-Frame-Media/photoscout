import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import type { EventItem, User } from '../api.js';
import { categoriesOf, categoryColour, dayKey, decodeEntities, groupByDay, isOver } from '../events.js';
import { useEvents } from '../useEvents.js';
import EventDetail from '../components/EventDetail.js';

/**
 * The diary view: an agenda of what is coming up, and a month grid for "is this weekend busy".
 * Ported from event-scout's calendar without its week view, past months or subscription feed.
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VIEWS = [{ key: 'agenda', label: '☰ Agenda' }, { key: 'month', label: '▦ Month' }] as const;
type View = (typeof VIEWS)[number]['key'];

const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const timeOf = (ev: EventItem): string =>
  ev.dateOnly ? 'All day' : new Date(ev.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function Calendar({ user }: { user: User | null }) {
  const { events, error, mark, setGoing } = useEvents();
  const [view, setView] = useState<View>('agenda');
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const onMark = user ? mark : undefined;

  const all = events ?? [];
  const shown = useMemo(
    () => all.filter((ev) => !ev.hidden && (!category || ev.category === category) && (!starredOnly || ev.starred)),
    [events, category, starredOnly]
  );
  const categories = useMemo(() => categoriesOf(all.filter((e) => !e.hidden)), [events]);
  const byDay = useMemo(() => groupByDay(shown), [shown]);
  const todayKey = dayKey(new Date());

  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [cursor]);

  // What is not over yet, which keeps today's all-day events on the list for the whole of today rather than dropping them at 1am.
  const agendaDays = useMemo(() => {
    const now = Date.now();
    return [...byDay.keys()].sort()
      .map((key) => ({ key, date: new Date(`${key}T12:00:00`), events: byDay.get(key)!.filter((ev) => !isOver(ev, now)) }))
      .filter((d) => d.events.length > 0);
  }, [byDay]);

  const Row = ({ ev }: { ev: EventItem }) => (
    <button className={`calrow${isOver(ev) ? ' is-past' : ''}`} onClick={() => setOpen(ev.group)}>
      <span className="calrow__time">{timeOf(ev)}</span>
      <span className="calrow__bar" style={{ background: categoryColour(ev.category || 'Event') }} />
      <span className="calrow__body">
        <span className="calrow__title">{ev.starred && '★ '}{decodeEntities(ev.title)}{ev.community && <span className="eventbadge eventbadge--community">Community</span>}</span>
        <span className="hint">📍 {decodeEntities(ev.venueName || ev.address) || 'Location unknown'}</span>
      </span>
    </button>
  );

  const selectedEvents = selected ? byDay.get(selected) ?? [] : [];
  const openEvent = open ? all.find((e) => e.group === open) : undefined;

  return (
    <div className="page">
      <div className="filterbar">
        <div className="chiprow">
          <Link className="chip" to="/events">List</Link>
          <Link className="chip active" to="/calendar">Calendar</Link>
        </div>
        <div className="chiprow">
          {VIEWS.map((v) => (
            <button key={v.key} className={`chip ${view === v.key ? 'active' : ''}`} onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </div>
        {view === 'month' && (
          <>
            <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Previous month">←</button>
            <button onClick={() => setCursor(new Date())}>Today</button>
            <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Next month">→</button>
            <strong>{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
          </>
        )}
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {user && (
          <label className="toggle">
            <input type="checkbox" checked={starredOnly} onChange={(e) => setStarredOnly(e.target.checked)} />
            ★ Shortlist only
          </label>
        )}
      </div>

      {error && <p className="status-line error">{error}</p>}
      {!events && !error && <p className="hint">Loading…</p>}

      {events && view === 'agenda' && (
        <div className="agenda">
          {agendaDays.length === 0 && <div className="empty"><p>Nothing coming up with these filters.</p></div>}
          {agendaDays.map(({ key, date, events: dayEvents }) => (
            <section key={key} className="agenda__day">
              <h3>
                {date.toLocaleDateString(undefined, {
                  weekday: 'long', day: 'numeric', month: 'long',
                  ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
                })}
                {key === todayKey && <span className="eventbadge">Today</span>}
              </h3>
              {dayEvents.map((ev) => <Row key={ev.group} ev={ev} />)}
            </section>
          ))}
        </div>
      )}

      {events && view === 'month' && (
        <>
          <div className="calgrid">
            {DOW.map((d) => <div key={d} className="calgrid__dow">{d}</div>)}
            {monthCells.map((d) => {
              const key = dayKey(d);
              const dayEvents = byDay.get(key) ?? [];
              const classes = ['calcell', d.getMonth() !== cursor.getMonth() ? 'is-outside' : '', key === todayKey ? 'is-today' : '', key === selected ? 'is-selected' : ''].filter(Boolean).join(' ');
              return (
                <div key={key} className={classes} onClick={() => setSelected(key === selected ? null : key)}>
                  <div className="calcell__num">{d.getDate()}</div>
                  {/* Each chip opens its event; the rest of the cell picks the day, which lists all of them below the grid. */}
                  {dayEvents.slice(0, 3).map((ev) => (
                    <button key={ev.group} type="button" className="calcell__ev" title={`${ev.community ? 'Community · ' : ''}${timeOf(ev)} · ${decodeEntities(ev.title)}`}
                      onClick={(e) => { e.stopPropagation(); setOpen(ev.group); }}>
                      <span className="calcell__dot" style={{ background: categoryColour(ev.category || 'Event') }} />
                      {ev.community && '👥 '}{decodeEntities(ev.title)}
                    </button>
                  ))}
                  {dayEvents.length > 3 && <div className="hint">+{dayEvents.length - 3} more</div>}
                </div>
              );
            })}
          </div>
          {selected && (
            <div className="agenda__day">
              <h3>
                {new Date(`${selected}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                {' — '}{selectedEvents.length} event{selectedEvents.length === 1 ? '' : 's'}
              </h3>
              {selectedEvents.map((ev) => <Row key={ev.group} ev={ev} />)}
            </div>
          )}
        </>
      )}

      {openEvent && <EventDetail ev={openEvent} user={user} onClose={() => setOpen(null)} onMark={onMark} onGoing={user ? setGoing : undefined} />}
    </div>
  );
}
