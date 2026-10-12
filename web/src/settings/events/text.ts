/** An href for a URL that came from scraped data: the URL itself when it is http(s), else undefined so the anchor stays inert. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
