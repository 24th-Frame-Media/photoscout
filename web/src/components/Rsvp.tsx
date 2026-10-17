import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EventItem, RsvpAttendee, RsvpStatus, User } from '../api.js';
import { api } from '../api.js';
import type { OnRsvp } from '../useEvents.js';
import { MAX_AVATARS, moreAttendees, myRsvpOf, nextRsvp, rsvpOptions, withMe } from '../rsvp.js';

const LABEL: Record<RsvpStatus, string> = { going: 'Going', interested: 'Interested' };

/** "12 going · 4 interested", leaving out what is zero. Empty when nobody has answered. */
export function countsText(ev: Pick<EventItem, 'going' | 'interested' | 'community'>): string {
  const parts: string[] = [];
  if (ev.going) parts.push(`${ev.going} going`);
  if (!ev.community && ev.interested) parts.push(`${ev.interested} interested`);
  return parts.join(' · ');
}

/**
 * Going and Interested as toggle buttons with their counts (a community event only has Going).
 * Pressing the one that is on turns it off. The counts move before the server answers; if it refuses
 * they go back and the reason is said under the buttons. Without `onRsvp` (a visitor) it is just the counts.
 */
export function RsvpButtons({ ev, onRsvp, compact = false }: { ev: EventItem; onRsvp?: OnRsvp; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const mine = myRsvpOf(ev);
  const options = rsvpOptions(ev);

  if (!onRsvp) {
    const text = countsText(ev);
    return text ? <p className={`rsvp__counts${compact ? ' rsvp__counts--compact' : ''}`}>{text}</p> : null;
  }

  async function press(status: RsvpStatus) {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      await onRsvp!(ev, nextRsvp(mine, status));
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rsvp${compact ? ' rsvp--compact' : ''}`}>
      <div className="rsvp__buttons" role="group" aria-label="Your RSVP">
        {options.map((status) => {
          const count = status === 'going' ? ev.going ?? 0 : ev.interested ?? 0;
          const on = mine === status;
          return (
            <button
              key={status}
              type="button"
              className={`rsvp__button${on ? ' is-on' : ''}`}
              aria-pressed={on}
              aria-busy={busy}
              disabled={busy}
              onClick={() => void press(status)}
              title={on ? `You are ${status === 'going' ? 'going' : 'interested'}. Press to undo.` : status === 'going' ? 'Say you are going' : 'Say you are interested'}
            >
              <span aria-hidden="true">{on ? '✓' : status === 'going' ? '+' : '☆'}</span> {LABEL[status]}
              {(!compact || count > 0) && <span className="rsvp__count" aria-label={`${count} ${status}`}>{count}</span>}
            </button>
          );
        })}
      </div>
      {note && <p className="status-line error" role="alert">{note}</p>}
    </div>
  );
}

/** One face: the avatar, or the first letter of the name when there is none or it will not load. */
function Face({ who }: { who: RsvpAttendee }) {
  const [failed, setFailed] = useState(false);
  return (
    <Link to={`/u/${encodeURIComponent(who.username)}`} className="avatars__face" title={who.username} aria-label={`${who.username}'s profile`}>
      {who.avatar && !failed
        ? <img src={who.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : <span aria-hidden="true">{who.username.slice(0, 1).toUpperCase()}</span>}
    </Link>
  );
}

/** Up to twelve of the people going, and "+N more" for the rest. */
export function Attendees({ people, going }: { people: RsvpAttendee[]; going: number }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_AVATARS);
  const more = moreAttendees(Math.max(going, people.length), shown.length);
  return (
    <div className="avatars" aria-label="People going">
      {shown.map((p) => <Face key={p.id} who={p} />)}
      {more > 0 && <span className="avatars__more">+{more} more</span>}
    </div>
  );
}

/**
 * The RSVP block of the open event: the buttons, who is going, and for a visitor the counts and a way in.
 * The attendee list is read when the event opens and again after each answer; if the server cannot give it
 * the counts still show.
 */
export function RsvpSection({ ev, user, onRsvp }: { ev: EventItem; user?: User | null; onRsvp?: OnRsvp }) {
  const [people, setPeople] = useState<RsvpAttendee[]>([]);
  const lastGroup = useRef('');
  // Counts the answers that have landed, so a read sent before one cannot put the older names back.
  const answers = useRef(0);
  useEffect(() => {
    let stop = false;
    const seen = answers.current;
    if (lastGroup.current !== ev.group) setPeople([]);
    lastGroup.current = ev.group;
    const read = ev.community && ev.communityId ? api.communityRsvp(ev.communityId) : api.eventRsvp(ev.group);
    read.then(({ rsvp }) => { if (!stop && answers.current === seen) setPeople(rsvp.attendees); }).catch(() => {});
    return () => { stop = true; };
  }, [ev.group, ev.communityId, ev.community]);

  const answer: OnRsvp | undefined = onRsvp && (async (e, next) => {
    const summary = await onRsvp(e, next);
    answers.current += 1;
    setPeople(summary.attendees);
    return summary;
  });
  const going = myRsvpOf(ev) === 'going';
  // Show your own face at once rather than after the round trip, and take it away just as fast.
  const shown = user ? withMe(people, user, going) : people;
  const counts = countsText(ev);

  return (
    <section className="evd__block rsvp-section" aria-label="RSVP">
      <h3 className="evd__label">Who is coming</h3>
      <RsvpButtons ev={ev} onRsvp={answer} />
      {!onRsvp && (
        <p className="rsvp__signin">
          {counts ? '' : 'Nobody has said yet. '}
          <Link to="/login">Sign in to RSVP</Link>
        </p>
      )}
      <Attendees people={shown} going={ev.going ?? 0} />
      {answer && !counts && shown.length === 0 && <p className="hint">Nobody has answered yet. Be the first.</p>}
    </section>
  );
}
