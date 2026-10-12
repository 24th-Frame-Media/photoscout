import type { Map as MlMap } from 'maplibre-gl';
import { updateRoads } from './layers';

/** Server grid: keep in sync with CELL_DEG in server/src/sources/roads.ts. */
const CELL_DEG = 0.05;
const MAX_ACTIVE = 3;
const MAX_CELLS = 60;
export type RoadsStatus = '' | 'loading' | 'failed';

interface State { cells: Map<string, GeoJSON.Feature[]>; queue: string[]; active: number; visible: Set<string> }
const states = new WeakMap<MlMap, State>();

/** Grid-cell keys ("south,west") covering the map view, nearest the centre first. */
export function visibleCells(map: MlMap): string[] {
  const b = map.getBounds(), c = map.getCenter();
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  const out: { key: string; d: number }[] = [];
  for (let s = Math.floor(b.getSouth() / CELL_DEG); s * CELL_DEG < b.getNorth(); s++)
    for (let w = Math.floor(b.getWest() / CELL_DEG); w * CELL_DEG < b.getEast(); w++)
      out.push({ key: `${r(s * CELL_DEG)},${r(w * CELL_DEG)}`, d: Math.hypot((s + 0.5) * CELL_DEG - c.lat, (w + 0.5) * CELL_DEG - c.lng) });
  return out.sort((a, z) => a.d - z.d).map((o) => o.key);
}

/** Fetch the cells in view that are not loaded yet (3 at a time), merging every loaded cell into the layer as each
 *  arrives. A finished cell is kept even if the map has moved on; failed cells simply retry on the next call. */
export function loadRoads(map: MlMap, fetchCell: (key: string) => Promise<GeoJSON.FeatureCollection>, onStatus: (s: RoadsStatus) => void) {
  let st = states.get(map);
  if (!st) states.set(map, st = { cells: new Map(), queue: [], active: 0, visible: new Set() });
  const state = st;
  const keys = visibleCells(map);
  state.visible = new Set(keys);
  state.queue = keys.filter((k) => !state.cells.has(k) && !inFlight.has(k));
  const status = () => onStatus(state.active || state.queue.length ? 'loading' : keys.some((k) => !state.cells.has(k)) ? 'failed' : '');
  const pump = () => {
    while (state.active < MAX_ACTIVE && state.queue.length) {
      const key = state.queue.shift()!;
      state.active++; inFlight.add(key);
      fetchCell(key).then((fc) => {
        state.cells.set(key, fc.features);
        // ponytail: evicts oldest cells not in view; LRU-by-distance if panning far becomes common
        for (const k of state.cells.keys()) { if (state.cells.size <= MAX_CELLS) break; if (!state.visible.has(k)) state.cells.delete(k); }
        const byId = new Map<unknown, GeoJSON.Feature>(); // ways spanning cells appear once
        for (const fs of state.cells.values()) for (const f of fs) byId.set(f.id, f);
        updateRoads(map, { type: 'FeatureCollection', features: [...byId.values()] });
      }).catch(() => {}).finally(() => { state.active--; inFlight.delete(key); pump(); status(); });
    }
  };
  pump();
  status();
}
const inFlight = new Set<string>(); // ponytail: shared across maps; there is only one map at a time
