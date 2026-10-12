/**
 * What the rest of the app reads from the events engine, called directly.
 *
 * The engine used to be another service asked over HTTP; these are the same
 * answers its routes give, without the round trip. Everything here is a read.
 */
import { getMergedEvents, toListItem } from './events.js';
import { filterEvents, paginate, parseEventQuery } from './query.js';
import { listAreas, venueHistory, venueReadings } from './density/pipeline.js';
import { pickAreas } from './density/areas.js';

/** Upcoming events as the list route gives them; `query` is that route's query string, as an object. */
export function listEvents(query: Record<string, unknown> = {}): ReturnType<typeof toListItem>[] {
  const q = parseEventQuery(query);
  return paginate(filterEvents(getMergedEvents({ archived: q.archived }), q), q).page.map(toListItem);
}

export function densityAreas(): { areas: ReturnType<typeof listAreas> } {
  return { areas: listAreas() };
}

export function densityVenues(slug: string): ReturnType<typeof venueReadings> {
  const [area] = pickAreas([slug]);
  return area ? venueReadings(area) : [];
}

export function densityHistory(slug: string, venue: string, days = 14): ReturnType<typeof venueHistory> {
  const [area] = pickAreas([slug]);
  return area ? venueHistory(area, venue, days) : null;
}
