import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CheckinInput, type FeedComment, type FeedItem, type Spot, type User } from '../api.js';
import { ago } from '../ago.js';
import ReportButton from '../components/ReportButton.js';

const PAGE = 30;
const VERBS: Record<FeedItem['kind'], string> = {
  checkin: 'checked in at', ride: 'added a ride:', gear: 'added gear:', rsvp: 'is going to', event: 'is running',
};
const isStaff = (u: User | null) => u?.role === 'admin' || u?.role === 'moderator';
/** A feed link is always a route in this app; anything else is not followed. */
const safeLink = (to: string) => (to.startsWith('/') && !to.startsWith('//') ? to : '/');

/**
 * What people have been up to: check-ins, and rides, gear, RSVPs and events as they happen.
 * Anyone can read the whole feed; a signed-in user can follow people, check in, vote and comment.
 * Everything a user wrote is rendered as plain text.
 */
export default function Feed({ user }: { user: User | null }) {
  const [scope, setScope] = useState<'all' | 'following'>('all');
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  async function load(before?: string) {
    try {
      const rows = await api.feed(scope, before);
      setItems((prev) => (before && prev ? [...prev, ...rows] : rows));
      setMore(rows.length === PAGE);
    } catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { setItems(null); setError(''); void load(); }, [scope]);

  return (
    <div className="page feed">
      <div className="filterbar">
        <div className="chiprow">
          <button className={`chip ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>All</button>
          {user && <button className={`chip ${scope === 'following' ? 'active' : ''}`} onClick={() => setScope('following')}>Following</button>}
        </div>
      </div>
      {user ? <CheckinForm onDone={() => { setItems(null); void load(); }} /> : <p className="hint">Sign in to check in, vote and comment.</p>}
      {error && <p className="status-line error">{error}</p>}
      {!items ? (
        !error && <p className="hint">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty"><p>{scope === 'following' ? 'Nothing yet from the people you follow.' : 'Nothing here yet. Be the first to check in.'}</p></div>
      ) : (
        <div className="feed__list">
          {items.map((it) => <Card key={it.id} item={it} user={user} onGone={(id) => setItems((prev) => prev && prev.filter((p) => p.id !== id))} />)}
          {more && <button onClick={() => void load(items[items.length - 1].created_at)}>Older</button>}
        </div>
      )}
    </div>
  );
}

function Card({ item, user, onGone }: { item: FeedItem; user: User | null; onGone: (id: string) => void }) {
  const [it, setIt] = useState(item);
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<FeedComment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const staff = isStaff(user);
  const subject = it.kind === 'checkin' ? it.place_name : it.body;
  const fail = (err: unknown) => setNote((err as Error).message);

  async function vote() {
    setNote('');
    try { const r = await api.votePost(it.id, !it.voted); setIt({ ...it, votes: r.votes, voted: r.voted }); } catch (err) { fail(err); }
  }
  async function toggle() {
    setOpen(!open);
    if (!open && !comments) await api.comments(it.id).then(setComments).catch(fail);
  }
  async function send() {
    setNote('');
    try {
      const c = await api.addComment(it.id, draft);
      setComments((prev) => [...(prev ?? []), c]);
      setIt((prev) => ({ ...prev, comments: prev.comments + 1 }));
      setDraft('');
    } catch (err) { fail(err); }
  }
  async function removeComment(id: string) {
    try {
      await api.deleteComment(id);
      setComments((prev) => prev && prev.filter((c) => c.id !== id));
      setIt((prev) => ({ ...prev, comments: Math.max(0, prev.comments - 1) }));
    } catch (err) { fail(err); }
  }
  async function remove() {
    if (!confirm('Delete this post?')) return;
    try { await api.deletePost(it.id); onGone(it.id); } catch (err) { fail(err); }
  }

  return (
    <article className="spotcard feedcard">
      <p>
        <Link to={`/u/${encodeURIComponent(it.author.username)}`}><strong>{it.author.username}</strong></Link> {VERBS[it.kind]}{' '}
        <Link to={safeLink(it.link)}>{subject}</Link> <span className="hint">· {ago(it.created_at)}</span>
      </p>
      {it.kind === 'checkin' && it.body && <p className="feedcard__text">{it.body}</p>}
      <div className="eventcard__actions">
        <button className={it.voted ? 'primary' : ''} disabled={!user} onClick={() => void vote()} aria-pressed={it.voted}>▲ {it.votes}</button>
        <button onClick={() => void toggle()}>💬 {it.comments}</button>
        <ReportButton user={user} kind="post" id={it.id} />
        {user && (user.username === it.author.username || staff) && <button className="danger" onClick={() => void remove()}>Delete</button>}
      </div>
      {open && (
        <div className="feedcard__comments">
          {comments === null ? <p className="hint">Loading…</p> : comments.length === 0 ? <p className="hint">No comments yet.</p> : comments.map((c) => (
            <p key={c.id} className="feedcard__comment">
              <Link to={`/u/${encodeURIComponent(c.author.username)}`}><strong>{c.author.username}</strong></Link> {c.body}{' '}
              <span className="hint">{ago(c.created_at)}</span>{' '}
              <ReportButton user={user} kind="comment" id={c.id} />
              {user && (user.username === c.author.username || staff) && <> <button className="danger" onClick={() => void removeComment(c.id)}>Delete</button></>}
            </p>
          ))}
          {user && (
            <form className="feedcard__add" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void send(); }}>
              <input value={draft} maxLength={500} placeholder="Add a comment" onChange={(e) => setDraft(e.target.value)} />
              <button className="primary" disabled={!draft.trim()}>Post</button>
            </form>
          )}
        </div>
      )}
      {note && <p className="status-line error">{note}</p>}
    </article>
  );
}

/** Check in at a public spot found by name, or at where you are now with a name you give it. */
function CheckinForm({ onDone }: { onDone: () => void }) {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Spot | null>(null);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [place, setPlace] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { api.spots().then(setSpots).catch(() => {}); }, []);

  const needle = q.trim().toLowerCase();
  const matches = !pick && needle ? spots.filter((s) => s.visibility === 'public' && s.name.toLowerCase().includes(needle)).slice(0, 6) : [];

  function locate() {
    setNote('');
    if (!navigator.geolocation) return setNote('Your browser cannot share a location.');
    navigator.geolocation.getCurrentPosition(
      (p) => { setHere({ lat: p.coords.latitude, lng: p.coords.longitude }); setPick(null); },
      () => setNote('Could not get your location.'),
    );
  }

  async function submit() {
    let target: CheckinInput;
    if (pick) target = { spotId: pick.id, body };
    else if (here && place.trim()) target = { ...here, placeName: place.trim(), body };
    else return setNote(here ? 'Say where you are.' : 'Pick a spot, or use your location.');
    setBusy(true);
    setNote('');
    try {
      await api.checkin(target);
      setQ(''); setPick(null); setHere(null); setPlace(''); setBody('');
      onDone();
    } catch (err) { setNote((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="spotcard checkin" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>Check in</h3>
      {pick ? (
        <p>📍 {pick.name} <button type="button" className="linkbtn" onClick={() => setPick(null)}>change</button></p>
      ) : here ? (
        <>
          <p className="hint">Using your location. <button type="button" className="linkbtn" onClick={() => setHere(null)}>cancel</button></p>
          <input value={place} maxLength={120} placeholder="Where are you?" onChange={(e) => setPlace(e.target.value)} />
        </>
      ) : (
        <>
          <div className="eventcard__actions">
            <input value={q} placeholder="Search spots by name" onChange={(e) => setQ(e.target.value)} />
            <button type="button" onClick={locate}>Use my location</button>
          </div>
          {matches.map((s) => <button type="button" key={s.id} className="linkbtn" onClick={() => setPick(s)}>{s.name}</button>)}
        </>
      )}
      <input value={body} maxLength={500} placeholder="Say something (optional)" onChange={(e) => setBody(e.target.value)} />
      <div className="eventcard__actions"><button className="primary" disabled={busy}>Check in</button></div>
      {note && <p className="status-line error">{note}</p>}
    </form>
  );
}
