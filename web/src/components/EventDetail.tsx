import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type Cruise, type EventItem, type User } from '../api.js';
import { decodeEntities, findLinks, findSocials, formatWhen, hostOf, localZone, mapLink, mergedTitle, safeHref, timingOf, whenFixTitle, type Geo } from '../events.js';
import { haversineKm } from '../map/geo.js';
import type { OnRsvp } from '../useEvents.js';
import { MarkButtons, type OnMark } from './EventCard.js';
import CruiseMap from './CruiseMap.js';
import EventImage from './EventImage.js';
import InvitePanel from './InvitePanel.js';
import Modal from './Modal.js';
import ReportButton from './ReportButton.js';
import { RsvpSection } from './Rsvp.js';

/**
 * One event in full, in a large dialog over whatever page opened it: a centred panel on a desktop, the whole
 * screen on a phone. The flyer is shown whole beside the details, not cropped, since a poster cropped to a
 * letterbox loses its date and half its title.
 *
 * The Events page puts the event in the address bar (/events/<group>, /events/c/<id>) so it can be linked and
 * Back closes it; the calendar and the map just show it. A community event adds who is running it, a cruise,
 * and Edit. RSVP and Invite are here for every event.
 */
export default function EventDetail({ ev, onClose, onMark, onRsvp, user, adminSlot, onUseOriginalTime, geo, returnFocusTo }: {
  ev: EventItem; onClose: () => void; onMark?: OnMark; onRsvp?: OnRsvp; user?: User | null; adminSlot?: ReactNode;
  /** Admins only: put the source's own time back, as a hand edit, so a model's correction stops applying. */
  onUseOriginalTime?: () => void;
  /** Where "home" is, for "3.2 km from home"; left out where the page has not read the settings. */
  geo?: Geo | null;
  returnFocusTo?: () => HTMLElement | null;
}) {
  const [inviting, setInviting] = useState(false);
  // The admin edit form stays hidden until an admin asks for it.
  const [showEdit, setShowEdit] = useState(false);
  // A list of events carries a cruise without its line; the one event has it.
  const [cruise, setCruise] = useState<Cruise | null>(null);
  useEffect(() => {
    setCruise(null);
    if (!ev.cruise || !ev.communityId) return;
    let stop = false;
    api.communityEvent(ev.communityId).then((c) => { if (!stop) setCruise(c.cruise); }).catch(() => {});
    return () => { stop = true; };
  }, [ev.communityId, ev.cruise?.rollOut]);
  // A different event reusing this instance starts with the invite panel shut.
  useEffect(() => setInviting(false), [ev.group]);

  const title = decodeEntities(ev.title);
  const timing = timingOf(ev);
  const zone = localZone();
  const description = decodeEntities(ev.description ?? '').trim();
  const venue = decodeEntities(ev.venueName).trim();
  const address = decodeEntities(ev.address).trim();
  const where = [venue, address].filter((s, i, all) => s && all.indexOf(s) === i).join(' · ');
  const map = ev.isOnline ? null : mapLink({ ...ev, venueName: venue, address });
  const distance = geo && ev.lat != null && ev.lng != null ? haversineKm(geo.home.lat, geo.home.lng, ev.lat, ev.lng) : null;
  const socials = findSocials(ev);
  const links = findLinks(ev);
  const listing = safeHref(ev.url);
  const canEdit = ev.community && user && (user.id === ev.ownerId || user.role === 'admin');
  const isOrganiser = Boolean(ev.community && user && user.id === ev.ownerId);
  const going = ev.myRsvp === 'going' || Boolean(ev.community && ev.isGoing);
  const hasImage = Boolean(ev.imageUrl);

  return (
    <Modal label={title} onClose={onClose} returnFocusTo={returnFocusTo} className="evd">
      <div className={`evd__grid${hasImage ? '' : ' evd__grid--plain'}`}>
        {hasImage && (
          <div className="evd__media">
            <a className="evd__flyer" href={safeHref(ev.imageUrl) ?? ev.imageUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open the flyer for ${title} full size`}>
              <EventImage images={[ev.imageUrl]} alt={`Flyer for ${title}`} eager />
            </a>
          </div>
        )}

        <div className="evd__main">
          <div className="evd__chips">
            {timing.text && <span className={`evd__timing evd__timing--${timing.kind}`}>{timing.text}</span>}
            {ev.community && <span className="evbadge evbadge--community">Community</span>}
            {ev.category && !ev.community && <span className="evbadge evbadge--cat">{ev.category}</span>}
            {ev.isOnline && <span className="evbadge">💻 Online</span>}
            {ev.priceText && <span className="evbadge">{decodeEntities(ev.priceText)}</span>}
            {ev.photoScore >= 40 && <span className="evbadge" title="Photo score">📷 {Math.round(ev.photoScore)}</span>}
            {ev.soldOut && <span className="evbadge evbadge--soldout" title="The listing says it is sold out">Sold out</span>}
          </div>
          <h2 className="evd__title">{title}</h2>
          {ev.community && ev.organiser && (
            <p className="hint">Organised by <Link to={`/u/${encodeURIComponent(ev.organiser)}`}>{ev.organiser}</Link></p>
          )}

          {ev.mergedBy === 'model' && (
            <p className="hint evd__merged">
              <span className="evbadge evbadge--merged" title={mergedTitle(ev)}>merged by model</span>{' '}
              {ev.mergedReason}
            </p>
          )}

          <section className="evd__block" aria-label="When">
            <h3 className="evd__label">When</h3>
            <p className="evd__when">{formatWhen(ev, { full: true })}</p>
            {zone && !ev.dateOnly && <p className="hint">In your local time ({zone.replace(/_/g, ' ')})</p>}
            {ev.originalStart && (
              <p className="hint evd__fixed">
                <span className="evbadge evbadge--fixed" title={whenFixTitle(ev)}>time corrected</span>{' '}
                {whenFixTitle(ev)}
                {onUseOriginalTime && <>{' '}<button type="button" className="linkbtn" onClick={onUseOriginalTime}>Use original time</button></>}
              </p>
            )}
          </section>

          <section className="evd__block" aria-label="Where">
            <h3 className="evd__label">Where</h3>
            <p className="evd__where">
              {ev.isOnline ? '💻 Online event' : where || ev.locality || 'Location not listed'}
              {distance != null && <span className="hint"> · {distance < 10 ? distance.toFixed(1) : Math.round(distance)} km from home</span>}
            </p>
            {map && (map.internal
              ? <Link className="evd__link" to={map.href}>{map.label} →</Link>
              : <a className="evd__link" href={map.href} target="_blank" rel="noopener noreferrer">{map.label} ↗</a>)}
          </section>

          <RsvpSection ev={ev} user={user} onRsvp={onRsvp} />

          <div className="evd__actions">
            <button type="button" className={inviting ? 'primary' : ''} aria-expanded={inviting} aria-controls="invite-panel" onClick={() => setInviting((v) => !v)}>
              ✉ Invite
            </button>
            {listing && <a className="button" href={listing} target="_blank" rel="noopener noreferrer">Listing on {hostOf(listing)} ↗</a>}
            <MarkButtons ev={ev} onMark={onMark} />
            {canEdit && <Link className="button" to={`/events/${ev.communityId}/edit`}>Edit</Link>}
            {ev.community && user && user.id !== ev.ownerId && <ReportButton user={user} kind="community_event" id={ev.communityId!} />}
          </div>
          {inviting && <div id="invite-panel"><InvitePanel ev={ev} user={user} /></div>}

          {description && (
            <section className="evd__block" aria-label="Details">
              <h3 className="evd__label">About</h3>
              <p className="evd__text">{description}</p>
            </section>
          )}

          {ev.cruise && (
            <section className="evd__block cruise" aria-label="Cruise">
              <h3 className="evd__label">Cruise: {ev.cruise.route.name}</h3>
              <p className="hint">
                Meet {ev.cruise.meet.note ? `at ${ev.cruise.meet.note}` : 'at the marked spot'} · rolls out {new Date(ev.cruise.rollOut).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
              </p>
              {cruise?.route.vertices
                ? <CruiseMap line={cruise.route.vertices} type={cruise.route.type} meet={cruise.meet} fitKey={ev.communityId} />
                : <p className="hint">Loading the route…</p>}
              {user && (isOrganiser || going) && (
                <Link className="button primary" to={`/convoy?cruise=${encodeURIComponent(ev.communityId!)}`}>{isOrganiser ? 'Start convoy' : 'Join convoy'}</Link>
              )}
              {user && !isOrganiser && !going && <p className="hint">Say you are going to join the convoy.</p>}
            </section>
          )}

          {socials.length > 0 && (
            <section className="evd__block" aria-label="Organiser">
              <h3 className="evd__label">Organiser</h3>
              <div className="evd__links">
                {socials.map((s) => (
                  <a key={`${s.network}-${s.handle}`} href={safeHref(s.url)} target="_blank" rel="noopener noreferrer">
                    <span aria-hidden="true">{s.icon}</span> {s.network} <span className="hint">@{s.handle}</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {links.length > 0 && (
            <section className="evd__block" aria-label="Links">
              <h3 className="evd__label">Links</h3>
              <div className="evd__links">
                {links.map((l) => <a key={l.url} href={safeHref(l.url)} target="_blank" rel="noopener noreferrer" title={l.url}>{l.host} ↗</a>)}
              </div>
            </section>
          )}

          {ev.sources.length > 0 && (
            <p className="hint evd__found">Found on {ev.sources.join(', ')}{ev.sources.some((s) => s === 'facebook' || s === 'websearch') ? '. Details from these are read off the page, so check the listing.' : '.'}</p>
          )}

          {!ev.community && !onMark && <p className="hint">Sign in to keep a shortlist and hide events you don't want.</p>}
          {adminSlot && (
            <div className="evd__admin">
              <button type="button" className="button" aria-expanded={showEdit} onClick={() => setShowEdit((v) => !v)}>
                {showEdit ? 'Close editor' : 'Edit'}
              </button>
              {showEdit && adminSlot}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** What the large view shows while one event is fetched on its own (a link to something not on the list yet). */
export function EventDetailSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Loading event" onClose={onClose} className="evd">
      <div className="evd__grid" aria-busy="true">
        <div className="evd__media"><div className="skel evd__flyer evd__flyer--skel" /></div>
        <div className="evd__main">
          <div className="skel skel--line skel--w30" />
          <div className="skel skel--title" />
          <div className="skel skel--line skel--w65" />
          <div className="skel skel--line skel--w50" />
          <div className="skel skel--line skel--w80" />
        </div>
      </div>
    </Modal>
  );
}

/** For a link to an event that is gone, or that this person may not see. */
export function EventNotFound({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Event not found" onClose={onClose} size="small">
      <div className="evd__missing">
        <h2>That event is not here</h2>
        <p className="hint">It may have been removed, or the link is wrong. The list has what is on.</p>
        <button type="button" className="primary" onClick={onClose}>Back to events</button>
      </div>
    </Modal>
  );
}
