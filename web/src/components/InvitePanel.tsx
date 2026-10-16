import { useEffect, useRef, useState } from 'react';
import { api, HttpError, type EventItem, type User, type UserHit } from '../api.js';
import { decodeEntities, eventPath } from '../events.js';

/** The fewest letters worth a search, and how long to wait after the last keystroke. */
export const MIN_QUERY = 2;
export const SEARCH_DELAY_MS = 250;

export const RATE_LIMIT_MESSAGE = "You've sent a lot of invites — try again later";

/** The words for an invite that failed: the rate limit gets its own, anything else says what the server said. */
export function inviteError(err: unknown): string {
  if (err instanceof HttpError && err.status === 429) return RATE_LIMIT_MESSAGE;
  return (err as Error).message || 'Could not send the invite';
}

/** The address a share link points at: this event's own page, on this site. */
export function shareUrl(ev: Pick<EventItem, 'group' | 'community' | 'communityId'>, origin = window.location.origin): string {
  return `${origin}${eventPath(ev)}`;
}

type Sent = 'sending' | 'invited' | string;

/**
 * Asking people to an event: a link to share, and for somebody signed in a search for a PhotoScout user to invite.
 * The link goes through the phone's share sheet when there is one, otherwise it is copied.
 */
export default function InvitePanel({ ev, user }: { ev: EventItem; user?: User | null }) {
  const url = shareUrl(ev);
  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function share() {
    setShareNote('');
    const data = { title: decodeEntities(ev.title), text: `${decodeEntities(ev.title)} on PhotoScout`, url };
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        // Closing the share sheet is a choice, not a failure; anything else falls through to copying.
        if ((err as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setShareNote('Could not copy. Select the link and copy it by hand.');
    }
  }

  // --- search ---
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [sent, setSent] = useState<Record<string, Sent>>({});
  const q = query.trim();

  useEffect(() => {
    setSearchError('');
    if (q.length < MIN_QUERY) { setHits([]); setSearching(false); return; }
    let stale = false;
    setSearching(true);
    const wait = setTimeout(() => {
      api.searchUsers(q)
        .then((found) => { if (!stale) { setHits(found.filter((h) => h.id !== user?.id)); setSearching(false); } })
        .catch((err) => { if (!stale) { setHits([]); setSearching(false); setSearchError((err as Error).message); } });
    }, SEARCH_DELAY_MS);
    return () => { stale = true; clearTimeout(wait); };
  }, [q, user?.id]);

  async function invite(hit: UserHit) {
    if (sent[hit.username] === 'sending' || sent[hit.username] === 'invited') return;
    setSent((s) => ({ ...s, [hit.username]: 'sending' }));
    try {
      await api.sendInvite(ev.community ? 'community' : 'event', ev.community && ev.communityId ? ev.communityId : ev.group, hit.username);
      setSent((s) => ({ ...s, [hit.username]: 'invited' }));
    } catch (err) {
      setSent((s) => ({ ...s, [hit.username]: `error:${inviteError(err)}` }));
    }
  }

  return (
    <div className="invite" role="region" aria-label="Invite people">
      <h3 className="evd__label">Share link</h3>
      <div className="invite__share">
        <input className="invite__url" readOnly value={url} aria-label="Link to this event" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="primary" onClick={() => void share()}>
          {typeof navigator.share === 'function' ? 'Share…' : copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="invite__live hint" role="status" aria-live="polite">{copied ? 'Copied' : shareNote}</p>

      {user ? (
        <>
          <h3 className="evd__label">Invite a PhotoScout user</h3>
          <input
            type="search"
            className="invite__search"
            placeholder="Search by username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search PhotoScout users by username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <div aria-live="polite">
            {q.length > 0 && q.length < MIN_QUERY && <p className="hint">Type at least {MIN_QUERY} letters.</p>}
            {searching && <p className="hint">Searching…</p>}
            {searchError && <p className="status-line error" role="alert">{searchError}</p>}
            {!searching && !searchError && q.length >= MIN_QUERY && hits.length === 0 && <p className="hint">Nobody is called that.</p>}
          </div>
          {hits.length > 0 && (
            <ul className="invite__hits">
              {hits.map((hit) => {
                const state = sent[hit.username];
                const failed = state?.startsWith('error:') ? state.slice(6) : '';
                return (
                  <li key={hit.id}>
                    <span className="invite__who">
                      {hit.avatar ? <img src={hit.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="invite__initial" aria-hidden="true">{hit.username.slice(0, 1).toUpperCase()}</span>}
                      <span className="invite__name">{hit.username}</span>
                    </span>
                    <button type="button" disabled={state === 'sending' || state === 'invited'} onClick={() => void invite(hit)} aria-label={state === 'invited' ? `Invited ${hit.username}` : `Invite ${hit.username}`}>
                      {state === 'invited' ? 'Invited' : state === 'sending' ? 'Sending…' : 'Invite'}
                    </button>
                    {failed && <p className="status-line error invite__err" role="alert">{failed}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <p className="hint">Sign in to invite another PhotoScout user by name.</p>
      )}
    </div>
  );
}
