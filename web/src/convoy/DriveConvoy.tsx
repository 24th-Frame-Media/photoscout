import { useEffect, useRef } from 'react';
import { useDriveMap } from '../drive/context.js';
import { attachConvoyLayer, type ConvoyLayer } from './layer.js';
import { useConvoy } from './useConvoy.js';

/**
 * The convoy you are in, on the Drive screen: everyone else's pin, and the
 * shared destination as a one-tap choice when you have not picked your own.
 * Your own car is Drive's arrow, so your pin is left off.
 */
export default function DriveConvoy() {
  const { map, hasTarget, goTo, goRoute } = useDriveMap();
  const convoy = useConvoy();
  const layer = useRef<ConvoyLayer | null>(null);
  const view = convoy.view;

  useEffect(() => {
    if (!map) return;
    layer.current = attachConvoyLayer(map);
    return () => { layer.current?.remove(); layer.current = null; };
  }, [map]);

  useEffect(() => {
    if (!view) { layer.current?.update([]); return; }
    layer.current?.update(view.members.filter((m) => m.id !== view.me), { me: view.me, leader: view.leader, destination: view.destination });
  }, [view]);

  if (!view) return null;
  const dest = view.destination;
  return (
    <div className="driveconvoy">
      <span className="driveconvoy__name">{convoy.room?.name ?? 'Convoy'} · {view.members.filter((m) => m.online).length} on</span>
      {dest && !hasTarget && (
        <button type="button" className="primary" onClick={() => goTo(dest.lat, dest.lng, dest.label || 'Convoy destination')}>
          Drive to {dest.label || 'the convoy’s destination'}
        </button>
      )}
      {view.route && !hasTarget && (
        <button type="button" className="primary" onClick={() => goRoute(view.route!.stops, view.route!.name)}>
          Drive convoy route
        </button>
      )}
    </div>
  );
}
