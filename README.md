# Location Scout

A self-hosted map of photography spots and when the light works at them.

![Mount Panorama in 3D on satellite at sunset](docs/screenshots/05-3d-mount-panorama.webp)

## What it does

- **Spots and places.** Save spots (a point, a facing direction, a field of view, notes, photos, "good times") grouped into places with outlines. GPS is read from uploaded photos, then stripped before they're stored.
- **Light on the map.** A time slider drives sun and moon position, golden and blue hour, terrain and building shadows, and sun/moon alignment with each spot's facing direction.
- **Plan shoot.** Pick a spot and a date range, tick what you're after (golden light, open shade, alignment, clear sky, trains…), and get ranked time windows. Drill into a day's light, shade and weather, preview the view from the spot, or find the exact dates the sun lines up with a bearing on a small interactive map.
- **Live feeds.** Planes overhead (adsb.lol), NSW passenger trains (TfNSW), a rail network layer with crowdsourced freight sightings, nearby events and crowds from [event-scout](../event-scout), Wikimedia Commons photos, and OpenStreetMap suggestions you can turn into spots.
- **Import, export, share.** KML/KMZ, GPX, GeoJSON, CSV and Google Takeout in; GeoJSON, GPX or a zip with photos out. Share links, and syncing spots from other instances.
- **Users.** Private (everything behind a login) or public (anonymous visitors see public spots). Admin, contributors, optional sign-up.

## Screenshots

| | |
|---|---|
| ![Map overview at sunset](docs/screenshots/01-map-overview.webp) Map at sunset, sun and moon rays | ![Spot panel](docs/screenshots/02-spot-panel.webp) A spot: facing wedge, photos, good times |
| ![Photo viewer](docs/screenshots/03-photo-viewer.webp) Photo viewer | ![Photo hover card](docs/screenshots/04-photo-markers.webp) Hover a spot for its photo |
| ![Capertee Valley in 3D](docs/screenshots/06-3d-capertee-valley.webp) 3D terrain, Capertee Valley | ![Live trains](docs/screenshots/07-trains.webp) Live and scheduled trains |
| ![Route](docs/screenshots/08-route.webp) A route | ![Traffic camera](docs/screenshots/09-traffic-camera.webp) Live traffic camera, 3D at night |
| ![Rain radar](docs/screenshots/10-weather.webp) Rain radar and cloud | ![Light pollution](docs/screenshots/11-light-pollution.webp) Light pollution |
| ![Plan shoot](docs/screenshots/12-plan-shoot.webp) Plan shoot: ranked windows | <img src="docs/screenshots/13-phone-spot.webp" alt="Phone layout" width="180"> Phone layout |
| ![Import and export](docs/screenshots/14-import-export.webp) Import, export, share | ![Settings](docs/screenshots/15-settings.webp) Settings |

## Run it

Needs Node 24.

```bash
npm install
npm run dev
```

Open http://localhost:5174 and create the admin account. The API runs on :3003 and Vite proxies `/api` to it.

With Docker, using the published image:

```bash
docker compose pull && docker compose up -d
```

Then open http://localhost:3003. Set `ADMIN_PASSWORD` before first boot to skip the setup screen.

> :3003 in dev serves the last `npm run build` of the web app, not your working copy. Use :5174 while developing.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `API_PORT` | `3003` | Server port. |
| `INSTANCE_MODE` | `private` | `private`: every route needs a login. `public`: anonymous visitors see public spots. |
| `ADMIN_PASSWORD` | — | Seeds user `admin` on first boot if no user exists. |
| `TRUST_PROXY` | — | Behind a reverse proxy: hops to trust `X-Forwarded-For` from. |
| `TFNSW_API_KEY` | — | TfNSW Open Data key, for passenger trains and live traffic cameras. |
| `EVENT_SCOUT_URL` | — | event-scout base URL, for nearby events and crowds. From a container, use a shared Docker network and its service name, or `http://host.docker.internal:<port>`. |
| `ADSB_URL` | `https://api.adsb.lol` | Planes feed; airplanes.live also works. |
| `OVERPASS_URL` | — | OpenStreetMap Overpass server to try first (rail, suggestions); public mirrors are tried after it. |
| `TZ` | `Australia/Sydney` | What counts as "today" and when daily tasks run. |

Any feed without its key or URL shows "not configured" instead of failing.

## How it works

```
server/   Express API, SQLite (node:sqlite), feeds and background tasks
  src/feeds/    planes, trains (GTFS static + realtime), freight, weather, event-scout
  src/sources/  OSM rail and candidates, Wikimedia Commons
  src/tasks/    scheduled background jobs (remote sync, feed imports)
web/      React 19 + Vite + MapLibre
  src/map/      layers, sun/moon maths, shadow workers, geometry helpers
  src/pages/    Map, Plan shoot, Settings, Import/Export
docs/     API reference and research notes
```

- **Sun and moon** positions use [suncalc](https://github.com/mourner/suncalc) in `web/src/map/sun.ts`, all client-side, so the time slider is instant.
- **Shadows** are one raster. Terrain shadows are ray-marched over elevation tiles (AWS Terrain Tiles) in a worker, and building footprints are drawn into the same mask so overlaps don't darken twice.
- **Remotes and shares.** A share link is a token that returns a GeoJSON bundle. Another instance adds it as a remote and syncs daily. Remote URLs are SSRF-guarded.
- **Trains.** Passenger trains come from TfNSW timetables plus realtime positions. Freight has no public feed ([why](docs/freight-schedule-research.md)), so it's built from logged sightings snapped to the rail network.

Full endpoint list: [docs/api.md](docs/api.md).

### Known limits

- Plane paths are projected 15 minutes by dead reckoning, so turning aircraft drift off.
- Freight prediction stops where a mapped stretch of track ends. It doesn't route across junctions.
- The sun-bearing wedges are approximate near the polar circles.

## Contributing

1. Branch off `master`.
2. Make the change, with a test for any non-trivial logic. Tests use `node:test` in `server/test` and `web/test`. Keep maths and geometry in pure functions so they can be tested without a browser.
3. Check before pushing:
   ```bash
   npm run typecheck
   npm test
   ```
4. Open a PR into `master`. Use [Conventional Commits](https://www.conventionalcommits.org) (`feat(web): …`, `fix(server): …`): release-please builds the changelog and version from them.

CI typechecks and tests every PR, and builds the Docker image. Merges to `master` publish `ghcr.io/kapsikkum/location-scout:latest`.
