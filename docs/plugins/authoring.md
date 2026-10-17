# Writing a PhotoScout plugin

A plugin adds to PhotoScout without changing the core app: a server half (routes, a database, background tasks), a web half (map layers, legend toggles, panels, Settings tabs), or both. This guide is written so an agent can follow it step by step. The contracts it cites are `@photoscout/plugin-sdk/web` (web) and `@photoscout/plugin-sdk/server` (server), in `packages/plugin-sdk/`; the manifest rules are in `server/src/plugins/manifest.ts` and `docs/plugins/plugin.schema.json`.

## For agents (start here)

Run these from the repository root. `<name>` is your folder name.

```sh
cp -r docs/plugins/template plugins/<name>        # 1. scaffold
# 2. edit plugins/<name>/plugin.json (change "id"!), src/server.ts, src/web.ts
npm run plugin:validate -- plugins/<name>         # 3. check: repeat until it passes
npm run plugin:build -- plugins/<name>            # 4. build plugins/<name>/dist/<id>-<version>.zip
```

Add `--json` after the folder for machine-readable output: `[{ dir, ok, id, version, errors: [{ file, path, message }], warnings, zip }]`.

Reading the output:

- `error plugin.json /<path>: <message>`: the field at that JSON pointer is wrong. `/settings/0/default` is the default of the first setting. Fix it and re-run.
- `error plugin.json: host check: <message>`: the host's own parser rejected it (for example a `photoscout` range the host cannot meet). The message is the host's wording.
- `warning plugin.json /<key>: is not a known field`: the host ignores it. Remove it or fix the spelling.
- `error plugin.json /server: "server.js" is not in the folder, and there is no src/server.ts to build it from`: create the source file the message names.
- `error build: ...`: the bundle failed. esbuild messages carry `file:line:col`. `must default-export an object with an activate() function` means the entry does not export `{ activate }` as its default.
- Exit status: `0` the plugin is OK; `1` it has errors or the build failed; `2` bad usage.

Order of checks: schema errors come first, and the host's own checks (version range, duplicate setting keys, select defaults) run only once the schema passes. So a second run can show new errors after the first are fixed. Done means `plugin:build` exits `0` and prints the zip path.

