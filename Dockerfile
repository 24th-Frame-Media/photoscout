# Node 24 for `node:sqlite`, which is what the database layer uses — there is
# no native module to build here, and it should stay that way.
FROM docker.io/library/node:24-slim AS build
WORKDIR /app

# Manifests first, so a change to source does not re-resolve the dependency tree.
# Every workspace's package.json (the crawler's included) has to be present for
# `npm ci` to plan the install.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY services/crawler/package.json services/crawler/package.json
COPY services/density/package.json services/density/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY plugins/radio-garden/package.json plugins/radio-garden/package.json
RUN npm ci

COPY . .
# npm nests a workspace's dependency under <workspace>/node_modules when the root
# already holds another major of it (server needs semver 7, the root tree has 6),
# so server/node_modules must ship too. mkdir keeps the COPY below valid when empty.
RUN npm run build && npm prune --omit=dev && mkdir -p server/node_modules


FROM docker.io/library/node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# tini reaps zombies: the server spawns nothing in this configuration, but
# PID 1 without a reaper is a trap worth staying out of.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
# The plugin contract (@photoscout/plugin-sdk): server/dist imports it at runtime
# for HOST_API_VERSION, and node_modules links to this folder.
COPY --from=build /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=build /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=build /app/services/density/package.json ./services/density/package.json
COPY --from=build /app/services/density/dist ./services/density/dist
# The gear suggestions the Kit form reads (gearCatalog.ts looks for them next to dist/).
COPY --from=build /app/server/data-static ./server/data-static
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/scripts/setup-waze.mjs ./scripts/setup-waze.mjs
COPY --from=build /app/services/waze-harvester ./services/waze-harvester
# Plugins that ship with the app, installed at startup (server/src/plugins/bundled.ts reads this folder).
COPY --from=build /app/plugins/*/dist/*.zip ./bundled-plugins/

# db.ts resolves its directory relative to the compiled server, so this is
# where the database and photos land. Mount it.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

# What this build is, for /api/version. The repo's .git is deliberately not in
# the build context, so the commit has to be handed in.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

USER node
EXPOSE 3003
ENV API_PORT=3003

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
