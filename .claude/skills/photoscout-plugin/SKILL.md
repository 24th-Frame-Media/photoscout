---
name: photoscout-plugin
description: Use when creating, building, or validating a PhotoScout plugin, such as scaffolding a new plugin from the starter, adding server routes, web map layers, legend toggles, side panels or Drive alert sources, writing its plugin.json, or packaging its zip with the plugin CLI.
---

# Build a PhotoScout plugin

Take a plugin from nothing to a validated `dist/<id>-<version>.zip`, with tests. The long guide is [authoring.md](../../../docs/plugins/authoring.md). This skill is the short path through it.

## Read the live source, not this file

The API and field lists change between releases. Read these every time you need a detail:

| Need | Source of truth |
|---|---|
| Starter to copy | [docs/plugins/template/](../../../docs/plugins/template/) |
| Manifest fields | [plugin.schema.json](../../../docs/plugins/plugin.schema.json), then the host's own check in `server/src/plugins/manifest.ts` (the CLI runs both) |
| Server half: what `activate(ctx)` gets | [server/src/plugins/types.ts](../../../server/src/plugins/types.ts) |
| Web half: what `activate(host)` gets | [web/src/plugins/api.ts](../../../web/src/plugins/api.ts), whose doc comments are the documentation |
| The contract itself | `@photoscout/plugin-sdk` (in `packages/plugin-sdk/`): `src/web.ts` (web API) and `src/server.ts` (server API), re-exported by `web/src/plugins/api.ts` and `server/src/plugins/types.ts` |
| API versions | `WEB_API_VERSION` and `HOST_API_VERSION`, both re-exported from the SDK (the browser and server contracts; not tied together) |
| Validate and build | [scripts/plugin.mjs](../../../scripts/plugin.mjs), and the `plugin:validate` and `plugin:build` scripts in the root `package.json` |
| Worked examples | `plugins/radio-garden/` and the Waze plugin (see Examples) |

In-repo plugins (`plugins/<name>/`) `import type` the contract straight from `@photoscout/plugin-sdk/web` and `/server` — no copies. A plugin in its **own** repo can't use the workspace, so it vendors the two files in `src/sdk/` (start from `docs/plugins/template/src/sdk/`). Those copies drift, so before you build, run the drift-check instead of a manual diff — it maps `src/sdk/web-api.ts`→SDK `src/web.ts` and `src/sdk/server-api.ts`→SDK `src/server.ts`, ignores the header and line endings, and re-vendors with `--write`:

```sh
npm run plugin:sdk-check -- <dir>              # in a clone of this repo
node <photoscout>/scripts/plugin.mjs sdk-check <dir> --sdk <photoscout> --write   # external plugin repo
```

## Workflow

Run commands from the photoscout repo root. `<dir>` is the plugin folder, for example `plugins/<name>` in this repo. A plugin in its own repo works too: pass its folder to the CLI, as `node <photoscout>/scripts/plugin.mjs ...`.

1. **Scaffold.** `cp -r docs/plugins/template plugins/<name>`. Add a `package.json` only if you need npm packages. In this repo, a `package.json` under `plugins/*` becomes an npm workspace.

