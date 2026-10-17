/**
 * Hosts that block scrapers outright or never expose JSON-LD worth having, so
 * neither the crawler nor the web search should spend a request on them. Each
 * program adds its own reasons on top (search engines, ticketing sites with
 * their own adapters).
 */
export const BLOCKING_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'linkedin.com', 'pinterest.com', 'reddit.com',
  // Has its own dedicated source (server/src/sources/midnightspec.ts), which
  // reads its real dates; the generic crawler only ever mis-dated these.
  'midnightspec.com',
];
