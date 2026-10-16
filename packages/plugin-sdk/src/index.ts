/**
 * @photoscout/plugin-sdk: the plugin contract, in one place.
 *
 * `web` is the browser half (WebPlugin, PluginHost and the contribution types);
 * `server` is the Node half (ServerPlugin, PluginContext and the manifest types).
 * A plugin should import the half it needs from its subpath:
 *
 *   import type { WebPlugin } from '@photoscout/plugin-sdk/web';
 *   import type { ServerPlugin } from '@photoscout/plugin-sdk/server';
 *
 * The two version constants are also here, and so are both namespaces.
 * Both halves define `definePlugin`, so the namespaces keep them apart.
 */
export { WEB_API_VERSION } from './web.js';
export { HOST_API_VERSION } from './server.js';
export * as web from './web.js';
export * as server from './server.js';
