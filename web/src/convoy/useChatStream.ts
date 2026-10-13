import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../api.js';
import { realtime, type Status } from './client.js';

/**
 * Live delivery for the chat room, over the shared socket. The page still
 * fetches its history over REST; this tells it about what happens after.
 *
 * `status` is the socket's: anything but `open` is the page's cue to poll instead.
 */
export function useChatStream(enabled: boolean, on: {
  /** A line was posted (possibly by this user, which the page already has: dedupe by id). */
  posted: (m: ChatMessage) => void;
  gone: (id: string) => void;
  /** Read the history again: the socket (re)connected, or something changed that lines alone do not say. */
  reload: () => void;
}): Status {
  const [status, setStatus] = useState<Status>(realtime.status);
  const handlers = useRef(on);
  handlers.current = on;
  useEffect(() => {
    if (!enabled) return;
    const release = realtime.acquire();
    setStatus(realtime.status);
    // Subscribed on every hello, so a reconnect picks the room back up; and one history read to fill the gap.
    const offMessage = realtime.onMessage((m) => {
      if (m.t === 'hello') { realtime.send({ t: 'chat.sub' }); handlers.current.reload(); }
      else if (m.t === 'chat') handlers.current.posted(m.message);
      else if (m.t === 'chat.gone') handlers.current.gone(m.id);
      else if (m.t === 'chat.refresh') handlers.current.reload();
    });
    const offStatus = realtime.onStatus(setStatus);
    if (realtime.status === 'open') realtime.send({ t: 'chat.sub' });
    return () => { realtime.send({ t: 'chat.unsub' }); offMessage(); offStatus(); release(); };
  }, [enabled]);
  return status;
}
