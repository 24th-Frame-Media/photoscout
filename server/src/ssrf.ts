import dns from 'node:dns/promises';
import net from 'node:net';
import { isPrivateAddress } from './events/nethost.js';

/**
 * SSRF guard for remotes and share syncs: http(s) only, private/loopback/
 * link-local addresses blocked unless the operator opted in for a LAN setup.
 */

/** Pure classifier, so the IP ranges can be tested without a network. One list, shared with the event fetcher. */
export function isPrivateIp(ip: string): boolean {
  if (!net.isIP(ip)) return true; // not a recognisable IP at all: refuse rather than guess
  return isPrivateAddress(ip);
}

export class SsrfError extends Error {}

/**
 * Resolve `url`'s host and refuse it unless every address is public (or the
 * caller allows private ones, for a LAN remote). Returns the parsed URL.
 */
export async function assertPublicUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('Only http(s) URLs are allowed');
  if (allowPrivate) return url;

  // url.hostname keeps the brackets for an IPv6 literal ("[::1]"), which net.isIP rejects; strip them so an
  // IPv6 literal is classified directly instead of being sent to DNS (which fails, e.g. no IPv6 in CI).
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host) ? host : null;
  const addresses = literal ? [literal] : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
  if (addresses.length === 0) throw new SsrfError('Could not resolve host');
  for (const addr of addresses) {
    if (isPrivateIp(addr)) throw new SsrfError(`${url.hostname} resolves to a private address`);
  }
  return url;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

const MAX_REDIRECTS = 3;

/**
 * A guarded fetch: SSRF-checked, timed out, and capped in size.
 *
 * Redirects are followed by hand so each hop is checked like the first: left
 * to fetch, a public address answering "302, go to 169.254.169.254" walked
 * straight past the check.
 * ponytail: the address is checked and then looked up again by fetch, so a
 * host that changes its DNS answer in between still gets through. Pin the
 * resolved address with an undici dispatcher if remotes are ever opened to
 * non-admins; until then the container's egress rules are the backstop.
 */
export async function guardedFetch(rawUrl: string, allowPrivate = false): Promise<Buffer> {
  let url = await assertPublicUrl(rawUrl, allowPrivate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const location = res.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) throw new Error(`${url} redirected too many times`);
      url = await assertPublicUrl(new URL(location, url).toString(), allowPrivate);
      res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    }
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_FETCH_BYTES) throw new Error('Response too large');
    const reader = res.body?.getReader();
    if (!reader) return Buffer.from(await res.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_FETCH_BYTES) throw new Error('Response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
