import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTick } from '../drive/hooks.js';
import { speechSupported, stopConvoyAudio, unlockConvoyAudio } from '../drive/audio.js';
import { useConvoy } from './useConvoy.js';

export function ConvoyAudio() {
  const convoy = useConvoy();
  const [notificationError, setNotificationError] = useState('');
  return <fieldset className="convoy-audio">
    <legend>Riding &amp; audio</legend>
    <label><input type="checkbox" disabled={!speechSupported()} checked={convoy.readMessages} onChange={(e) => {
      convoy.setPreference('readMessages', e.target.checked);
      if (e.target.checked) unlockConvoyAudio(); else stopConvoyAudio();
    }} /> Read new convoy messages aloud</label>
    <label><input type="checkbox" disabled={!speechSupported()} checked={convoy.announceEvents} onChange={(e) => {
      convoy.setPreference('announceEvents', e.target.checked);
      if (e.target.checked) unlockConvoyAudio(); else stopConvoyAudio();
    }} /> Announce route, rest-stop and membership changes</label>
    {speechSupported() && <button onClick={unlockConvoyAudio}>Test headset audio</button>}
    <label><input type="checkbox" checked={convoy.keepAwake} onChange={(e) => convoy.setPreference('keepAwake', e.target.checked)} /> Keep screen awake while in a convoy</label>
    {typeof Notification !== 'undefined' && <label><input type="checkbox" checked={convoy.desktopAlerts} onChange={async (e) => {
      const on = e.target.checked;
      setNotificationError('');
      if (!on) { convoy.setPreference('desktopAlerts', false); return; }
      try {
        const permission = await Notification.requestPermission();
        convoy.setPreference('desktopAlerts', permission === 'granted');
        if (permission !== 'granted') setNotificationError('Device notifications are blocked. In-app notifications still work.');
      } catch { setNotificationError('This browser cannot enable device notifications. In-app notifications still work.'); }
    }} /> Device notifications when another tab is open</label>}
    {notificationError && <p className="hint" role="status">{notificationError}</p>}
    <details className="convoy-mobile"><summary>Android &amp; iPhone background use</summary>
      <p className="hint">Install PhotoScout using your browser’s Install app or Add to Home Screen option. On iPhone, open the installed app before enabling device notifications.</p>
      <p className="hint">Keep PhotoScout on screen for live position sharing. Screen awake helps while it is visible; locking your phone or switching apps can pause GPS, messages and speech. The convoy reconnects and catches up when you return. Notifications here still depend on the app running.</p>
      <p className="hint">Member pins glide between GPS fixes. A ~ marks a brief position estimate; prediction stops after 3 seconds or 90 metres, and old locations fade.</p>
    </details>
    <p className="hint">Uses your device audio, including a paired headset. Directions take priority. Keep the app visible; phones may suspend it when locked.</p>
  </fieldset>;
}

export default function ConvoyChat({ compact = false }: { compact?: boolean }) {
  const convoy = useConvoy();
  const room = convoy.room;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{ clientId: string; text: string; at: number } | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const now = useTick(1000);
  const lastMessage = room?.messages.at(-1)?.id;
  useEffect(() => {
    if (room && document.visibilityState === 'visible') convoy.markRead(room.code);
    const node = feed.current;
    if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 180) node.scrollTop = node.scrollHeight;
  }, [room?.code, lastMessage, now]);
  useEffect(() => {
    if (pending && room?.messages.some((m) => m.userId === convoy.me && m.clientId === pending.clientId)) {
      setDraft((value) => value === pending.text ? '' : value);
      setPending(null);
    }
  }, [room?.messages, pending, convoy.me]);
  if (!room) return null;
  const waiting = !!pending && now - pending.at < 8_000;
  const lastOwnMessage = [...room.messages].reverse().find((m) => m.userId === convoy.me);
  const cooling = !!lastOwnMessage && now - lastOwnMessage.ts < 2_000;
  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || waiting || cooling) return;
    const clientId = pending?.text === clean ? pending.clientId : crypto.randomUUID();
    if (convoy.sendMessage(clean, clientId)) setPending({ text: clean, clientId, at: Date.now() });
  };
  const submit = (event: FormEvent) => { event.preventDefault(); send(draft); };
  return <section className={`convoy-chat${compact ? ' convoy-chat--compact' : ''}`} aria-label="Convoy chat">
    <h3>Convoy chat <span className="hint">Members only · expires after 30 minutes</span></h3>
    <div className="convoy-chat__messages" ref={feed} role="log" aria-label="Convoy messages" aria-live="off">
      {!room.messages.length && <p className="hint">Send a message or use a quick update.</p>}
      {room.messages.filter((m) => now - m.ts < 30 * 60_000).slice(compact ? -10 : -50).map((m) => <p key={m.id}>
        <strong>{m.userId === convoy.me ? 'You' : m.username}</strong> <time dateTime={new Date(m.ts).toISOString()}>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <span>{m.text}</span>
      </p>)}
    </div>
    <div className="convoy-quick" aria-label="Quick convoy updates">
      {['Wait for me', 'Stopping safely', 'Ready to go', 'Need help'].map((text) => <button key={text} disabled={convoy.status !== 'open' || waiting || cooling} onClick={() => send(text)}>{text}</button>)}
    </div>
    <form onSubmit={submit} className="convoy-chat__form">
      <input aria-label="Message convoy" placeholder="Message your convoy" maxLength={500} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button className="primary" disabled={convoy.status !== 'open' || !draft.trim() || waiting || cooling}>{waiting ? 'Sending…' : 'Send'}</button>
    </form>
    {pending && !waiting && <p role="status">Message not confirmed. <button onClick={() => send(pending.text)} disabled={convoy.status !== 'open'}>Retry message</button></p>}
    {convoy.error && <p className="error" role="alert">{convoy.error}</p>}
  </section>;
}