2. **Manifest (`plugin.json`).**
   - `id`: reverse-DNS and unique, like `media.example.my-plugin`. The template's `com.example.hello-places` must change. The CLI checks one folder at a time, so look for clashes yourself: `grep -h '"id"' plugins/*/plugin.json`.
   - `name`, `description` (one sentence), `author`, `category` (one of the schema's enum values).
   - `version`: plain semver. Bump it for every install: installing a version that is already installed is refused with 409.
   - `photoscout`: a semver range that includes the host's plugin API version. The CLI rejects a range the host cannot meet.
   - `server` and `web`: `.js` files at the package root, such as `server.js` and `web.js`. `.mjs` is refused.
   - `permissions`: a `network` entry, with `detail` set to `host` or `host:port`, for each private host the server calls. The other kinds are shown to the admin and not enforced.
   - `settings`: one entry per value an admin supplies. Use type `secret` for API keys.
   - `public`: route patterns a signed-out visitor may GET. Every other route needs a session.
   - Optional `"$schema": "<relative path to plugin.schema.json>"` for editor hints.

3. **Server half (`src/server.ts`).** Default-export an object with `activate(ctx)`, typed `ServerPlugin`. Routes go on `ctx.router`, which is mounted at `/api/plugins/<id>/`. Guard every non-public route with `ctx.auth.requireUser` or `ctx.auth.requireAdmin`. The other tools are `ctx.settings`, `ctx.tasks.register()` for background jobs, `ctx.fetch` for outside calls, `ctx.db` for the plugin's own SQLite (never the core database), `ctx.dataDir`, `ctx.log`, `ctx.services.url()` and `ctx.areas()` (the configured Areas, read-only; needs `"photoscout": "^1.2"`). The build inlines the bundle's imports (Node built-ins aside), so the zip needs nothing beside it.

4. **Web half (`src/web.ts`).** Default-export an object with `activate(host)`, typed `WebPlugin`. Import types only and never app code. Everything goes through `host`:
   - a legend toggle and its layers: `host.legend.add`;
   - map sources, layers and polls inside `host.map.onReady`, which runs once per map page and may return a cleanup. Use `host.map.scopedId()` for every id you create;
   - clicks and popups: `host.map.onClick` and `showPopup`;
   - a details panel or a corner widget: `host.panel.addSide` and `addCorner`;
   - a Settings tab: `host.settings.addTab`;
   - data: `host.data.json` and `host.data.poll`, which reach only your own routes;
   - Drive alerts: `host.drive.addAlertSource`.

   The exact members and their options are in `web/src/plugins/api.ts`. The build imports `web.js` in Node to check it, so keep top-level code free of `window` and `document`.

5. **Build.** `npm run plugin:build -- plugins/<name>`. It validates, bundles `src/server.ts` and `src/web.ts`, checks that each default export has `activate`, and writes `<dir>/dist/<id>-<version>.zip`. The template's own `node build.mjs` runs the same build, but only from inside the repo, because it searches parent folders for `scripts/plugin.mjs`.

6. **Validate (run it early and after each manifest change).** `npm run plugin:validate -- plugins/<name>`. Add `--json` for machine-readable output.
   - Exit codes: `0` OK, `1` errors or a failed build, `2` bad usage. Validation writes nothing.
   - Fix the path named on each `error plugin.json /<pointer>: ...` line, then run again. The host's own checks run only after the schema passes, so new errors can appear on the next run.
   - Done means `plugin:build` exits 0 and prints the zip path.
   - Optional type check: add a `tsconfig.json` (the config is in `docs/plugins/authoring.md`, section 5), then run `npx tsc -p <dir>/tsconfig.json`.

7. **Check the zip.** From the repo root:

   ```sh
   node -e "console.log(Object.keys(require('fflate').unzipSync(require('fs').readFileSync(process.argv[1]))).join('\n'))" <zip>
   ```

   Expect `plugin.json`, the `server` and `web` files the manifest names, the icon, and any `assets/` files. Nothing else: no `src/`, `test/`, `node_modules/`, `.env`, harvester code or APKs.

8. **Test with `node:test`.** Put tests in `<dir>/test/*.test.ts`. From the repo root, run `npx tsx --test "plugins/<name>/test/*.test.ts"`. A plugin folder with its own `package.json` can use `npm test`, as radio-garden and Waze do. Test the server half with a fake router and a context built from `plugin.json`, and the web half with a fake host. Add one test that runs the build and checks the zip's entries. Waze's `test/harness.ts`, `test/web-harness.ts` and `test/package.test.ts` show this pattern.

9. **Install and look.** Two ways, and `docs/plugins/authoring.md` section 7 has the details.
   - Dev folder: set `PHOTOSCOUT_PLUGIN_DEV=1`, then unzip the built zip into `<data>/plugins-dev/<id>/`, with `plugin.json` at its root. The folder name must equal the plugin id. Reload the page after changing `web.js`.
   - Upload: as an admin, use Settings, Plugins, Upload plugin, or `POST /api/admin/plugins/upload` with a multipart field named `package`.

   Then open the plugin's Settings tab, toggle its legend entry, and check the Activity panel and the browser console. Lines are prefixed with the plugin id.

10. **Ship (optional).** Attach the zip to a public GitHub release of the plugin's repo, then add a registry entry through a pull request to `kapsikkum/photoscout-plugins`. Its `CONTRIBUTING.md` covers the steps, and the reusable `publish-plugin.yml` workflow automates them.

## Done when

- `plugin:validate` exits 0, and `plugin:build` exits 0 and prints the zip path.
- The zip holds only the files listed in step 7.
- The tests pass.
- The `id` is unique and the `version` is new since the last install.
- No key, token, private URL or APK is in any file that goes into the zip.
- The local install shows the legend entry and its Activity line working.

## Security rules (state these when they apply)

- **Server half: full trust.** It runs in-process in PhotoScout's Node server, unsandboxed. Install only plugins whose code you have read or trust.
- **Web half: full trust in the app page.** It runs in the SPA origin, unsandboxed. It can read the DOM, use `localStorage`, call any `/api` route with the visitor's session (an admin's bundle acts as that admin), and reach the raw map and React. The API is a contract, not a sandbox.
- **Bundles are public.** `web.js` and `assets/` are served without sign-in, even on a private instance. Never put keys, tokens, private URLs or APKs in code, in assets or in `plugin.json`. Keys go in a `secret` setting, read on the server.
- **`ctx.fetch` reaches the public internet only.** Private and loopback addresses are refused unless a `network` permission names that exact host (and port, if one is given). Every redirect is checked. A wildcard detail opens nothing. The other permissions are declarations, not enforcement.
- **Install is admin-only.** Uploads and registry installs need an admin to confirm. The default registry takes changes only by reviewed pull request. Admins can add other https registries, so add only ones you trust.

