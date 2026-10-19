import type { ClientMessage, ServerMessage } from './types.js';

/**
 * The browser's one WebSocket to the server, shared by whatever on the page
 * wants it (the convoy, the chat). It opens when the first user asks for it
 * and closes a moment after the last lets go, and in between it reconnects
 * with a growing, jittered wait, so a server restart or a tunnel does not
 * get every phone back in the same second.
 *
 * `unavailable` is what a page watches to fall back to polling: the socket
 * could not be opened a few times in a row. It keeps trying in the background.
 * `ended` is the server saying the session is over; there is no point retrying.
 */

export type Status = 'idle' | 'connecting' | 'open' | 'retrying' | 'unavailable' | 'ended';

/** The part of a WebSocket this uses, so a test can stand one in. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Env {
  open(url: string): SocketLike;
  url(): string;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const OPEN = 1;
/** Consecutive failures to connect before callers are told to poll instead. */
export const UNAVAILABLE_AFTER = 3;
export const MAX_WAIT_MS = 30_000;
/** Let go of the socket this long after the last user, so moving between two pages that use it does not reconnect. */
export const LINGER_MS = 3000;
/** The session is over (server/src/realtime.ts CLOSE_SESSION_ENDED). */
export const SESSION_ENDED = 4401;
export const CONNECTION_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 20_000;

/** How long to wait before attempt number `attempt` (0 first): doubling from a second, capped, then 50 to 100 per cent of it. */
export function backoff(attempt: number, random: number): number {
  const ceiling = Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random / 2));
}

export function browserEnv(): Env {
  return {
    open: (url) => new WebSocket(url) as unknown as SocketLike,
    url: () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    random: Math.random,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

export class RealtimeClient {
  status: Status = 'idle';
  private socket: SocketLike | null = null;
  private users = 0;
  private failures = 0;
  private timer: unknown = null;
  private lingerTimer: unknown = null;
  private deadlineTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private messageListeners = new Set<(m: ServerMessage) => void>();
  private statusListeners = new Set<(s: Status) => void>();

  constructor(private env: Env = browserEnv()) {}

  /** Ask for the connection. Call the returned function when done with it. */
  acquire(): () => void {
    this.users++;
    if (this.lingerTimer !== null) { this.env.clearTimeout(this.lingerTimer); this.lingerTimer = null; }
    if (this.users === 1 && !this.socket && this.timer === null) this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.users > 0) return;
      this.lingerTimer = this.env.setTimeout(() => { this.lingerTimer = null; this.shutdown(); }, LINGER_MS);
    };
  }

  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(fn);
    return () => { this.messageListeners.delete(fn); };
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusListeners.add(fn);
    return () => { this.statusListeners.delete(fn); };
  }

  /** Whether it went out: a message sent while the socket is not open is dropped, not queued. */
  send(message: ClientMessage): boolean {
    if (this.status !== 'open' || !this.socket) return false;
    if (this.socket.readyState !== OPEN) { this.reconnect(); return false; }
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.reconnect(); return false; }
  }

  /** Recover immediately after connectivity returns or a suspended page becomes visible. */
  reconnect(): void {
    if (this.users === 0 || this.status === 'ended') return;
    this.shutdown();
    this.connect();
  }

  private clearHealthTimers(): void {
    if (this.deadlineTimer !== null) this.env.clearTimeout(this.deadlineTimer);
    if (this.heartbeatTimer !== null) this.env.clearTimeout(this.heartbeatTimer);
    this.deadlineTimer = this.heartbeatTimer = null;
  }

  private deadline(socket: SocketLike): void {
    this.deadlineTimer = this.env.setTimeout(() => {
      if (this.socket !== socket) return;
      this.clearHealthTimers();
      this.socket = null;
      socket.close();
      this.failures++;
      if (this.users > 0) this.retry(); else this.setStatus('idle');
    }, CONNECTION_TIMEOUT_MS);
  }

  private heartbeat(socket: SocketLike): void {
    this.clearHealthTimers();
    this.heartbeatTimer = this.env.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.socket !== socket) return;
      if (this.send({ t: 'ping' })) this.deadline(socket);
    }, HEARTBEAT_MS);
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of [...this.statusListeners]) fn(s);
  }

  private connect(): void {
    this.setStatus(this.failures >= UNAVAILABLE_AFTER ? 'unavailable' : 'connecting');
    let socket: SocketLike;
    try { socket = this.env.open(this.env.url()); } catch { this.retry(); return; }
    this.socket = socket;
    this.deadline(socket);
    socket.onopen = () => { /* a connection is only good once the server's hello arrives */ };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      if (m.t === 'hello') { this.failures = 0; this.setStatus('open'); this.heartbeat(socket); }
      if (m.t === 'pong') { this.heartbeat(socket); return; }
      for (const fn of [...this.messageListeners]) fn(m);
    };
    socket.onerror = () => { /* followed by a close, which does the work */ };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.clearHealthTimers();
      this.socket = null;
      if (ev.code === SESSION_ENDED) { this.setStatus('ended'); return; }
      if (this.users === 0) { this.setStatus('idle'); return; }
      this.failures += this.status === 'open' ? 0 : 1;
      this.retry();
    };
  }

  private retry(): void {
    const wait = backoff(Math.max(0, this.failures - 1), this.env.random());
    this.setStatus(this.failures >= UNAVAILABLE_AFTER ? 'unavailable' : 'retrying');
    this.timer = this.env.setTimeout(() => { this.timer = null; if (this.users > 0) this.connect(); }, wait);
  }

  private shutdown(): void {
    this.clearHealthTimers();
    if (this.timer !== null) { this.env.clearTimeout(this.timer); this.timer = null; }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.failures = 0;
    this.setStatus('idle');
  }
}

/** The page's one connection. */
export const realtime = new RealtimeClient();
