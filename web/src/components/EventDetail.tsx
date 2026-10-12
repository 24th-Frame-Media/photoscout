import { useEffect, useState } from 'react';
import type { EventItem } from '../api.js';
import { decodeEntities, formatWhen } from '../events.js';
import { MarkButtons, type OnMark } from './EventCard.js';

/**
 * One event in full, over whatever page opened it, so a listing can be read
 * without leaving the Events page, the calendar or the map. Click outside or Escape closes.
 */
export default function EventDetail({ ev, onClose, onMark }: { ev: EventItem; onClose: () => void; onMark?: OnMark }) {
  const [noImage, setNoImage] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const where = [ev.venueName, ev.address].filter((s, i, all) => s && all.indexOf(s) === i).map(decodeEntities).join(' · ');
  return (
    <div className="eventdetail" onClick={onClose}>
      <div className="eventdetail__panel" role="dialog" aria-label={decodeEntities(ev.title)} onClick={(e) => e.stopPropagation()}>
        <button className="eventdetail__close" aria-label="Close" onClick={onClose}>✕</button>
        {ev.imageUrl && !noImage && <img className="eventdetail__img" src={ev.imageUrl} alt="" onError={() => setNoImage(true)} />}
        <h2>{decodeEntities(ev.title)}</h2>
        <p className="hint">{formatWhen(ev, { full: true })}</p>
        <p className="hint">{ev.isOnline ? '💻 Online' : `📍 ${where || ev.locality || 'Unknown location'}`}{ev.priceText ? ` · ${decodeEntities(ev.priceText)}` : ''}</p>
        {ev.category && <p className="hint">{ev.category}{ev.photoScore >= 40 ? ` · 📷 ${Math.round(ev.photoScore)}` : ''}</p>}
        {ev.description && <p className="eventdetail__text">{decodeEntities(ev.description)}</p>}
        <div className="eventcard__actions">
          {ev.url && <a className="button" href={ev.url} target="_blank" rel="noopener noreferrer">Listing</a>}
          <MarkButtons ev={ev} onMark={onMark} />
        </div>
        {!onMark && <p className="hint">Sign in to keep a shortlist and hide events you don't want.</p>}
      </div>
    </div>
  );
}