Two rules an agent is most likely to break: the `id` must be unique (change it from the template's `com.example.hello-places`), and a web bundle must import types only (`import type`), never code from the app.

## What a plugin is

A plugin is a zip **package** with `plugin.json` at its root. Next to it come the files the manifest names: a server entry (`server.js`), a web bundle (`web.js`), an icon, and an optional `assets/` folder. The package is limited to 50 MB, 2000 files, no symbolic links, no encryption and no zip64.

- **Server half** (`server`): an ES module, loaded in-process by the server with full trust. It mounts routes under `/api/plugins/<id>/`, opens its own SQLite file, and can register background tasks. It must be self-contained: the host copies it to a `.mjs` file and imports that.
- **Web half** (`web`): an ES module served unauthenticated at `/plugins/<id>/<version>/web.js`. The SPA imports it once per page load and calls `activate(host)`. It runs with full trust in the SPA origin.

Install sources (`PluginSource` in `server/src/plugins/store.ts`):

| Source | How it arrives | Notes |
|---|---|---|
| `bundled` | zips shipped with the app, installed at startup | from `plugins/*` in the repository, or `/app/bundled-plugins` in the image. The admin's choices win over an upgrade. |
| `upload` | an admin uploads a zip | Settings, Plugins, "Upload plugin"; API `POST /api/admin/plugins/upload`, multipart field `package`. Installing a version that is already installed is refused (409): bump `version`. |
| `dev` | an unpacked folder, when `PHOTOSCOUT_PLUGIN_DEV=1` | see "Install for local testing". |

There is no separate "repository" source in this tree. `bundled.ts` mentions one, but `PluginSource` has only these three values.

## Step by step

### 1. Scaffold

Copy `docs/plugins/template` to `plugins/<name>/`. The template has `plugin.json`, `src/server.ts`, `src/web.ts`, `src/sdk/` (copies of the two contracts, types only), `build.mjs` and a README. It needs no `package.json`: the repository's CLI bundles it with the repository's esbuild.

### The contract and its copies

The contract is one package, `@photoscout/plugin-sdk` (`packages/plugin-sdk/`). Its web half is `src/web.ts` (`WebPlugin`, `PluginHost`, `WEB_API_VERSION`) and its server half is `src/server.ts` (`ServerPlugin`, `PluginContext`, the manifest types, `HOST_API_VERSION`). The app reads the same code through `web/src/plugins/api.ts` and `server/src/plugins/types.ts`, which only re-export it.

- **Inside this repository**, import from the package: `import type { WebPlugin } from '@photoscout/plugin-sdk/web'` (or `/server`). The workspace link resolves it, and the root build and typecheck build it first. Radio Garden does this.
- **Outside it** (a plugin repository that cannot use the workspace), vendor the contract: copy `docs/plugins/template/src/sdk/` into the plugin. Each copy is the SDK file byte for byte, behind one header line that names the SDK version. Check the copies against a clone of this repository (run `npm ci` in the clone first, because the CLI imports esbuild and fflate):

  ```sh
  node /path/to/photoscout/scripts/plugin.mjs sdk-check <plugin folder> --sdk /path/to/photoscout
  ```

  The check exits 1 and names the line when a copy has drifted, or when it records another SDK version. On a version bump, re-vendor with the same command plus `--write`. Line endings do not count.
- **In this repository**, the test suite checks that the template's copies match the SDK (`packages/plugin-sdk/test/sdk.test.ts`). After changing the SDK, run `npm run plugin:sdk-check -- docs/plugins/template --write` and commit the copies with it.

### 2. Manifest (`plugin.json`)

The schema is `docs/plugins/plugin.schema.json`. You may add `"$schema": "<relative path to it>"` for editor hints; the host ignores that field.

| Field | Required | Rules |
|---|---|---|
| `id` | yes | reverse-DNS: at least two dot-separated parts of lowercase letters, digits and hyphens, up to 100 characters. Example `media.example.waze`. Must be unique. |
| `name` | yes | 1 to 60 characters |
| `version` | yes | plain semver: `1.2.3` or `1.2.3-beta.1`. No leading `v`, no `+build`. |
| `description` | yes | one sentence (not empty) |
| `author` | yes | not empty |
| `category` | yes | `map`, `feed`, `events`, `ai` or `tools` |
| `photoscout` | yes | a semver range of the host plugin API, e.g. `^1.0`. The host provides `1.0.0`. |
| `server` | no | a `.js` path in the package, e.g. `server.js` |
| `web` | no | a `.js` or `.mjs` path in the package, e.g. `web.js` |
| `icon` | no | a path in the package |
| `homepage` | no | a string shown to the admin |
| `permissions` | no | `[{ "kind": ..., "detail": ... }]`. Kinds: `network`, `secrets`, `realtime`, `llm`, `tasks`, `storage`. Shown to the admin; not enforced in the browser. The one the server does act on is `network` with a `detail` of `host` or `host:port` (see `ctx.fetch`). |
| `services` | no | named external services; see "Services" below |
| `settings` | no | fields the admin fills in on the plugin's settings page; see below |
| `public` | no | route patterns a signed-out visitor may GET or HEAD, relative to the plugin: `"/places"`, `"/stations/*"` (`*` matches any run of characters, slashes included; at most 4 per pattern). Every other route needs a signed-in session. |

Settings fields: `key` (a letter, then letters, digits or underscores; not `constructor`, `prototype`, `__proto__`, `toString`, `valueOf` or `hasOwnProperty`), `type` (`string`, `secret`, `url`, `number`, `boolean` or `select`), `label`, and optional `help`, `required` and `default`. `number` takes `min` and `max`. `select` takes `options: [{ "value", "label" }]` (non-empty), and its `default` must be one of the values. The settings API reports whether a `secret` is set, never its value.

### 3. Server entry (`src/server.ts`)

Export `definePlugin`-shaped default: an object with `activate(ctx)` (and optional `deactivate()`), typed `ServerPlugin` from `@photoscout/plugin-sdk/server`. Everything `ctx` gives you:

- `ctx.router`: an Express router mounted at `/api/plugins/<id>/`. Register routes with `ctx.router.get(path, handler)`.
- `ctx.auth.requireUser(req, res)` and `ctx.auth.requireAdmin(req, res)`: each returns `false` and sends the error response when the check fails. Use them on routes that need a session.
- `ctx.settings.get()` returns the admin's settings; `ctx.settings.onChange(fn)` is called when they change.
- `ctx.tasks.register({ id, name, description?, intervalMinutes, run(log) })`: `intervalMinutes: null` for a task run only by hand; `run` resolves to `{ ok, message }`.
- `ctx.fetch(url, init?)`: public internet only. Private and loopback addresses are refused, and every redirect is checked. To reach one private host (a local model server, a sidecar), declare it: `"permissions": [{ "kind": "network", "detail": "127.0.0.1:11434" }]`. Only that exact host is allowed, and only that port if you give one (no port: any port on that host); a redirect hop is allowed if it is public or another declared host. `detail` is a bare host or `host:port` (no scheme or path; an IP or hostname written in plain lower-case form, IPv6 as `[::1]`); `*.example.com` is accepted for documentation but opens nothing. Every other address stays public-only.
- `ctx.db`: the plugin's own SQLite database (`data/plugins/<id>/data/plugin.db`). Never the core database.
- `ctx.dataDir`: the plugin's data folder.
- `ctx.log.info|warn|error(msg)`.
- `ctx.services.url(name)`: the URL the admin set for that service, or `null`.
- `ctx.areas()`: the instance's configured Areas, home first and then the others in the order the admin set them, each as `{ name, lat, lng, radiusKm }` (`PluginArea`; the events and busy switches are left out). Read-only: the result is a frozen copy, and changing it changes nothing in core. Current at call time, so a poll that calls it again sees Areas the admin has changed since. `[]` if they cannot be read. Host `1.2.0` added it, so a plugin that calls it declares `"photoscout": "^1.2"`.

### 4. Web bundle (`src/web.ts`)

Export a plain object typed `WebPlugin` (from `@photoscout/plugin-sdk/web`, or its copy `src/sdk/web-api.ts`): `{ activate(host) }`. The bundle imports types only, so it needs no runtime code from the app. (`definePlugin` is an identity function; using it is optional.)

`activate` runs once per page load. Register everything synchronously if you can; the host waits at most 10 seconds for it. If `activate` throws, everything it registered is rolled back. Layers and sources belong to the map: add them inside `host.map.onReady`, which runs once per map page, after its style loads, and again for each later page. Its cleanup runs when that map is removed.

What to register, with the API you call:

- **A map layer behind a legend toggle.** `host.legend.add({ key, label, swatch, defaultOn?, layers })` returns an entry with `on`, `setOn`, `toggle`, `onChange(cb)` and `syncLayers()`. The host shows and hides the ids in `layers` with the toggle. Inside `onReady`, add the source and the layer with the raw maplibre `map`. Use `host.map.scopedId('name')` for every id, so plugins cannot collide.
- **A poll.** `host.data.poll({ map, while: entry, refreshOnMove, fetch, onData, onError?, onStop? })` runs now, then every 30 seconds, only while `entry` is on and the tab is visible, and never more than once per 5 seconds. `fetch` receives `{ signal, bounds }`; pass the `signal` to `host.data.json`. It returns `{ refresh, stop }`.
- **A click.** `host.map.onClick([layerIds], (e) => ...)` gives `e.lngLat`, `e.features` and `e.layerId`. `host.map.showPopup(lngLat, text)` shows a popup (text, never HTML).
- **A side panel.** `host.panel.addSide<T>({ id, label, render })` returns `{ isOpen, open(data), close() }`. The host draws the frame; `render(el, { data, close, size, toggleSize })` draws inside it. At most one side panel is open.
- **A Settings tab.** `host.settings.addTab({ id, label, group?, admin?, render })`. Tabs are for admins by default (`admin: false` opens them to everyone). `render(el, { isAdmin })`.
- **Other slots.** `host.panel.addCorner({ id, whileOn?, render })` for a widget in the map's bottom-right corner; `host.drive.addAlertSource({ id, label, filter?, defaultOn?, runs?, title?, tuning?, start })` for Drive alerts (below).
- **Data.** `host.data.json<T>(path, init)` and `host.data.fetch(path, init)` reach only `/api/plugins/<id>/…`. `json` throws with a `status` on a non-2xx answer. `host.assetUrl(path)` gives the URL of a file in `assets/`.
- **Feedback.** `host.log.*` goes to the console. `host.activity(message, level?)` shows a line in the Activity panel; keep it short, with no URLs, tokens or response bodies.

**Drive sources.** A source feeds the Drive screen while a drive is on: `start(ctx)` runs when a drive begins (and again when the driver turns the source back on), and its cleanup runs when the drive ends or the driver turns it off. The `ctx` (see `DriveSourceContext` in `api.ts`) gives:

- `fix()`: the car's GPS fix as `{ point, accuracyM, ageMs }`, or null before the first fix. Decide your own staleness from these.
- `route()` (the route line, or null), `heading()` (degrees, or null until the car moves).
- `routeAhead(point)`: metres along the route to `point` when it is on the road ahead, else null. Its window is the source's `tuning` (defaults: 1500 m ahead, 45 m off the road, the car within 100 m of the route).
- `report(alerts)`: the banner shows the nearest alert that passes the source's `filter`. `'route-ahead'` uses `routeAhead`; `'nearby'` (the default) uses a straight line within `tuning.nearbyM` (default 800 m).
- `setStatus({ state, text })` for a line under the banner (`waiting`, `checking`, `stale`, `error`; `ok` or `null` shows nothing).
- `speak(text, { key })` for the Drive voice. It returns `{ spoken: true }` or `{ spoken: false, reason }`, so check `spoken`: the object is always truthy. The host mutes it with the Voice button, holds it back for a stale or loose fix (`tuning.speakMaxAgeMs`, `tuning.speakMaxAccuracyM`), and says each `key` once per drive. What to say and when is yours.
- Pins on the Drive map: draw with `ctx.map` using `ctx.scopedId('name')` ids, and declare the layers with `ctx.mapLayers(ids, { onTap })`. A tap on a declared layer goes to `onTap` and never picks a destination.
- Images: `ctx.addImage(name, image)` returns the id for an `icon-image`; `ctx.removeImage(name)` removes one. Both are cleaned up when the source stops.
- `showPopup(at, content)`: a popup on the Drive map, as `host.map.showPopup` on the main map. One per source; a map click or the source stopping closes it.

Tune a source's rules with `tuning` on its definition. Every option is optional and defaults to the host's rule; an unknown name or an out-of-range value throws:

```ts
tuning: { nearbyM: 1500, speakMaxAccuracyM: 40 } // a wider banner radius; speak only on a tight fix
```

The options are `nearbyM` (800, 1–10 000), `onRouteM` (100, 1–1 000), `aheadM` (1500, 1–20 000), `offRoadM` (45, 1–500), `speakMaxAgeMs` (10 000, 1 000–60 000) and `speakMaxAccuracyM` (75, 1–500).

The driver gets an on/off button per source, "`<label>` on/off", on by default unless `defaultOn: false`. A source runs during a drive by default; `runs: 'always'` starts it with the Drive map instead, so its pins show while the driver plans (its banner and speech still wait for a drive).

```ts
host.drive.addAlertSource({
  id: 'police',
  label: 'Police',
  filter: 'route-ahead',
  start(ctx) {
    const timer = setInterval(async () => {
      const fix = ctx.fix();
      if (!fix) return;
      const reports = await host.data.json<DriveAlert[]>('/reports'); // your own feed
      const ahead = reports
        .flatMap((r) => { const d = ctx.routeAhead(r.point); return d === null ? [] : [{ r, d }]; })
        .sort((a, b) => a.d - b.d);
      ctx.report(ahead.map((x) => x.r));
      const next = ahead[0];
      if (next && next.d <= 800) ctx.speak(`${next.r.title} ahead`, { key: next.r.id });
    }, 30_000);
    return () => clearInterval(timer);
  },
});
```

Ids you choose (legend `key`, tab `id`, panel `id`) use lowercase letters, digits and hyphens. Every callback the host calls is wrapped: a throw is logged and does not break the app or other plugins.

### 5. Build

```sh
npm run plugin:build -- plugins/<name>
```

The build runs the validation, then:

- bundles `src/server.ts` into `server.js` (platform node, ES module, everything inlined);
- bundles `src/web.ts` into `web.js` (browser, ES module, everything inlined);
- copies the icon and `assets/`;
- loads each bundle and checks that its default export has `activate`;
- writes `dist/<id>-<version>.zip` and reads that zip back with the host's own manifest check.

The build does not type-check. To type-check, add a `tsconfig.json` next to the plugin:

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM"], "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": ["src/server.ts", "src/web.ts"]
}
```

then run `npx tsc -p plugins/<name>/tsconfig.json` from the repository root. It needs the repository's `@types/geojson`, `maplibre-gl`, `@types/react`, `@types/express` and `@types/node`, all present at the root today. The template passes this check.

### 6. Validate

```sh
npm run plugin:validate -- plugins/<name>
```

Validation writes nothing. It runs the schema, then the host's own `parseManifest` (bundled from `server/src/plugins/manifest.ts`, so it cannot drift), then checks that the named files exist or can be built from `src/`.

### 7. Install for local testing

Two ways.

**Dev folder (fastest iteration).** Set `PHOTOSCOUT_PLUGIN_DEV=1` and put the plugin's *built* files in `<data>/plugins-dev/<id>/`, where `<data>` is the server's data folder (the parent of `plugins/`). Unzip the built zip there (`plugin.json` and `server.js`/`web.js` must sit at the folder root, not in `src/`). The folder name must equal the plugin id, or it is skipped. The server reloads the plugin when `server.js` or `plugin.json` changes; a change to `web.js` is not watched, so reload the page to see it.

**Upload (what production does).** Sign in as an admin, open Settings, Plugins, "Upload plugin", and choose `dist/<id>-<version>.zip`. Or call `POST /api/admin/plugins/upload` with an admin session and a multipart field `package`.

Check it by opening the Settings tab, toggling the legend entry, and watching the Activity panel and the browser console (lines are prefixed with the plugin id).

## Worked example

The template is a complete plugin. These are its three files, shown in full. The web bundle exercises a legend toggle with a layer, a poll that runs only while the toggle is on, a click that opens a popup and a side panel, and a Settings tab. The server half serves two places, filtered by an optional bounding box.

`plugin.json`:

```json
{
  "id": "com.example.hello-places",
  "name": "Hello places",
  "version": "0.1.0",
  "description": "Two sample places on the map behind a legend toggle. A starting point for a new plugin.",
  "author": "Your name",
  "category": "map",
  "photoscout": "^1.0",
  "server": "server.js",
  "web": "web.js",
  "public": ["/places"]
}
```

`src/server.ts`:

```ts
import type { ServerPlugin } from './sdk/server-api.js';

