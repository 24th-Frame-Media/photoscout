# API

## Who may call what

Sign-in is Google or Discord (see the README); a session is a `__Host-ps_session` cookie. Every route needs a session except:

- Sign-in itself, `GET /api/auth/status` and `GET /api/version`.
- Share-token reads under `/api/share/`: the token is the credential.
- Reads an anonymous visitor may make: `GET` on `/api/places`, `/api/spots` and `/api/routes` (and one by id) and a spot's photos and photo files (public rows only, plus unlisted ones by id), `/api/settings` (a cut-down answer: where the map opens), `/api/rail`, `/api/fires`, `/api/aurora`, `/api/events` (below), `/api/flyer/:day/:name` and the secret calendar links `/api/calendar/:token.ics` (the token is the credential). Anything that proxies a third-party service, or costs a request elsewhere, is not on this list.

Also open to a visitor: `GET /api/feed` (`scope=all` only) and `GET /api/posts/:id/comments`.

Every other method than `GET` and `HEAD` needs a session, and one from another site's `Origin` is refused. Admin routes answer 403 to anyone else. Which accounts are admins is `ADMIN_IDS`; everyone else is a contributor, who edits only their own rows. An admin can make a user a moderator: staff (admins and moderators) can read the reports queue, hide content, delete other people's posts, comments and chat lines, and suspend contributors, and nothing else an admin can do.

## Core

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/status` | `{ authed, user, account, providers }`: who's signed in (`user` is null for a visitor), their `provider:id` (what goes in `ADMIN_IDS`; null for a visitor), and which providers are set up. |
| GET | `/api/auth/:provider/start` | `google` or `discord`: redirects to the provider; 404 if it isn't set up. |
| GET | `/api/auth/:provider/callback` | The provider's redirect back (`<PUBLIC_URL>/api/auth/:provider/callback`). Sets the session cookie, then redirects to `/`, or to `/login?error=` if it fails. |
| POST | `/api/auth/logout` | Ends the session. |
| PATCH | `/api/auth/me` | Change your own handle (`{ username }`, 3 to 24 letters, digits or underscores). |
| GET | `/api/users` | Admin: list users. |
| PATCH/DELETE | `/api/users/:id` | Admin: change `role` or `banned`, or remove a user. Not your own account. |
| GET/PUT | `/api/settings` | Home area, extra areas, remotes policy, feed URLs. PUT is admin-only; members and visitors get the cut-down read. |
| GET | `/api/geocode?q=` | Nominatim search, cached. |
| GET | `/api/version` | Build info. |
| GET/POST | `/api/places` | List (visibility-filtered) / create. |
| GET/PATCH/DELETE | `/api/places/:id` | |
| GET/POST | `/api/spots` | `?bbox=s,w,n,e`, `?near=lat,lng&radiusKm=`, `?placeId=`. |
| GET/PATCH/DELETE | `/api/spots/:id` | `goodTimes` is validated: phases, months, days, conditions, event keywords, avoid, notes. |
| POST | `/api/spots/:id/photos` | Multipart `photo` + `thumb` (already resized in the browser); checked by magic bytes, capped at 15MB. EXIF focal length and timestamp preserved in photo row. |
| GET | `/api/photos/:id/file`, `/api/photos/:id/thumb` | Auth-checked against the parent spot's visibility. |
| GET | `/api/spots/:id/photos` | The spot's photos. |
| PATCH/DELETE | `/api/photos/:id` | PATCH takes `caption` and `kind`. |
| POST | `/api/import` | A GeoJSON FeatureCollection of places/spots; upserts by `source`+`sourceRef` when both are given. |
| GET | `/api/export.geojson`, `/api/export.gpx` | Your own places/spots/sightings, or waypoints. |
| GET/POST | `/api/shares` | List / create a share link (returns a token). |
| DELETE | `/api/shares/:token` | Revoke. |
| GET | `/api/share/:token` | The bundle the token grants — no login needed, the token is the credential. |
| GET/POST | `/api/remotes` | Admin: list / add a remote instance's share URL. |
| DELETE | `/api/remotes/:id` | Admin. |
| POST | `/api/remotes/:id/sync` | Admin: fetch and upsert now, instead of waiting for the daily task. |
| GET | `/api/tasks` | Admin: background task status and log. |
| POST | `/api/tasks/:name/run` | Admin: run a task now. |

Remotes are SSRF-guarded: http(s) only, private/loopback/link-local addresses blocked unless `allowPrivateRemotes` is set (for LAN setups).

## Live feeds and ingestion

Same auth rules as above: all of these need a session unless marked open.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/planes?lat=&lng=&nm=` | adsb.lol/airplanes.live aircraft near a point, cached 10s server-side. |
| GET | `/api/planes/:hex/info?callsign=` | Lazy aircraft and route enrichment (adsbdb.com), cached in-memory. |
| GET | `/api/rail` | Cached OSM rail network + nearby industrial/mine sites, GeoJSON. |
| GET/POST | `/api/sightings` | Freight/coal train sightings. `?near=lat,lng&radiusKm=` or `?bbox=`. POST snaps to the nearest cached rail line. |
| GET/PATCH/DELETE | `/api/sightings/:id` | |
| GET | `/api/spots/:id/freight` | "Freight usually passes" pattern from nearby sightings. |
| GET | `/api/trains?at=` | Predicted passenger train positions at a time (needs `TFNSW_API_KEY`). |
| GET | `/api/spots/:id/trains?hours=` | Next scheduled passes within ~2km of the spot. |
| GET | `/api/trains/status` | Whether a key is set, last static import, trip count. |
| GET | `/api/spots/:id/nearby`, `/api/places/:id/nearby` | Nearby Event Scout events (7 days, keyword-flagged) and venue busyness. |
| GET | `/api/events` | Open to visitors. Upcoming events from Event Scout (needs `EVENT_SCOUT_URL` or the Settings URL; an empty list without), see below. |
| GET | `/api/events/:group` | Open to visitors. One event from that list, same shape; 404 if it isn't on it. |
| PUT | `/api/events/:group/state` | Your own star and hide on an event. Body `{ starred?: boolean, hidden?: boolean }`, at least one; a field left out keeps its value. Replies `{ group, starred, hidden }`. 400 for anything else or a `group` over 100 characters, 404 for an event not on the list. |
| GET | `/api/candidates?bbox=` | OSM candidate points of interest. |
| POST | `/api/candidates/:id/promote` | Turn a candidate into a spot. |
| GET | `/api/spots/:id/commons` | Wikimedia Commons photos near the spot (cached 1 day) and lens advisor stats (`{ images, stats }`). |
| GET | `/api/fires` | Open to visitors. NSW RFS major incidents (fires), cached 5 min. |
| GET | `/api/aurora` | Open to visitors. NOAA planetary K-index (now + next 24h max), cached 30 min. |
| GET | `/api/marine?lat=&lng=` | Open-Meteo marine tides and swell for coastal spots, cached per 0.05° cell for 1 h. |
| GET | `/api/cameras` | NSW live traffic cameras (TfNSW, needs `TFNSW_API_KEY`), cached 10 min. |
| GET | `/api/cameras/:id/image` | Proxy live JPEG for a traffic camera. |