## Examples

- **`plugins/radio-garden/`** (this repo, `media.24thframe.radio-garden`). It has a server half and a web half, is built by its own `build.mjs` and `package.json`, and imports host types from the repo rather than from copies. It shows: public read routes with a `*` pattern; `ctx.db` as a small key-value store; `ctx.fetch` to one declared outbound host; a legend toggle whose `onChange` fetches once, the first time it is switched on, with no poll; a clustered map source; a side panel for station lists; a corner widget built as a React component through the host; and `node:test` suites in `test/`.
- **`map.24thframe.waze`** (its own repo: <https://github.com/kapsikkum/photoscout-plugin-waze> — clone it next to this repo to study). This is the full pattern. It shows:
  - a separate Docker harvester (`harvester/`, kept out of the zip) that the plugin calls;
  - three `network` permissions for the harvester's addresses, with `ctx.fetch` wrapped so it reaches only those;
  - its API key as a `secret` setting, sent only to the declared host;
  - its own SQLite for police sightings, kept for sixty days;
  - an admin-only `POST /setup` route that runs the core's setup helper, which is not packaged;
  - `host.data.poll` feeds for the pins, the heatmap and Drive, with scoped ids;
  - a corner widget and a Settings tab;
  - a Drive alert source with `filter: 'route-ahead'`, and pins through `ctx.mapLayers`;
  - a package test that runs `build.mjs` and asserts the zip holds exactly `plugin.json`, `server.js` and `web.js`.

  The CLI validates it too, once cloned: `node scripts/plugin.mjs validate ../photoscout-plugin-waze`.

## Gotchas

- A web bundle imports types only (`import type`). Importing app code breaks it.
- `public` routes allow GET and HEAD only.
- If `activate` throws or hangs, everything it registered is rolled back and the plugin shows as failed. Register synchronously, and add sources and layers inside `onReady`, not in `activate`.
- Every map id goes through `scopedId`, so plugins cannot clash.
