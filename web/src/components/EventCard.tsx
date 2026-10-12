import { useState } from 'react';
import type { EventItem, EventState } from '../api.js';
import { decodeEntities, formatWhen, isMultiDay, multiDaySpan } from '../events.js';

/** What a card or the detail view does to star or hide an event; absent for a visitor, who has no shortlist. */
export type OnMark = (group: string, patch: Partial<EventState>) => Promise<void>;

/** Star and hide for one event, with the server's reason when it refuses. Nothing at all for a visitor. */
export function MarkButtons({ ev, onMark }: { ev: EventItem; onMark?: OnMark }) {
  const [note, setNote] = useState('');
  // Starring and hiding are for the scraped feed; a community event is not on it.
  if (!onMark || ev.community) return null;
  const mark = (patch: Partial<EventState>) => { setNote(''); onMark(ev.group, patch).catch((err) => setNote((err as Error).message)); };
  return (
    <>
      <button className={ev.starred ? 'primary' : ''} title={ev.starred ? 'Remove from your shortlist' : 'Add to your shortlist'} onClick={() => mark({ starred: !ev.starred })}>
        {ev.starred ? '★ Shortlisted' : '☆ Shortlist'}
      </button>
      <button title={ev.hidden ? 'Show this event again' : 'Hide this event from your lists and the map'} onClick={() => mark({ hidden: !ev.hidden })}>
        {ev.hidden ? 'Restore' : 'Hide'}
      </button>
      {note && <span className="status-line error">{note}</span>}
    </>
  );
}

/** One event as a card. `dates` is every date of its series on the page, `ev` first. */
export default function EventCard({ ev, dates, onOpen, onMark }: { ev: EventItem; dates: EventItem[]; onOpen: (ev: EventItem) => void; onMark?: OnMark }) {
  const [noImage, setNoImage] = useState(false);
  const place = decodeEntities(ev.venueName || ev.address || ev.locality).trim();
  return (
    <article className={`spotcard eventcard${ev.hidden ? ' is-hidden' : ''}`}>
      {ev.imageUrl && !noImage && <img className="eventcard__img" src={ev.imageUrl} alt="" loading="lazy" onError={() => setNoImage(true)} />}
      <h3><button className="linklike" onClick={() => onOpen(ev)}>{decodeEntities(ev.title)}</button></h3>
      <p className="hint">{formatWhen(ev)}</p>
      <p className="hint">{ev.isOnline ? '💻 Online' : `📍 ${place || 'Unknown location'}`}{ev.priceText ? ` · ${decodeEntities(ev.priceText)}` : ''}{ev.community ? ` · ${ev.going ?? 0} going` : ''}</p>
      <div className="eventcard__badges">
        {ev.community && <span className="eventbadge eventbadge--community">Community</span>}
        {ev.category && !ev.community && <span className="eventbadge">{ev.category}</span>}
        {isMultiDay(ev) && <span className="eventbadge">📅 {multiDaySpan(ev)} days</span>}
        {dates.length > 1 && (
          <span className="eventbadge" title={`Also on ${dates.slice(1, 8).map((d) => new Date(d.startTime).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })).join(', ')}${dates.length > 8 ? ' and more' : ''}`}>
            ↻ {dates.length} dates
          </span>
        )}
      </div>
      <div className="eventcard__actions">
        <button onClick={() => onOpen(ev)}>Details</button>
        <MarkButtons ev={ev} onMark={onMark} />
      </div>
    </article>
  );
}
