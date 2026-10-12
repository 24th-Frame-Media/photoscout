import { useEffect, useState } from 'react';
import { api, type EventItem, type EventState } from './api.js';
import { mergeEvents } from './events.js';

/**
 * The events list, polled while `enabled`, and a way to star or hide one.
 * The server keeps the list for a minute, so polling every few minutes costs event-scout nothing.
 * `events` stays null until the first answer, so a page can tell loading from empty.
 *
 * Community events (made by people here) come from their own endpoint and are
 * merged in; if that one fails the scraped list is still shown.
 */
export function useEvents(enabled = true) {
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const load = () => Promise.all([api.events(), api.communityEvents().catch(() => [])])
      .then(([scraped, community]) => { if (!stop) { setEvents(mergeEvents(scraped, community)); setError(''); } })
      .catch((err) => { if (!stop) setError((err as Error).message); });
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [enabled]);

  /** Throws when the server refuses, so the caller can say why. */
  async function mark(group: string, patch: Partial<EventState>) {
    const { starred, hidden } = await api.setEventState(group, patch);
    setEvents((list) => list && list.map((ev) => (ev.group === group ? { ...ev, starred, hidden } : ev)));
  }

  /** Say you are going to a community event, or that you no longer are. Throws when the server refuses. */
  async function setGoing(communityId: string, going: boolean) {
    const { going: count, isGoing } = await api.setGoing(communityId, going);
    setEvents((list) => list && list.map((ev) => (ev.communityId === communityId ? { ...ev, going: count, isGoing } : ev)));
  }

  return { events, error, mark, setGoing };
}
