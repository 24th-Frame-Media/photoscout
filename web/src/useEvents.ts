import { useCallback, useEffect, useState } from 'react';
import { api, type EventItem, type EventState, type RsvpStatus, type RsvpSummary } from './api.js';
import { communityToItem, mergeEvents } from './events.js';
import { myRsvpOf, optimisticRsvp, rollbackRsvp, rsvpFromServer, rsvpStep } from './rsvp.js';

/** Says you are going, or interested, or neither (null); throws when the server refuses, after putting the counts back. */
export type OnRsvp = (ev: EventItem, next: RsvpStatus | null) => Promise<RsvpSummary>;

/**
 * The events list, polled while `enabled`, and a way to star, hide or RSVP to one.
 * The server keeps the list for a minute, so polling every few minutes costs event-scout nothing.
 * `events` stays null until the first answer, so a page can tell loading from empty.
 *
 * Community events (made by people here) come from their own endpoint and are
 * merged in; if that one fails the scraped list is still shown.
 *
 * `extra` holds an event somebody linked to that is not on the list (it has ended, or the list is
 * still loading); it takes part in RSVPs but never shows in the list itself.
 */
export function useEvents(enabled = true) {
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [extra, setExtra] = useState<EventItem[]>([]);
  const [error, setError] = useState('');
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const load = () => Promise.all([api.events(), api.communityEvents().catch(() => [])])
      .then(([scraped, community]) => { if (!stop) { setEvents(mergeEvents(scraped, community)); setError(''); } })
      .catch((err) => { if (!stop) setError((err as Error).message); });
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [enabled, reloads]);

  /** Change one event wherever the page holds it. */
  const patch = useCallback((group: string, fn: (ev: EventItem) => EventItem) => {
    const apply = (list: EventItem[]) => list.map((ev) => (ev.group === group ? fn(ev) : ev));
    setEvents((list) => list && apply(list));
    setExtra(apply);
  }, []);

  /** Throws when the server refuses, so the caller can say why. */
  async function mark(group: string, patchState: Partial<EventState>) {
    const { starred, hidden } = await api.setEventState(group, patchState);
    patch(group, (ev) => ({ ...ev, starred, hidden }));
  }

  /**
   * Answer an event: the counts move at once, and go back if the server says no.
   * Resolves with the server's own summary, attendees included.
   */
  const rsvp: OnRsvp = async (ev, next) => {
    const was = myRsvpOf(ev);
    const guess = optimisticRsvp(ev, next);
    const step = rsvpStep(ev, guess);
    patch(ev.group, (e) => ({ ...e, ...optimisticRsvp(e, next) }));
    try {
      const { rsvp: summary } = ev.community && ev.communityId
        ? await (next ? api.setCommunityRsvp(ev.communityId) : api.clearCommunityRsvp(ev.communityId))
        : await (next ? api.setEventRsvp(ev.group, next) : api.clearEventRsvp(ev.group));
      patch(ev.group, (e) => ({ ...e, ...rsvpFromServer(summary) }));
      return summary;
    } catch (err) {
      // Undo the guess's own steps on what is shown now, so a poll that landed meanwhile keeps its counts.
      patch(ev.group, (e) => rollbackRsvp(e, step, guess.myRsvp, was));
      throw err;
    }
  };

  /** Keep an event that is not on the list, so the open view can read and change it. */
  const keep = useCallback((ev: EventItem) => setExtra((list) => [...list.filter((e) => e.group !== ev.group), ev]), []);

  /** The event on the list, or the one kept aside. */
  const find = useCallback((group: string): EventItem | undefined => events?.find((e) => e.group === group) ?? extra.find((e) => e.group === group), [events, extra]);

  /** One event as the page knows it, fetched on its own: for a link to something not on the list. */
  const fetchOne = useCallback(async (group: string, communityId: string | null): Promise<EventItem> => {
    const ev = communityId ? communityToItem(await api.communityEvent(communityId)) : await api.event(group);
    keep(ev);
    return ev;
  }, [keep]);

  return { events, error, mark, rsvp, find, fetchOne, reload: () => setReloads((n) => n + 1) };
}
