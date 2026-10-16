# Web plugin API: design note

Status: first cut, for review. The contract is `web/src/plugins/api.ts` (read it: it is the documentation, with doc comments on every member). This note covers the shape, the lifecycle, how contributions reach the UI, the trust model and what is still open.

## Files

| File | Role |
|---|---|
| `web/src/plugins/api.ts` | The contract: `PluginHost`, `definePlugin`, every contribution type. Self-contained (types of `maplibre-gl`, `react`, `geojson` only); moves into `@photoscout/plugin-sdk` unchanged. |
| `web/src/plugins/registry.ts` | `PluginRegistry`: builds the `host` for each plugin, owns all contributions, publishes an immutable snapshot, binds to the live map. No DOM needed at import, so it is unit-tested in Node. |
| `web/src/plugins/loader.ts` | `loadWebPlugins()`: `GET /api/plugins-web`, validate, `import()`, `activate`. Never throws. |
| `web/src/plugins/poll.ts` | `host.data.poll`: a poll cadence without React. |
| `web/src/plugins/react.tsx` | `usePluginRegistry`, `PluginView` (render-fn or component slot), `PluginCornerPanels`, `PluginSidePanel`, `legendCategory`. |
| `web/src/plugins/DriveAlerts.tsx` | The Drive slot as drawn: the banner, status lines and the per-source on/off buttons. |
| `web/src/plugins/driveRunner.ts` | `DriveRunner`: starts and stops each drive source, gives it its `DriveSourceContext`, owns its alerts, status, speech gate and pins. Framework-free. |
| `web/src/plugins/routeAhead.ts` | `routeAheadM`: the "on the road ahead" rule for one point (1500 m ahead, 45 m off the road, the car within 100 m of the route). |
| `web/src/plugins/nearestAlert.ts` | The banner's pick: the nearest alert per source filter (`nearby` or `route-ahead`). |
| `web/src/settings/tabs.ts` | Core tabs + `groupsWith(pluginTabs)` + `tabFromHash(hash, pluginTabIds)`. |
| `web/test/pluginHost.test.ts`, `web/test/fixtures/example-plugin/web.ts` | The proof: a real bundle (typed against `api.ts`) loaded through the real loader and registry. |

Integration points touched: `App.tsx` (load + current user), `MapPage.tsx` (attach map, merge legend/menus, corner + side panel slots), `components/Legend.tsx` (`extra` rows), `pages/Settings.tsx` (merged groups, plugin tab slot), `pages/Drive.tsx` (one line).

## The shape

A web bundle is an ES module whose default export is `definePlugin({ activate(host), deactivate?() })`. An object rather than a bare function so it mirrors the server's `definePlugin({ activate, deactivate })` and can grow fields without breaking bundles.

```ts
export default definePlugin({
  activate(host) {
    const places = host.legend.add({
      key: 'places', label: 'Stations', swatch: { kind: 'dot', color: '#10b981' },
      layers: [host.map.scopedId('points')],            // the host shows/hides these with the toggle
    });
    host.map.onReady((map) => {                         // once per map page, after style load
      map.addSource(host.map.scopedId('src'), { type: 'geojson', data: EMPTY });
      map.addLayer({ id: host.map.scopedId('points'), type: 'circle', source: host.map.scopedId('src'),
        layout: { visibility: places.on ? 'visible' : 'none' }, paint: { 'circle-radius': 6 } });
      const poll = host.data.poll({ map, while: places, refreshOnMove: true,       // only while the toggle is on
        fetch: ({ signal, bounds }) => host.data.json('/places?bbox=...', { signal }),
        onData: (d) => (map.getSource(host.map.scopedId('src')) as GeoJSONSource).setData(toGeoJson(d)),
        onStop: () => clear(map) });
      return () => poll.stop();                         // cleanup when that map is removed
    });
    host.map.onClick([host.map.scopedId('points')], (e) => host.map.showPopup(e.lngLat, 'Hello'));
    host.settings.addTab({ id: 'main', label: 'Stations', group: 'Map', render: (el, { isAdmin }) => { /* draw into el */ } });
  },
});
```

`PluginHost` (abridged; the full interface with docs is in `api.ts`):