/** Sample data. A real plugin fetches from its source, caches in ctx.db and filters by the bbox. */
const PLACES = [
  { id: 'castle', title: 'Edinburgh Castle', point: [-3.1999, 55.9486] },
  { id: 'palace', title: 'Holyrood Palace', point: [-3.1721, 55.9525] },
];

const plugin: ServerPlugin = {
  activate(ctx) {
    // GET /api/plugins/com.example.hello-places/places?bbox=minLng,minLat,maxLng,maxLat
    // The bbox is optional; without a usable one, every place is returned.
    ctx.router.get('/places', (req, res) => {
      const bbox = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(Number) : [];
      const usable = bbox.length === 4 && bbox.every(Number.isFinite);
      const inside = (p: { point: number[] }) =>
        !usable || (p.point[0] >= bbox[0] && p.point[1] >= bbox[1] && p.point[0] <= bbox[2] && p.point[1] <= bbox[3]);
      res.json({ places: PLACES.filter(inside) });
    });
    ctx.log.info(`serving ${PLACES.length} sample places`);
  },
};

export default plugin;
```

`src/web.ts`:

```ts
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource } from 'maplibre-gl';
import type { PluginHost, WebPlugin } from './sdk/web-api.js';

interface Place {
  id: string;
  title: string;
  point: [number, number];
}

