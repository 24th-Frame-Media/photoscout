import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type Cruise, type EventItem, type User } from '../api.js';
import { decodeEntities, formatWhen } from '../events.js';
import { MarkButtons, type OnMark } from './EventCard.js';
import CruiseMap from './CruiseMap.js';
import ReportButton from './ReportButton.js';

/** Say you are going to a community event, or that you are not; absent for a visitor. */
export type OnGoing = (communityId: string, going: boolean) => Promise<void>;

/**
 * One event in full, over whatever page opened it, so a listing can be read
 * without leaving the Events page, the calendar or the map. Click outside or Escape closes.
 * A community event adds who is running it, who is going, and Going and Edit buttons.
 */
export default function EventDetail({ ev, onClose, onMark, onGoing, user, adminSlot }: { ev: EventItem; onClose: () => void; onMark?: OnMark; onGoing?: OnGoing; user?: User | null; adminSlot?: ReactNode }) {
  const [noImage, setNoImage] = useState(false);
  const [note, setNote] = useState('');
  // A list of events carries a cruise without its line; the one event has it.
  const [cruise, setCruise] = useState<Cruise | null>(null);
  useEffect(() => {
    setCruise(null);
    if (!ev.cruise || !ev.communityId) return;
    let stop = false;
    api.communityEvent(ev.communityId).then((c) => { if (!stop) setCruise(c.cruise); }).catch(() => {});
    return () => { stop = true; };
  }, [ev.communityId, ev.cruise?.rollOut]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const where = [ev.venueName, ev.address].filter((s, i, all) => s && all.indexOf(s) === i).map(decodeEntities).join(' · ');
  const canEdit = ev.community && user && (user.id === ev.ownerId || user.role === 'admin');
  const isOrganiser = Boolean(ev.community && user && user.id === ev.ownerId);
  const toggleGoing =() => { setNote(''); onGoing!(ev.communityId!, !ev.isGoing).catch((err) => setNote((err as Error).message)); };
  return (
    <div className="eventdetail" onClick={onClose}>
      <div className="eventdetail__panel" role="dialog" aria-label={decodeEntities(ev.title)} onClick={(e) => e.stopPropagation()}>
        <button className="eventdetail__close" aria-label="Close" onClick={onClose}>✕</button>
        {ev.imageUrl && !noImage && <img className="eventdetail__img" src={ev.imageUrl} alt="" onError={() => setNoImage(true)} />}
        <h2>{decodeEntities(ev.title)}</h2>
        {ev.community && (
          <p className="hint">
            <span className="eventbadge eventbadge--community">Community</span>
            {ev.organiser && <> Organised by <Link to={`/u/${encodeURIComponent(ev.organiser)}`}>{ev.organiser}</Link></>}
          </p>
        )}
        <p className="hint">{formatWhen(ev, { full: true })}</p>
        <p className="hint">{ev.isOnline ? '💻 Online' : `📍 ${where || ev.locality || 'Unknown location'}`}{ev.priceText ? ` · ${decodeEntities(ev.priceText)}` : ''}</p>
        {ev.category && !ev.community && <p className="hint">{ev.category}{ev.photoScore >= 40 ? ` · 📷 ${Math.round(ev.photoScore)}` : ''}</p>}
        {ev.description && <p className="eventdetail__text">{decodeEntities(ev.description)}</p>}
        {ev.cruise && (
          <div className="cruise">
            <h3>Cruise: {ev.cruise.route.name}</h3>
            <p className="hint">
              Meet {ev.cruise.meet.note ? `at ${ev.cruise.meet.note}` : 'at the marked spot'} · rolls out {new Date(ev.cruise.rollOut).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
            </p>
            {cruise?.route.vertices
              ? <CruiseMap line={cruise.route.vertices} type={cruise.route.type} meet={cruise.meet} fitKey={ev.communityId} />
              : <p className="hint">Loading the route…</p>}
          </div>
        )}
        <div className="eventcard__actions">
          {ev.url && <a className="button" href={ev.url} target="_blank" rel="noopener noreferrer">Listing</a>}
          {ev.community && (
            <>
              <span className="hint">{ev.going ?? 0} going</span>
              {onGoing && <button className={ev.isGoing ? 'primary' : ''} onClick={toggleGoing}>{ev.isGoing ? '✓ Going' : 'Going'}</button>}
              {user && ev.cruise && (isOrganiser || ev.isGoing) && (
                <Link className="button primary" to={`/convoy?cruise=${encodeURIComponent(ev.communityId!)}`}>{isOrganiser ? 'Start convoy' : 'Join convoy'}</Link>
              )}
              {canEdit && <Link className="button" to={`/events/${ev.communityId}/edit`}>Edit</Link>}
              {user && user.id !== ev.ownerId && <ReportButton user={user} kind="community_event" id={ev.communityId!} />}
            </>
          )}
          <MarkButtons ev={ev} onMark={onMark} />
        </div>
        {note && <p className="status-line error">{note}</p>}
        {user && ev.cruise && !isOrganiser && !ev.isGoing && <p className="hint">Say you are going to join the convoy.</p>}
        {ev.community ? !onGoing && <p className="hint">Sign in to say you are going.</p>
          : !onMark && <p className="hint">Sign in to keep a shortlist and hide events you don't want.</p>}
        {adminSlot}
      </div>
    </div>
  );
}