```ts
interface PluginHost {
  readonly id, name, version, apiVersion: string;
  readonly user: PluginUser | null;                       // getter; changes on sign-in/out
  readonly map: {
    readonly current: MapLibreMap | null;
    onReady(cb: (map) => void | (() => void)): Unsubscribe;
    scopedId(name: string): string;                       // "<pluginId>:<name>"
    onClick(layers: readonly string[], cb: (e: PluginMapClick) => void): Unsubscribe;
    showPopup(at: LngLat, content: string | HTMLElement): PopupHandle;   // string => text, never HTML
  };
  readonly legend: { add(def: LegendEntryDef): LegendEntry };           // toggle + layers + onChange
  readonly settings: { addTab(def: SettingsTabDef): Unsubscribe };
  readonly panel: {
    addCorner(def: CornerPanelDef): Unsubscribe;                         // widget in the map's bottom-right corner
    addSide<T>(def: SidePanelDef<T>): SidePanelHandle<T>;                // details panel; open(data)/close()
  };
  readonly drive: { addAlertSource(def: DriveAlertSourceDef): Unsubscribe };
  readonly data: { url, fetch, json, poll };                            // scoped to /api/plugins/<id>/
  assetUrl(path: string): string;                                       // /plugins/<id>/<version>/assets/<path>
  readonly ui: { readonly react: typeof React };
  readonly log: { info, warn, error };                                  // console only
  activity(message: string, level?): void;                              // the Activity panel
}
```