interface PlacesReply {
  places: Place[];
}

const toCollection = (places: readonly Place[]): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: places.map((p): Feature<Point> => ({
    type: 'Feature',
    properties: { id: p.id, title: p.title },
    geometry: { type: 'Point', coordinates: p.point },
  })),
});

// The bundle imports types only, so it needs no runtime code from the app.
const plugin: WebPlugin = {
  activate(host: PluginHost) {
    const source = host.map.scopedId('places');
    const points = host.map.scopedId('points');
    const byId = new Map<string, Place>();

    // 1. A legend toggle. The host shows and hides `points` with it.
    const toggle = host.legend.add({
      key: 'places',
      label: 'Hello places',
      swatch: { kind: 'dot', color: '#10b981' },
      defaultOn: true,
      layers: [points],
    });

    // 2. The source, the layer and a poll, once per map page. The poll runs only while the toggle is on.
    host.map.onReady((map) => {
      const sourceOf = () => map.getSource(source) as GeoJSONSource | undefined;
      map.addSource(source, { type: 'geojson', data: toCollection([]) });
      map.addLayer({
        id: points,
        type: 'circle',
        source,
        layout: { visibility: toggle.on ? 'visible' : 'none' },
        paint: { 'circle-radius': 7, 'circle-color': '#10b981' },
      });
      const poll = host.data.poll<PlacesReply>({
        map,
        while: toggle,
        refreshOnMove: true,
        fetch: ({ signal, bounds }) => {
          const bbox = bounds ? `?bbox=${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}` : '';
          return host.data.json<PlacesReply>(`/places${bbox}`, { signal });
        },
        onData: ({ places }) => {
          byId.clear();
          for (const p of places) byId.set(p.id, p);
          sourceOf()?.setData(toCollection(places));
        },
        onError: () => host.activity('Hello places did not load', 'error'),
        onStop: () => sourceOf()?.setData(toCollection([])),
      });
      return () => poll.stop();
    });

    // 3. A side panel with the details, opened by a click on a point. A popup shows the title.
    const details = host.panel.addSide<Place>({
      id: 'details',
      label: 'Place details',
      render: (el, { data, close }) => {
        el.replaceChildren();
        const title = document.createElement('h2');
        title.textContent = data.title;
        const done = document.createElement('button');
        done.textContent = 'Close';
        done.addEventListener('click', close);
        el.append(title, done);
      },
    });
    host.map.onClick([points], (e) => {
      const place = byId.get(String(e.features[0]?.properties?.id));
      if (!place) return;
      host.map.showPopup(e.lngLat, place.title);
      details.open(place);
    });

    // 4. A Settings tab. Only admins see it, the default.
    host.settings.addTab({
      id: 'about',
      label: 'Hello places',
      render: (el, { isAdmin }) => {
        el.textContent = isAdmin ? 'Hello places: admin view.' : 'Hello places.';
      },
    });
  },
};

