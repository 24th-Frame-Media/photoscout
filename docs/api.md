# API

Everything follows `INSTANCE_MODE` (see the README), apart from first-run setup and share-token reads.

## Core

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/status` | Whether setup is needed, who's signed in, whether sign-up is open. |
| POST | `/api/auth/setup` | First run only: create the admin. |
| POST | `/api/auth/signup` | Create a contributor account, if the admin allowed it. |
| POST | `/api/auth/login` / `/api/auth/logout` | Session cookie. |
| GET/POST | `/api/users` | Admin: list / create users. |
| PATCH/DELETE | `/api/users/:id` | Admin: change role or password, or remove a user. |
| GET/PUT | `/api/settings` | Home area, extra areas, sign-up toggle, remotes policy, feed URLs. PUT is admin-only. |
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
| GET/POST | `/api/remotes` | List / add a remote instance's share URL. |
| DELETE | `/api/remotes/:id` | |
| POST | `/api/remotes/:id/sync` | Fetch and upsert now, instead of waiting for the daily task. |
| GET | `/api/tasks` | Background task status and log. |
| POST | `/api/tasks/:name/run` | Admin: run a task now. |

Remotes are SSRF-guarded: http(s) only, private/loopback/link-local addresses blocked unless `allowPrivateRemotes` is set (for LAN setups).

## Live feeds and ingestion

Same auth rules as above.

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
| GET | `/api/eventscout/test?url=` | Admin: try reaching an Event Scout URL. |
| GET | `/api/candidates?bbox=` | OSM candidate points of interest. |
| POST | `/api/candidates/:id/promote` | Turn a candidate into a spot. |
| GET | `/api/spots/:id/commons` | Wikimedia Commons photos near the spot (cached 1 day) and lens advisor stats (`{ images, stats }`). |
| GET | `/api/fires` | NSW RFS major incidents (fires), cached 5 min. |
| GET | `/api/aurora` | NOAA planetary K-index (now + next 24h max), cached 30 min. |
| GET | `/api/marine?lat=&lng=` | Open-Meteo marine tides and swell for coastal spots, cached per 0.05° cell for 1 h. |
| GET | `/api/cameras` | NSW live traffic cameras (TfNSW, needs `TFNSW_API_KEY`), cached 10 min. |
| GET | `/api/cameras/:id/image` | Proxy live JPEG for a traffic camera. |

