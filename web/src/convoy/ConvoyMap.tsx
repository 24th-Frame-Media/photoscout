import { useEffect, useRef } from 'react';
import { Map as MlMap } from 'maplibre-gl';
import { STYLE_URL } from '../map/layers.js';
import { attachConvoyLayer, type ConvoyLayer } from './layer.js';
import type { ConvoyView } from './state.js';

/**
 * A map of one convoy: the basemap, then the members and the destination on it.
 * Opens on the group the first time anybody has a position. With `onPick` set,
 * the next click on the map is handed back as a place (the leader choosing a destination).
 */
export default function ConvoyMap({ view, onPick }: { view: ConvoyView; onPick?: (lat: number, lng: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const layer = useRef<ConvoyLayer | null>(null);
  const fitted = useRef(false);
  const pick = useRef(onPick);
  pick.current = onPick;
  const latest = useRef(view);
  latest.current = view;

  useEffect(() => {
    const m = new MlMap({ container: container.current!, style: STYLE_URL, center: [149.577, -33.419], zoom: 8 });
    map.current = m;
    m.on('click', (e) => pick.current?.(e.lngLat.lat, e.lngLat.lng));
    m.on('load', () => {
      layer.current = attachConvoyLayer(m, latest.current.members, latest.current);
      layer.current.fit();
      fitted.current = latest.current.members.some((x) => x.online && x.position) || latest.current.destination !== null;
    });
    return () => { layer.current?.remove(); layer.current = null; m.remove(); map.current = null; fitted.current = false; };
  }, []);

  useEffect(() => {
    const l = layer.current;
    if (!l) return;
    l.update(view.members, view);
    if (!fitted.current && (view.members.some((x) => x.online && x.position) || view.destination)) { l.fit(); fitted.current = true; }
  }, [view]);

  return (
    <div className="convoymap">
      <div ref={container} className={`convoymap__map${onPick ? ' is-picking' : ''}`} aria-label="Map of the convoy" />
      <button type="button" className="convoymap__fit" onClick={() => layer.current?.fit()}>Show everyone</button>
    </div>
  );
}
