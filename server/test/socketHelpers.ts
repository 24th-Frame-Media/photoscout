import type { WebSocket } from 'ws';

/** A socket under test: every message it gets is kept, and a test can wait for the one it expects. */
export interface Inbox {
  ws: WebSocket;
  all: any[];
  send(message: unknown): void;
  /** The next message (after the ones already taken) that matches, or a failure after `ms`. */
  next(match: (m: any) => boolean, ms?: number): Promise<any>;
  /** Resolves with the close code once the socket closes. */
  closed: Promise<number>;
  /** Wait `ms` and say how many messages matching arrived since the last `next`. */
  quietly(match: (m: any) => boolean, ms?: number): Promise<number>;
}

export function inbox(ws: WebSocket): Inbox {
  const all: any[] = [];
  let cursor = 0;
  const waiting = new Set<() => void>();
  ws.on('message', (data) => {
    all.push(JSON.parse(String(data)));
    for (const wake of [...waiting]) wake();
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return {
    ws, all, closed,
    send: (message) => ws.send(JSON.stringify(message)),
    next(match, ms = 2000) {
      return new Promise((resolve, reject) => {
        const look = () => {
          for (let i = cursor; i < all.length; i++) {
            if (match(all[i])) { cursor = i + 1; waiting.delete(look); clearTimeout(timer); resolve(all[i]); return; }
          }
        };
        const timer = setTimeout(() => { waiting.delete(look); reject(new Error(`no matching message in ${ms}ms; got ${JSON.stringify(all.slice(cursor))}`)); }, ms);
        waiting.add(look);
        look();
      });
    },
    async quietly(match, ms = 250) {
      const from = all.length;
      await new Promise((r) => setTimeout(r, ms));
      return all.slice(from).filter(match).length;
    },
  };
}

/** Open a socket and wait for the server's hello. */
export async function connected(ws: WebSocket): Promise<Inbox> {
  const box = inbox(ws);
  await Promise.race([
    box.next((m) => m.t === 'hello'),
    new Promise((_, reject) => ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)))),
    new Promise((_, reject) => ws.once('error', reject)),
  ]);
  return box;
}

/** The HTTP status an upgrade was refused with. */
export function refusal(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
    ws.once('open', () => reject(new Error('the upgrade was accepted')));
    ws.once('error', () => { /* the refusal also surfaces as an error; the status is what we want */ });
  });
}
