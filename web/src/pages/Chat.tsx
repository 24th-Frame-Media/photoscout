import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChatMessage, type User } from '../api.js';
import { ago } from '../ago.js';
import ReportButton from '../components/ReportButton.js';

/**
 * One public room. Messages vanish after 30 minutes. Plain text only.
 * ponytail: polls every 5 s while the page is visible; move to the convoy WebSocket in Phase 5.
 */
export default function Chat({ user }: { user: User | null }) {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // The whole window each time (at most 100 lines), so a message deleted by someone else disappears too.
  useEffect(() => {
    if (!user) return;
    let stopped = false;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      api.chat().then((rows) => { if (!stopped) { setMsgs(rows); setError(''); } }).catch((err) => { if (!stopped) setError((err as Error).message); });
    };
    poll();
    const timer = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [user?.id]);

  // Follow the newest line unless the reader has scrolled up.
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setError('');
    try {
      const m = await api.sendChat(body);
      stick.current = true;
      setMsgs((prev) => [...prev, m]);
      setDraft('');
    } catch (err) { setError((err as Error).message); }
  }
  async function remove(id: string) {
    try { await api.deleteChat(id); setMsgs((prev) => prev.filter((m) => m.id !== id)); } catch (err) { setError((err as Error).message); }
  }

  if (!user) return <div className="page"><p className="hint"><Link to="/login">Sign in</Link> to join the chat.</p></div>;
  const staff = user.role === 'admin' || user.role === 'moderator';
  return (
    <div className="page chat">
      <p className="hint">One room for everyone. Messages disappear after 30 minutes.</p>
      <div className="chat__log" ref={log} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {msgs.length === 0 && <p className="hint">Quiet in here. Say hello.</p>}
        {msgs.map((m) => (
          <p key={m.id} className="chat__line">
            <Link to={`/u/${encodeURIComponent(m.author.username)}`}><strong>{m.author.username}</strong></Link> {m.body}{' '}
            <span className="hint">{ago(m.created_at)}</span>{' '}
            {m.author.username === user.username ? null : <ReportButton user={user} kind="chat" id={m.id} />}
            {(m.author.username === user.username || staff) && <> <button className="linkbtn" onClick={() => void remove(m.id)}>Delete</button></>}
          </p>
        ))}
      </div>
      <form className="feedcard__add" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={draft} maxLength={300} placeholder="Message" onChange={(e) => setDraft(e.target.value)} />
        <button className="primary" disabled={!draft.trim()}>Send</button>
      </form>
      {error && <p className="status-line error">{error}</p>}
    </div>
  );
}