### Events

`GET /api/events` answers with a bare array, soonest first, of:

```json
{
  "group": "m3f9a…", "title": "…", "description": "…", "startTime": "2030-01-05T09:00:00.000Z", "endTime": null,
  "venueName": "…", "address": "…", "locality": "…", "lat": -33.4, "lng": 149.5, "imageUrl": "https://…",
  "category": "…", "priceText": "…", "isOnline": false, "dateOnly": false, "photoScore": 55,
  "series": "…", "url": "https://…", "starred": false, "hidden": false
}
```

- It is event-scout's list with what that service has hidden or culled removed, cut down to these fields: no raw listing text, no per-source addresses (`url` is one http(s) link), and `imageUrl` is an https picture or `""`. `description` is cut at 1500 characters. `lat` and `lng` are null when the event has no position. `series` is shared by the dates of a repeating event.
- `starred` and `hidden` are the caller's own, from `user_event_state`; always false for a visitor. event-scout's own star and hide are not used.
- The upstream list is cached in memory for 60 seconds and shared by every caller, so listing costs event-scout one request a minute at most. If it can't be reached the last list is served; with none yet, 502. Unset, `[]`.

- When the engine holds a copy of an event's flyer, `imageUrl` is that copy (`/api/flyer/<day>/<name>`) rather than the scraped address, which can stop answering.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/flyer/:day/:name` | Open to visitors. A flyer the engine has stored, read-only, for an event that is on the list; a hidden or culled event's flyer, one that belongs to no event, and any name or day that is not a shape the store writes (`YYYY-MM-DD` or `undated`, 16 hex characters and a known image extension) are 404 without touching the disk. The type is from a fixed list (never sniffed), with `nosniff`, `Content-Disposition: inline` and a sandboxing CSP. |
| GET | `/api/calendar-link` | Whether you have a calendar link: `{ exists, createdAt }`. The token cannot be read back. |
| POST | `/api/calendar-link` | Make a link, or a new one that replaces the old (which stops working at once). Replies `201 { token, url }`; the only time the token is shown. Only its SHA-256 is stored. |
| DELETE | `/api/calendar-link` | Turn your link off. |
| GET | `/api/calendar/:token.ics` | Open; the token is the credential. The public events plus public community events, minus the ones you have hidden, as `text/calendar`. `?starred=1` narrows it to your shortlist. Any token that is not live (wrong, replaced, turned off, or its owner suspended or deleted) is a 404. Suspending someone deletes their link for good. |