export default plugin;
```

## Trust model and security rules

- **Server half: full trust.** It runs in the server process. Use `ctx.fetch` for outside calls (it refuses private addresses) and `ctx.db` for storage; do not open the core database.
- **Web half: full trust in the SPA origin.** It can read the DOM, use `localStorage`, call any `/api` route with the visitor's session (so an admin's bundle acts as that admin), and reach the raw maplibre map and React. The API is a contract for cooperating plugins, not a sandbox.
- **Bundles are public, so no secrets in them.** `/plugins/<id>/<version>/web.js` and `assets/` are served without sign-in, even on a private instance. Never put API keys, tokens or private URLs in `web.ts`, in `assets/`, or in `plugin.json`. Keep keys in a `secret` setting, read on the server.
- **Route access.** Only the `public` patterns are open to signed-out visitors, and only for GET and HEAD. Every other route needs a session: check it with `ctx.auth.requireUser` or `requireAdmin`.
- **Data calls from the web bundle stay on the plugin's routes.** `host.data` refuses paths that leave `/api/plugins/<id>/`. Do not fetch third-party hosts from the bundle; have the server route make the call. The CSP still allows `connect-src https:`, so a bundle can send data anywhere it can reach: do not add code that sends user data out.
- **Permissions are mostly a declaration.** `permissions` tell the admin what the plugin says it needs. Nothing enforces them in the browser, and the server polices none of them except `network` with a host: that widens `ctx.fetch` to that one host (even if private) and nothing else. Treat it as the admin approving that host.
- **Logs and messages.** Never put URLs, tokens or response bodies in `host.activity` messages.

## Services

`services` declares named external services. The admin sets a URL for each one; the host stores it under the setting `service:<name>:url`, and `ctx.services.url(name)` returns it or `null`. The host parses the other service fields (`image`, `port`, `health`, `memory`, `cpus`, `env`, `volumes`, `devices`) and stores them, but nothing in `server/src/plugins` starts a container from them in this tree. Treat them as declarations until a runner exists.

## Schema vs host

`plugin.schema.json` follows the host's `parseManifest`. Where the two differ, this is the full list. The CLI runs the schema and then the host check, so it reports every row.

| Case | Schema | Host | CLI |
|---|---|---|---|
| `photoscout` range the host (1.2.0) cannot meet | accepts | rejects | rejects (host check) |
| duplicate setting `key` | accepts | rejects | rejects (host check) |
| select `default` not among its `options` | accepts | rejects | rejects (host check) |
| empty `description`, `author`, setting `label`, or service `image` | rejects | accepts | rejects |
| `null` for an optional field (`server`, `web`, `icon`, `homepage`, …) | rejects | accepts, as if absent | rejects |
| a non-string entry in `services[].volumes` | rejects | silently drops the whole list | rejects |
| an unknown top-level field | accepts | ignores | warns |
| `.mjs` for `web` | accepts | accepts | accepts |
| `.mjs` for `server` | rejects | rejects | rejects |

The web bundle may be `.js` or `.mjs`: the manifest, the schema (`webFile`) and the SPA loader (`isBundlePath`) all accept both, and the server serves both as JavaScript. The server entry is `.js` only, because the host copies it to a `.mjs` file and imports that copy. A `.mjs` web bundle needs `photoscout` `^1.1` or later (the 1.0 host refused it); `web.js` still works everywhere.

## Limits at a glance

- Package: 50 MB, 2000 files, no symbolic links, no encryption, no zip64.
- The server file is loaded as a copy named `server-<n>.mjs`; keep it self-contained.
- The web bundle must default-export an object with `activate`; the loader fails the plugin otherwise.
- A web bundle whose `activate` throws, rejects or takes more than 10 seconds is marked failed and rolled back.
