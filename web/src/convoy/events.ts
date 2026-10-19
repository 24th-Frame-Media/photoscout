import type { ConvoyState } from './state.js';
import type { ServerMessage } from './types.js';

export interface ConvoyNotice { id: string; room: string; text: string; kind: 'message' | 'event' | 'error'; ts: number }

/** History and position updates stay quiet; only new actions become notifications. */
export function convoyEvents(state: ConvoyState, m: ServerMessage): Omit<ConvoyNotice, 'id' | 'ts'>[] {
  if (m.t === 'hello') return m.rooms.flatMap((room) => {
    const previous = state.rooms.find((r) => r.code === room.code);
    if (!previous || state.me !== m.me) return [];
    return room.messages.filter((message) => message.userId !== m.me && !previous.messages.some((p) => p.id === message.id))
      .map((message) => ({ room: room.code, text: `${message.username}: ${message.text}`, kind: 'message' as const }));
  });
  if (m.t === 'convoy.message') {
    const room = state.rooms.find((r) => r.code === m.room);
    return !room || m.message.userId === state.me || room.messages.some((x) => x.id === m.message.id) ? []
      : [{ room: m.room, text: `${m.message.username}: ${m.message.text}`, kind: 'message' }];
  }
  if (m.t === 'left' && m.removed) return [{ room: m.room, text: 'The leader removed you from the convoy.', kind: 'error' }];
  if (m.t !== 'room') return [];
  const next = m.room;
  const prev = state.rooms.find((r) => r.code === next.code);
  if (!prev) return [{ room: next.code, text: `Joined ${next.name}`, kind: 'event' }];
  const texts: string[] = [];
  for (const member of next.members) if (!prev.members.some((p) => p.id === member.id)) texts.push(`${member.username} joined the convoy`);
  for (const member of next.members) {
    const previous = prev.members.find((p) => p.id === member.id);
    if (member.id !== state.me && previous && previous.online !== member.online) texts.push(`${member.username} ${member.online ? 'reconnected' : 'disconnected'}`);
  }
  for (const member of prev.members) if (!next.members.some((p) => p.id === member.id)) texts.push(`${member.username} left the convoy`);
  if (prev.leader !== next.leader) texts.push(`${next.members.find((p) => p.id === next.leader)?.username ?? 'A member'} is now leading`);
  if (JSON.stringify(prev.destination) !== JSON.stringify(next.destination)) texts.push(next.resting
    ? `Rest stop: ${next.destination?.label || 'New regroup point'}`
    : next.destination ? `Destination: ${next.destination.label || 'New destination'}` : 'Convoy destination cleared');
  if (JSON.stringify(prev.route) !== JSON.stringify(next.route)) texts.push(next.route ? `Route shared: ${next.route.name}` : 'Convoy route cleared');
  return texts.map((text) => ({ room: next.code, text, kind: 'event' }));
}
