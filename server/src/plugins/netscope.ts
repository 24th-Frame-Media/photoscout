import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { assertPublicUrl, BlockedHostError, publicFetch, publicLookup } from '../events/nethost.js';
import { pinnedFetch } from '../events/shared/pinnedFetch.js';
import { parseNetworkDetail, type NetworkTarget } from './manifest.js';
import type { PluginManifest } from './types.js';

/**
 * The network a plugin's ctx.fetch may reach.
 *
 * Everyone gets the public internet only (events/nethost publicFetch). A plugin
 * that declares `{ kind: 'network', detail: '<host>' | '<host>:<port>' }` also
 * gets that exact host, even when it is private or loopback: the way a plugin
 * talks to a service on the same machine or LAN (a local model server, a
 * sidecar container). Nothing else is widened:
 *
 *  - Exact match on the host as URL normalises it, and on the port when the
 *    declaration has one. "*.example.com" wildcards are informational and
 *    never open anything.
 *  - Redirects are followed by hand and every hop is judged on its own: a hop to
 *    a declared host is allowed, any other hop must be public.
 *  - Each request is made through a lookup the socket itself uses, so the
 *    address that is checked is the address that is dialled.
 */

const MAX_HOPS = 5;
/** Headers that must not follow a redirect to another origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export type Send = (url: string, init: RequestInit, lookup: LookupFunction) => Promise<Response>;

export interface PluginFetchDeps {
  /** Public-only fetch, used as it is when the plugin declares no usable network host. */
  publicFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** One request, no redirects, connecting through `lookup`. Default: pinnedFetch. */
  send?: Send;
}

/** The exact (non-wildcard) hosts a manifest opens up. A detail that does not parse opens nothing. */
export function declaredHosts(manifest: Pick<PluginManifest, 'permissions'>): NetworkTarget[] {
  const out: NetworkTarget[] = [];
  for (const p of manifest.permissions ?? []) {
    if (p.kind !== 'network' || p.detail === undefined) continue;
    const target = parseNetworkDetail(p.detail);
    if (target && !target.wildcard) out.push(target);
  }
  return out;
}

function effectivePort(url: URL): number {
  return url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

/** Whether `url` is one of the declared hosts: same hostname, and same port when one was declared. */
export function hostDeclared(targets: readonly NetworkTarget[], url: URL): boolean {
  const port = effectivePort(url);
  return targets.some((t) => t.host === url.hostname && (t.port === null || t.port === port));
}

/** The lookup for a declared host: whatever the name resolves to, which the socket then dials. */
const declaredLookup = dnsLookup as unknown as LookupFunction;

export function createPluginFetch(
  manifest: Pick<PluginManifest, 'permissions'>,
  deps: PluginFetchDeps = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const pub = deps.publicFetch ?? publicFetch;
  const targets = declaredHosts(manifest);
  if (targets.length === 0) return pub; // no network permission: exactly the public-only fetch
  const send: Send = deps.send ?? pinnedFetch;

  return async (url, init = {}) => {
    let target = url;
    let current: RequestInit = init;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        throw new BlockedHostError('not a URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BlockedHostError(`refusing ${parsed.protocol.replace(':', '')} URL`);
      }
      target = parsed.href;

      let res: Response;
      if (hostDeclared(targets, parsed)) {
        res = await send(target, current, declaredLookup);
      } else {
        await assertPublicUrl(target);
        res = await send(target, current, publicLookup as LookupFunction);
      }

      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) {
        if (!res.url) Object.defineProperty(res, 'url', { value: target });
        return res;
      }
      await res.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new BlockedHostError('bad redirect');
      }
      if (next.origin !== parsed.origin && current.headers) {
        const headers = new Headers(current.headers);
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        current = { ...current, headers };
      }
      target = next.toString();
    }
    throw new BlockedHostError('too many redirects');
  };
}
