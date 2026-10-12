import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Report, type User } from '../api.js';
import { ago } from '../ago.js';

/** Kinds where "Hide" does something; for the rest it only settles the report. */
const HIDES = new Set(['post', 'comment', 'chat', 'community_event']);

/** The reports queue, for admins and moderators. Everything shown was written by a user and is rendered as plain text. */
export default function Moderation({ user }: { user: User | null }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState('');
  const staff = user?.role === 'admin' || user?.role === 'moderator';

  const load = () => api.reports().then(setReports).catch((err) => setError((err as Error).message));
  useEffect(() => { if (staff) void load(); }, [staff]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); } catch (err) { setError((err as Error).message); }
  };

  if (!staff) return <div className="page"><p className="hint">Moderators and admins only.</p></div>;
  const open = (reports ?? []).filter((r) => !r.resolved_at);
  const settled = (reports ?? []).filter((r) => r.resolved_at);
  return (
    <div className="page moderation">
      <h1>Moderation</h1>
      {error && <p className="status-line error">{error}</p>}
      {!reports ? <p className="hint">Loading…</p> : open.length === 0 ? <p className="hint">Nothing waiting.</p> : (
        <div className="feed__list">
          {open.map((r) => (
            <article key={r.id} className="spotcard">
              <p><span className="eventbadge">{r.target_kind.replace('_', ' ')}</span> <span className="hint">reported by {r.reporter ?? 'a deleted account'} · {ago(r.created_at)}</span></p>
              <p className="feedcard__text">{r.snapshot ?? '(already removed)'}</p>
              {r.reason && <p className="hint">Reason: {r.reason}</p>}
              {r.author && <p className="hint">By <Link to={`/u/${encodeURIComponent(r.author.username)}`}>{r.author.username}</Link> ({r.author.role}{r.author.banned ? ', suspended' : ''})</p>}
              {r.target_kind === 'spot' && <p><Link to={`/?spot=${encodeURIComponent(r.target_id)}`}>Open the spot</Link></p>}
              <div className="eventcard__actions">
                <button onClick={() => void run(() => api.resolveReport(r.id, 'dismiss'))}>Dismiss</button>
                <button className="primary" onClick={() => void run(() => api.resolveReport(r.id, 'hide'))}>{HIDES.has(r.target_kind) ? 'Hide' : 'Mark resolved'}</button>
                {r.author && r.author.role === 'contributor' && (
                  <button onClick={() => void run(() => api.updateUser(r.author!.id, { banned: !r.author!.banned }))}>{r.author.banned ? 'Reinstate' : 'Suspend'}</button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {settled.length > 0 && (
        <>
          <h2>Settled</h2>
          <ul>{settled.slice(0, 30).map((r) => <li key={r.id} className="hint">{r.target_kind.replace('_', ' ')}: {r.snapshot ?? '(removed)'} · {ago(r.resolved_at!)}</li>)}</ul>
        </>
      )}
    </div>
  );
}
