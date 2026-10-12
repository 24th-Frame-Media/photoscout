import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A suggestion list for the gear form: brand, name and kind of camera bodies
 * and lenses, trimmed from the camera-gear-database project (CC0). It is
 * film-era gear only, so it helps with lenses more than with bodies; the form
 * stays free text and nothing here is required to match.
 */

export interface CatalogItem { brand: string; name: string; kind: 'camera' | 'lens' }

export const MAX_CATALOG_RESULTS = 20;

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data-static/gear-catalog.json');

let loaded: CatalogItem[] | null = null;
export function catalog(): CatalogItem[] {
  if (!loaded) {
    try {
      loaded = (JSON.parse(fs.readFileSync(file, 'utf8')) as [string, string, 'camera' | 'lens'][]).map(([brand, name, kind]) => ({ brand, name, kind }));
    } catch {
      loaded = [];
    }
  }
  return loaded;
}

/** Items whose name, or brand and name together, start with `q`; not case-sensitive, at most 20. */
export function searchCatalog(items: CatalogItem[], q: string): CatalogItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: CatalogItem[] = [];
  for (const item of items) {
    if (item.name.toLowerCase().startsWith(needle) || `${item.brand} ${item.name}`.toLowerCase().startsWith(needle)) {
      out.push(item);
      if (out.length === MAX_CATALOG_RESULTS) break;
    }
  }
  return out;
}
