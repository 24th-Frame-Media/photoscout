import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChatMessage, type User } from '../api.js';
import { ago } from '../ago.js';
import ReportButton from '../components/ReportButton.js';
import { useChatStream } from '../convoy/useChatStream.js';

/** The newest hundred lines the server will give, which is also the most it shows. */
const KEEP = 100;
/** How long the server keeps a line (CHAT_MINUTES in server/src/bodyLimits.ts). */
const CHAT_MINUTES = 30;

/**
 * One public room. Messages vanish after 30 minutes. Plain text only.
 * The history comes over REST; new lines arrive on the WebSocket. If the socket cannot be had
 * (a proxy that drops it, a flaky connection) the page polls every 5 s instead, as it always did.
 */
export default function Chat({ user }: { user: User | null }) {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // The whole window (at most 100 lines), so a message deleted by someone else disappears too.
  const load = useCallback(() => {
    api.chat().then((rows) => { setMsgs(rows); setError(''); }).catch((err) => setError((err as Error).message));
  }, []);
  const status = useChatStream(Boolean(user), {
    posted: (m) => setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m].slice(-KEEP))),
    gone: (id) => setMsgs((prev) => prev.filter((m) => m.id !== id)),
    reload: load,
  });
  const live = status === 'open';

  useEffect(() => { if (user) load(); }, [user?.id, load]);

  // Without a live socket, ask every few seconds while the page is in view.
  useEffect(() => {
    if (!user || live) return;
    const poll = () => { if (document.visibilityState === 'visible') load(); };
    const timer = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [user?.id, live, load]);

  // Lines expire after CHAT_MINUTES on the server; with nothing polling to say so, drop them here too (and refresh the "ago" times).
  useEffect(() => {
    const timer = setInterval(() => {
      const cut = Date.now() - CHAT_MINUTES * 60_000;
      setMsgs((prev) => { const kept = prev.filter((m) => Date.parse(m.created_at) > cut); return kept.length === prev.length ? [...prev] : kept; });
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

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
      // The socket may have delivered it already.
      setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
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
      <p className="hint">One room for everyone. Messages disappear after 30 minutes.{!live && ' Updating every few seconds.'}</p>
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
