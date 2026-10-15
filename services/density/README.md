# Venue density

The browser, discovery, sampling, grid, scoring and storage implementation lives here. This npm workspace builds to `dist` before the API builds or starts.

PhotoScout currently runs density tasks inside its events scheduler. `server/src/events/densityHost.ts` supplies the existing events database, settings, solar calculations and guarded network functions. The small re-export modules in the server retain its API and test imports. This move does not create a second database or a second browser scheduler.

Run `npm run build -w @photoscout/density` after editing this package. The root build, dev, typecheck and test commands do this automatically. Behaviour tests remain under `server/test/events` so they exercise the server integration with its actual database schema.