### Admin event screens

`/api/events-admin/*` is the events engine's own API, admin only (401 without a session, 403 for anyone else). The Settings tabs and the Events page use these:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/events-admin/photo` | Shooting conditions: golden and blue hour, sky and moon for today and tomorrow (Conditions tab). |
| GET | `/api/events-admin/density/areas` | Tracked areas with venue counts (Places and Busy map tabs). |
| GET | `/api/events-admin/density/:area/venues` | Every venue with its latest reading and shoot verdict. |
| GET | `/api/events-admin/density/:area/history?venue=&days=` | One venue's weekly profile, measured readings and best windows. |
| GET | `/api/events-admin/density/:area?hours=&all=1&hour=` | The area's density grid as GeoJSON; 404 when nothing was observed in the window. |
| GET | `/api/events-admin/events`, `/events/:group` | The engine's whole upcoming list, hidden events included, and one event with its listings and the fields edited by hand. |
| PATCH | `/api/events-admin/events/:group` | Edit by hand: `title, description, startTime, venueName, address, category, priceText, imageUrl, photoScore`; a field sent as `null` or `""` drops the override. The id changes if the title or date does. |
| POST | `/api/events-admin/merge` | `{ groups: string[], parent? }`, at least two. `/unmerge/:group` splits a merge; `/events/:group/parent` `{ id }` picks the listing that speaks for it. |
| POST | `/api/events-admin/groups/:group` | `{ hidden }`: take an event off every list for everybody, or put it back. |
| POST | `/api/events-admin/archive` | Archive events that have been and gone. |

After any write here the kept public list is dropped, so the change shows on the next read instead of within a minute.

### Feed, chat and reports

Bodies are plain text; the server never stores or returns markup.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/feed?scope=all\|following&before=<iso>` | Open to visitors for `all`; `following` needs a session. 30 per page, newest first. Items: `id, kind, created_at, author{username,avatar}, body, place_name, lat, lng, link, votes, comments, voted`. Hidden posts and posts by suspended accounts are left out. `kind` is `checkin`, or an auto-post (`ride`, `gear`, `rsvp`, `event`) the server makes when a ride or gear is added, someone RSVPs to, or someone creates, a public community event. Deleting the thing deletes the post. |
| POST | `/api/checkins` | `{ spotId }` (public spot), `{ eventId }` (public community event) or `{ lat, lng, placeName<=120 }`, plus optional `body<=500`. 30 a day. |
| DELETE | `/api/posts/:id` | Author or staff. |
| PUT/DELETE | `/api/posts/:id/vote` | Upvote / take it back. Replies `{ votes, voted }`. |
| GET/POST | `/api/posts/:id/comments` | List (open to visitors) / add `{ body<=500 }`; 200 a day. |
| DELETE | `/api/comments/:id` | Author or staff. |
| GET | `/api/chat?after=<iso>` | Session needed. Up to 100 messages from the last 30 minutes, oldest first. |
| POST | `/api/chat` | `{ body<=300 }`; 10 a minute. Messages are deleted after 30 minutes (the `housekeeping` task, and reads ignore older ones anyway). |
| DELETE | `/api/chat/:id` | Author or staff. |
| POST | `/api/reports` | `{ targetKind: post\|comment\|chat\|community_event\|profile\|ride\|spot, targetId, reason<=300 }`. 409 if you already have an open report on it; 20 a day. |
| GET | `/api/reports` | Staff: open reports oldest first, then recently settled, each with a text snapshot and the author. |
| POST | `/api/reports/:id/resolve` | Staff: `{ action: dismiss\|hide }`. `hide` hides a post, comment or community event (hidden events 404 for everyone but the organiser and staff) and deletes a chat line; for a profile, ride or spot it only settles the report. |

### Suggested spots

A signed-in user can suggest a public spot; it waits for a moderator and is not on the map until approved.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/suggestions` | `{ name<=120, notes<=1000, lat, lng }`. 400 for a bad body, 429 past 10 a day or 20 waiting. |
| GET | `/api/suggestions` | Staff: waiting suggestions oldest first, then recently settled. |
| POST | `/api/suggestions/:id/resolve` | Staff: `{ action: approve\|reject }`. Approving makes a public spot owned by the suggester and replies `{ ok, spotId }`. 409 if already settled. |
