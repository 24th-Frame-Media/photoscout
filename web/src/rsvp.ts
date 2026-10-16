import type { EventItem, RsvpStatus, RsvpSummary } from './api.js';

/** The part of an event an RSVP changes: what the card and the detail view both read. */
export type RsvpFields = Pick<EventItem, 'going' | 'interested' | 'myRsvp' | 'isGoing'>;

/** What an event offers: a community event only has "Going". */
export const rsvpOptions = (ev: Pick<EventItem, 'community'>): RsvpStatus[] => (ev.community ? ['going'] : ['going', 'interested']);

/** The caller's answer as the item carries it; a community event from the old list shape says only isGoing. */
export function myRsvpOf(ev: Pick<EventItem, 'myRsvp' | 'isGoing' | 'community'>): RsvpStatus | null {
  if (ev.myRsvp !== undefined) return ev.myRsvp;
  return ev.community && ev.isGoing ? 'going' : null;
}

/** What pressing a button means: pressing the one you already chose takes it back. */
export function nextRsvp(current: RsvpStatus | null, pressed: RsvpStatus): RsvpStatus | null {
  return current === pressed ? null : pressed;
}

const dec = (n: number | undefined): number => Math.max(0, (n ?? 0) - 1);
const inc = (n: number | undefined): number => (n ?? 0) + 1;

/**
 * The counts straight after the caller changes their answer, before the server has said anything.
 * Leaving one answer for another moves the count across; clearing only takes one off. Never below zero,
 * and a community event never gets an "interested".
 */
export function optimisticRsvp(ev: EventItem, next: RsvpStatus | null): RsvpFields {
  const was = myRsvpOf(ev);
  const wanted = next === 'interested' && ev.community ? was : next;
  let going = ev.going ?? 0;
  let interested = ev.interested ?? 0;
  if (was === 'going') going = dec(going);
  if (was === 'interested') interested = dec(interested);
  if (wanted === 'going') going = inc(going);
  if (wanted === 'interested') interested = inc(interested);
  return { going, interested, myRsvp: wanted, isGoing: wanted === 'going' };
}

/** What the server answered, laid over the item. */
export function rsvpFromServer(rsvp: Pick<RsvpSummary, 'going' | 'interested' | 'mine'>): RsvpFields {
  return { going: rsvp.going, interested: rsvp.interested, myRsvp: rsvp.mine, isGoing: rsvp.mine === 'going' };
}

/** How far an optimistic answer moved the two counts, so a refused one can move them back by the same steps. */
export function rsvpStep(before: EventItem, guess: RsvpFields): { going: number; interested: number } {
  return { going: (guess.going ?? 0) - (before.going ?? 0), interested: (guess.interested ?? 0) - (before.interested ?? 0) };
}

/**
 * Takes back an answer the server refused, on the event as it is now: the counts go back by the steps the guess
 * took, and the answer goes back to `was`. Nothing is restored from a copy, so a refresh that landed meanwhile keeps
 * its counts. If that refresh has already replaced the guess, the event is left as the server has it.
 */
export function rollbackRsvp(now: EventItem, step: { going: number; interested: number }, guessed: RsvpStatus | null | undefined, was: RsvpStatus | null): EventItem {
  if (myRsvpOf(now) !== guessed) return now;
  return {
    ...now,
    going: Math.max(0, (now.going ?? 0) - step.going),
    interested: Math.max(0, (now.interested ?? 0) - step.interested),
    myRsvp: was,
    isGoing: was === 'going',
  };
}

/** How many attendee faces to show before "+N more". */
export const MAX_AVATARS = 12;

/** "+3 more" for the people behind the faces: the going count less the faces shown. 0 when none are hidden. */
export function moreAttendees(going: number, shown: number): number {
  return Math.max(0, going - shown);
}

/**
 * The attendee list with the caller on it (or off it) at once, so pressing Going shows your own face without
 * waiting for the server. Everyone else keeps their place; you go first, as the newest answer.
 */
export function withMe<T extends { id: string; username: string; avatar: string }>(people: T[], me: { id: string; username: string; avatar: string }, going: boolean): Array<T | { id: string; username: string; avatar: string }> {
  const others = people.filter((p) => p.id !== me.id);
  if (!going) return others;
  const mine = people.find((p) => p.id === me.id) ?? { id: me.id, username: me.username, avatar: me.avatar };
  return [mine, ...others];
}
