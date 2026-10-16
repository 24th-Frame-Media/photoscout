# Hello places: plugin template

A minimal PhotoScout plugin. It has a public `/places` route on the server, a map layer behind a legend toggle that polls that route, a click popup with a details panel, and a Settings tab. The full guide is `docs/plugins/authoring.md`.

## Use it

1. Copy this folder into the repo, for example `plugins/<your-name>/`.
2. In `plugin.json`, change `id` (reverse-DNS and unique, e.g. `media.example.my-plugin`), `name`, `author` and `description`.
3. Edit `src/server.ts` and `src/web.ts`.
4. From the repository root, check and build:

   ```sh
   npm run plugin:validate -- plugins/<your-name>
   npm run plugin:build -- plugins/<your-name>
   ```

   The build writes `plugins/<your-name>/dist/<id>-<version>.zip`. `node build.mjs` in the folder does the same build.

## Files

- `plugin.json`: the manifest. Checked against `docs/plugins/plugin.schema.json`.
- `src/server.ts`: the server entry, a `ServerPlugin` (`src/sdk/server-api.ts`).
- `src/web.ts`: the web bundle, a `WebPlugin` (`src/sdk/web-api.ts`).
- `src/sdk/`: verbatim copies of the contract in `packages/plugin-sdk/src/` (`@photoscout/plugin-sdk`), each behind a one-line header that names the SDK version. They hold types only. A repository plugin can drop this folder and import `@photoscout/plugin-sdk/web` or `/server` instead. A copy outside the repository is checked with `plugin.mjs sdk-check <folder> --sdk <clone>`, and re-copied with `--write` on a version bump (`docs/plugins/authoring.md`, "The contract and its copies").
- `build.mjs`: runs the repository's plugin CLI (`scripts/plugin.mjs build`).

No `package.json` is needed: the CLI bundles with the repository's esbuild.
