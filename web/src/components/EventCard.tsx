import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EventItem, EventState } from '../api.js';
import { dateBadge, decodeEntities, eventPath, formatWhen, hostOf, isMultiDay, isRecent, multiDaySpan, mergedTitle, timingOf, whenFixTitle } from '../events.js';
import type { OnRsvp } from '../useEvents.js';
import EventImage from './EventImage.js';
import { RsvpButtons } from './Rsvp.js';

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
      <button type="button" className={ev.starred ? 'primary' : ''} aria-pressed={ev.starred} title={ev.starred ? 'Remove from your shortlist' : 'Add to your shortlist'} onClick={() => mark({ starred: !ev.starred })}>
        {ev.starred ? '★ Shortlisted' : '☆ Shortlist'}
      </button>
      <button type="button" title={ev.hidden ? 'Show this event again' : 'Hide this event from your lists and the map'} onClick={() => mark({ hidden: !ev.hidden })}>
        {ev.hidden ? 'Restore' : 'Hide'}
      </button>
      {note && <span className="status-line error" role="alert">{note}</span>}
    </>
  );
}

/**
 * Which sites the listing came from, as badges. The names are the engine's own ("facebook", "crawler"):
 * a crawler find says whose page it was read off, which is the part worth knowing before trusting it.
 */
const SOURCE_LABELS: Record<string, string> = { facebook: 'facebook*', websearch: 'web*', crawler: 'crawler', manual: 'added by hand' };

function sourceTitle(source: string, url: string): string | undefined {
  const host = hostOf(url);
  return source === 'crawler' ? (host ? `Found by the crawler on ${host}` : 'Found by the crawler') : undefined;
}

/** "Also on Tue 15 Sept, Fri 18 Sept … and 12 more", for the series badge. */
function seriesTitle(dates: EventItem[]): string {
  const shown = 8;
  const days = dates.slice(1, shown + 1).map((d) => new Date(d.startTime).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
  const more = dates.length - 1 - days.length;
  return `Also on ${days.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * One event as a card, in event-scout's layout: picture with the date over it, then the title, when, where,
 * badges and actions. The title and picture are links to the event's own page, which opens the large view,
 * so middle-click and "copy link" work. `dates` is every date of its series on the page, `ev` first.
 */
export default function EventCard({ ev, dates, onMark, onRsvp, distanceKm }: {
  ev: EventItem; dates: EventItem[]; onMark?: OnMark; onRsvp?: OnRsvp; distanceKm?: number | null;
}) {
  const [noImage, setNoImage] = useState(false);
  const title = decodeEntities(ev.title);
  const to = eventPath(ev);
  const badge = dateBadge(ev);
  const multiDay = isMultiDay(ev);
  const timing = timingOf(ev);
  // The venue is the useful half; the street address is supporting detail, and repeating the venue inside it makes the line long.
  const place = decodeEntities(ev.venueName || ev.address || '').trim();
  const rawAddress = decodeEntities(ev.address || '').trim();
  const suburb = ev.venueName && rawAddress && rawAddress !== place ? rawAddress : '';
  const hasImage = Boolean(ev.imageUrl) && !noImage;
  const going = ev.going ?? 0;

  return (
    <article className={`evcard${ev.hidden ? ' is-hidden' : ''}${timing.kind === 'ended' ? ' is-ended' : ''}`} data-group={ev.group}>
      <div className="evcard__thumb">
        {hasImage
          ? <EventImage images={[ev.imageUrl]} onNone={() => setNoImage(true)} />
          : <span className="evcard__noimg" aria-hidden="true">{ev.isOnline ? '💻' : '📷'}</span>}
        <Link className="evcard__open" to={to} state={{ modal: true }} aria-hidden="true" tabIndex={-1} />
        <div className="evcard__date" title={multiDay ? `Multi-day event: ${formatWhen(ev, { full: true })}` : undefined}>
          <div className={`evcard__mon${badge.monRange ? ' is-range' : ''}`}>{badge.mon}</div>
          <div className={`evcard__day${badge.range ? ' is-range' : ''}`}>{badge.day}</div>
        </div>
        {ev.photoScore >= 40 && <div className="evcard__score" title="Photo score">📷 {Math.round(ev.photoScore)}</div>}
        {ev.starred && <div className="evcard__star" title="On your shortlist" aria-label="On your shortlist">★</div>}
      </div>
      <div className="evcard__body">
        <h3 className="evcard__title"><Link to={to} state={{ modal: true }}>{title}</Link></h3>
        <div className="evcard__when">
          <span>{formatWhen(ev)}</span>
          {ev.originalStart && <span className="evbadge evbadge--fixed" title={whenFixTitle(ev)}>time corrected</span>}
          {timing.text && <span className={`evcard__timing evcard__timing--${timing.kind}`}>{timing.text}</span>}
        </div>

        {/* Where it is, on its own line and not in muted small print: on a scouting list this matters as much as the time. */}
        <div className={`evcard__where${place ? '' : ' is-unknown'}`}>
          <span className="evcard__pin" aria-hidden="true">{ev.isOnline ? '💻' : '📍'}</span>
          <span className="evcard__place">{place || (ev.isOnline ? 'Online event' : ev.locality || 'Unknown location')}</span>
          {distanceKm != null && <span className="evcard__dist">{distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm)} km</span>}
        </div>
        {suburb && <div className="evcard__addr">{suburb}</div>}
        {ev.priceText && <div className="evcard__price">{decodeEntities(ev.priceText)}</div>}

        <div className="evcard__badges">
          {ev.community && <span className="evbadge evbadge--community">Community</span>}
          {ev.category && !ev.community && <span className="evbadge evbadge--cat">{ev.category}</span>}
          {ev.cruise && <span className="evbadge" title="A route to drive together">🚗 Cruise</span>}
          {multiDay && <span className="evbadge evbadge--multiday" title={`Runs across ${multiDaySpan(ev)} days`}>📅 {multiDaySpan(ev)} days</span>}
          {dates.length > 1 && <span className="evbadge evbadge--series" title={seriesTitle(dates)}>↻ {dates.length} dates</span>}
          {isRecent(ev) && <span className="evbadge evbadge--new" title="First found in the last week">✦ New</span>}
          {ev.mergedBy === 'model' && <span className="evbadge evbadge--merged" title={mergedTitle(ev)}>merged by model</span>}
          {ev.soldOut && <span className="evbadge evbadge--soldout" title="The listing says it is sold out">Sold out</span>}
          {ev.sources.map((source) => (
            <span key={source} className={`evbadge evbadge--src src-${source}`} title={sourceTitle(source, ev.url)}>{SOURCE_LABELS[source] ?? source}</span>
          ))}
        </div>

        {(onRsvp || going > 0 || (ev.interested ?? 0) > 0) && <RsvpButtons ev={ev} onRsvp={onRsvp} compact />}

        <div className="evcard__actions">
          <Link className="button" to={to} state={{ modal: true }} aria-label={`Details: ${title}`}>Details</Link>
          <MarkButtons ev={ev} onMark={onMark} />
        </div>
      </div>
    </article>
  );
}

/** A card-shaped placeholder while the list loads. */
export function EventCardSkeleton() {
  return (
    <div className="evcard evcard--skeleton" aria-hidden="true">
      <div className="evcard__thumb skel" />
      <div className="evcard__body">
        <div className="skel skel--line skel--w80" />
        <div className="skel skel--line skel--w50" />
        <div className="skel skel--line skel--w65" />
        <div className="skel skel--line skel--w30" />
      </div>
    </div>
  );
}