Views (settings tab, corner widget, side panel) are a `ViewSpec<P>`: either `render(el, props) => cleanup?` (framework-free) or `component` (a React component built with `host.ui.react`, rendered by the host's React so hooks work).

## Lifecycle

1. **Discover.** `App` calls `loadWebPlugins()` once it knows whether the visitor may read anything (`authed || publicReads`). Memoised per page, so StrictMode's double effect is harmless.
2. **Import.** Each entry from `/api/plugins-web` is shape-checked, its `web` path is checked (below), then `import(url)`, 15 s limit. Bundles load in parallel; the app does not wait for them.
3. **Activate.** `default.activate(host)` with a host bound to that plugin, 10 s limit. Contributions register synchronously into the registry and the snapshot updates as they arrive. If `activate` throws, rejects or times out, everything it contributed is rolled back and the plugin is recorded as failed. (`deactivate` is not called for a plugin whose `activate` failed.)
4. **Map attach.** `MapPage` calls `registry.attachMap({ map, isInteractive, createPopup })` after `style.load`. The registry runs every `onReady` callback (a plugin that activates later gets it on activation), then applies each legend entry's `layers` visibility, and installs one `click` router. On detach (page unmount, StrictMode re-run) the `onReady` cleanups run and the plugin's `<id>:` layers/sources are removed, so a re-attach to the same map starts clean.
5. **Dispose.** `registry.dispose(id)` (tests, future hot reload): polls stopped, contributions removed, `<id>:` layers/sources taken off the live map, then `deactivate()`.

## How contributions reach the UI

- **Legend + toolbar.** `legend.add` produces a `LegendItem` with global key `<pluginId>:<key>`. `MapPage` merges these into the Legend (`extra` categories via `legendCategory`, so `Swatch` and the rows are unchanged) and into the existing `MapMenus` "Live"/"Scout" lists. The plugin toggle state lives in the registry (persisted in its own key `ls.plugins.legend`, only explicit choices, so a default can still change). `MapPage`'s own `vis`/`FEED_KEYS`/`loadVisibility` are untouched; the Legend receives `{...vis, ...pluginVis}` and `toggleAny` routes by key. This is additive: core entries still come from `CATEGORIES`.
- **Layers.** The host sets `visibility` on `LegendEntryDef.layers` on attach, on every toggle, and on `entry.syncLayers()`. Anything stronger (declaring layers) was rejected as too big a surface: the plugin has the real `Map`.
- **Click.** One host click router per map; it queries each registration's existing layers (`queryRenderedFeatures`), so hidden layers do not fire. Ignored while `MapPage` is drawing/picking (`isInteractive`). A click that hits no plugin layer closes the open plugin side panel. This is independent of `MapPage`'s own click handler, so ordering does not matter.
- **Settings.** `groupsWith` appends plugin tabs to the core "Map"/"Events" groups, or a "Plugins" group above "Admin". Tab ids are `<pluginId>:<id>` and double as the URL hash. `Settings.tsx` keeps the *requested* hash and resolves it against the tabs that exist now, showing "Loading plugins…" while a plugin-style hash is still unknown. Tabs are admin-only unless `admin: false`.
- **Panels.** Corner widgets render in `.mapcorner` while their legend entry is on. A side panel is drawn in the host's `.panel` frame (grab handle, close, sheet size); one is open at a time. Opening one clears the selection and counts toward `mapshell--panel`; selecting a spot/route or starting an editor closes it.
- **Drive (wired in 1.1.0).** `Drive.tsx` gives one `DriveRunner` per map and syncs it with the drive phase and the registry. A source that is on runs while a drive is on (`runs: 'drive'`, the default), or from the moment the Drive map is ready (`runs: 'always'`, so its pins show while planning). Its cleanup runs when it stops: the drive ends, the driver turns it off, or the screen closes. Turning it on again starts it again. The banner shows only while driving; status lines show in any phase; speech is said only while driving.
  - *Banner.* The nearest alert that passes the source's `filter`: `nearby` (1.0 behaviour: within 800 m, straight line) or `route-ahead` (core's rule via `ctx.routeAhead`: the car within 100 m of the route, the point on the road ahead, at most 1500 m along, at most 45 m off the road; nothing without a route). A `route-ahead` answer reads "ahead", a `nearby` one "away".
  - *Route and heading.* `ctx.route()` (the route line, or null) and `ctx.heading()` (degrees, or null until the car has moved at about 5 km/h). Both are getters, read live.
  - *Voice.* `ctx.speak(text, { key? })` goes through the Drive voice, so the Voice button mutes it. The host gates it: voice on, a GPS fix at most 10 s old and at most 75 m loose (core's report-warning rule), and a `key` is said once per drive. What to say and when is the source's call; core's "nearest report within 800 m, once per alert" is the pattern.
  - *On/off.* A button per source, "`<label>` on/off", `defaultOn` at the start, state kept in the registry (`setDriveSourceOn`). Like core's "Reports on/off".
  - *Status.* `ctx.setStatus({ state, text })` under the banner: `waiting`, `checking`, `stale`, `error` show their text (errors in red); `ok` shows nothing, the same as `null`.
  - *Map pins.* `ctx.map` is the Drive map. Ids come from `ctx.scopedId(name)` (`<pluginId>:<sourceId>:<name>`): the host removes every layer and source with that prefix when the source stops. `ctx.mapLayers(ids, { onTap })` declares the pin layers; a tap that lands on one goes to `onTap` and never picks a destination . Images are not removed.
  - The Waze feed now runs entirely in its own plugin (a separate repo). Its type list and time window are source rules, so they live with the plugin.
- **Data.** `data.fetch/json` are confined to `/api/plugins/<id>/…`: the path must start with a single `/` and may contain no `.`/`..` segment (also percent-encoded), backslash, `#` or control characters. `json` throws an error with `.status` and the server's message. `poll` runs immediately, then every 30 s, paused while the tab is hidden, 5 s minimum gap, newer request aborts the older one, late answers dropped, optional `retryAfterMs` for "server is still scanning", optional re-poll 600 ms after the map moves, stops if the map is removed.

## Failure and private-mode behaviour

- `/api/plugins-web` 401/403 (private instance, nobody signed in): quiet, nothing loaded, `phase` becomes `ready`, a later call may retry. `App` does not even ask until the visitor may read.
- Network error or non-OK list: console warning (+ Activity warning for non-OK); the app carries on without plugins.
- A bad row in the list is skipped. A bundle that 404s, does not parse, has no default export, or whose `activate` throws or hangs: logged to the console, recorded in `snapshot.plugins` as `failed`, and shown in the Activity panel under "Plugins". Other plugins are unaffected.
- Every plugin-supplied callback the host invokes (`onReady`, `onClick`, legend `onChange`, poll callbacks, drive `start`) runs in a try/catch; a throw is logged and the Activity panel gets one grouped error under the plugin's name. View renders are guarded by an error boundary (components) or try/catch (render functions); a failed view shows a one-line placeholder.

## Trust model

A web bundle is **fully trusted code running in the SPA origin**. It can read and change the DOM, use `localStorage`, call any `/api` route with the visitor's session cookie (so with an admin looking at the page, it can act as that admin), and it receives the raw `maplibre` `Map` and the host's React. The API is a contract for cooperating plugins, not a sandbox; `scopedId`, the confined `data` helpers and the validators prevent accidents and cross-plugin collisions, not malice.

What makes that acceptable, and what is enforced:

- Installing a plugin is an admin-only action (`/api/admin/plugins/upload`) and a plugin's server half already runs in-process with full trust. The web half adds no new class of authority.
- The server serves only the running version's declared `web` file, icon and `assets/`, with fixed file types, `nosniff`, immutable cache keyed by version.
- CSP (`script-src 'self'`) means a bundle cannot load third-party script or `eval`, but `connect-src https:` still lets it send data anywhere.
- SPA-side checks: list rows must have a valid id/version; the `web` path must be exactly `/plugins/<id>/<version>/<file>.js|.mjs` (no scheme, host, `..`, query, hidden file), so the loader never imports another origin or another plugin's file; the module must default-export `{ activate }`; ids are lowercase `[a-z0-9-]` and namespaced; swatch colours reject `url(`; string popups use `setText`; Activity messages are capped; use after disposal throws.
- Not enforced: that a plugin only touches its own layers or routes (raw `Map`, raw `fetch`); that it stays inside the permissions its manifest declares (those are for the admin to read, not for the browser to police). Server side, a `network` permission with a `host[:port]` detail is the one that is enforced: it lets that plugin's `ctx.fetch` reach that exact host even if private; every other address stays public-only.

## Decisions I want confirmed

1. **`definePlugin({ activate })`, not a bare `register` function** (parity with the server API; room to grow).
2. **Raw `Map` in `onReady` as well as helpers**, rather than only a declarative layer API. Chosen for power and so Waze/radio port 1:1; costs enforceability.
3. **Framework-free `render(el, props)` as the primary view contract, `component` via `host.ui.react` as the alternative.** Avoids bundles shipping or externalising React.
4. **Plugin legend state lives in the registry, not in `MapPage.vis`.** Zero change to the core toggle code; plugin toggles also work off the map page. Cost: two stores merged at render.
5. **Global keys `<pluginId>:<id>`** for legend entries and tab ids (ids contain dots; hashes like `#media.24thframe.radio-garden:stations`).
6. **Settings tabs default to `admin: true`**, and plugins may not add to the "You" or "Admin" groups.
7. **A click on empty map closes plugin side panels** (matches radio today), and plugin clicks are suppressed in editing modes.
8. **The host draws the side-panel frame**, so `RadioPanel` must be split into frame + content when migrated.
9. **Plugin toggles go into the "Live"/"Scout" toolbar menus via `menu`**; no way yet to add a new menu.
10. **`/api/plugins-web` left as is** (`{id, version, name, web}`). Adding `category` and `icon` would let the loader pick a default Settings group and show plugin icons; not needed yet.

## Open questions

- `/plugins/<id>/<version>/*` is served without authentication even on a private instance (it is outside `/api`). Bundles must therefore contain no secrets. Gate it on private instances?
- A published SDK: `api.ts` is ready to lift; `typeof React` and the maplibre/geojson types would become peer type dependencies.
- Hot reload / disable-without-reload: the registry supports `dispose`, but the page loads bundles once. The admin enabling a plugin needs a reload today.
- Basemap style change (`setStyle`) would drop plugin layers; the map never does that today. If it starts, re-run `onReady`.
- Drive: the 1.1 contract covers what core Waze's Drive mode did (route-ahead, heading, speech, status, a per-source toggle, pins with taps), which is what let Waze move out of core into a plugin. Drive has its own `Map`, which `map.onReady` does not cover (only the map page); Drive sources therefore draw through `ctx.map`, not `onReady`.
- Versions: `WEB_API_VERSION` (`api.ts`, what `host.apiVersion` reports) is 1.1.0. The server's `HOST_API_VERSION` (`server/src/plugins/types.ts`, what a manifest's `photoscout` range is checked against) is a separate constant and is still 1.0.0. The two are not tied together yet.
- Capability gating: should `host.data` refuse plugins whose manifest lacks a permission, or should the manifest `public` list be mirrored client side to avoid pointless 401s for visitors?
- Cross-plugin interaction (radio widget in the corner while another plugin's panel is open) is unspecified beyond "one side panel at a time".
- i18n, theming tokens for plugin UI, and a CSS story for render-function views (today: use the existing global classes).

## For the follow-on agents

- **Migration (radio-garden, then Waze).** Radio is done: `plugins/radio-garden/src/web.ts` (+ `src/web/`), built to `web.js` by `plugins/radio-garden/build.mjs`, proven by `web/test/radioPlugin.test.ts`. It mapped as below, except that the player widget is a `panel.addCorner` with no `whileOn` (it must outlive the toggle) that renders nothing while idle (`.plugincorner:empty` is hidden in `styles.css`). Radio maps to: `legend.add({ key: 'radio', menu: 'live', layers: [...] })` (replace `RADIO_COLOR`/category `radio`, the `radio` entry in `MapMenus`, `FEED_KEYS`, the `radioOn` effect), `onReady` (source with clustering + 3 layers), `onClick` (cluster expansion zoom; point → `panel.addSide`), `data.json('/places')` fetched once on first toggle-on via `entry.onChange` (no poll), and `RadioPanel` as the side-panel view. The radio widget/audio controller needs a home: `panel.addCorner` plus plugin-module state. Waze is done too: its core code is gone and it runs as its own plugin. It mapped to `onReady` + `data.poll({ while, refreshOnMove: true, retryAfterMs })`, `onClick` popup, a corner panel for the heatmap window, a settings tab, and `drive.addAlertSource`, which the 1.1 Drive contract now covers.
- **Docs.** Quote `api.ts` doc comments rather than rewriting them; the example plugin in `web/test/fixtures/example-plugin/web.ts` is typechecked by `tsc` (the `test` dir is in `tsconfig.json`) and exercised by `pluginHost.test.ts`, so it is safe to copy from.
