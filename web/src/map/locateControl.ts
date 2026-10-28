import { Marker, type IControl, type Map as MlMap } from 'maplibre-gl';

const PIN = '<svg viewBox="0 0 24 24" width="18" height="18" style="margin:auto;display:block" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';

/**
 * Map control: centre the map on where this device says it is, and mark the spot with a dot.
 * One shot per click; it does not follow you. `onNote` is told when the position can't be had.
 */
export function locateControl(onNote: (message: string) => void): IControl {
  const el = document.createElement('div');
  el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  el.innerHTML = `<button type="button" title="Show my location" aria-label="Show my location">${PIN}</button>`;
  let dot: Marker | null = null;
  return {
    onAdd(map: MlMap) {
      const button = el.querySelector('button')!;
      button.onclick = () => {
        if (!navigator.geolocation) return onNote('Your browser cannot share a location.');
        button.disabled = true;
        navigator.geolocation.getCurrentPosition(
          (p) => {
            button.disabled = false;
            const at: [number, number] = [p.coords.longitude, p.coords.latitude];
            if (!dot) {
              const mark = document.createElement('div');
              mark.className = 'mylocation';
              mark.setAttribute('aria-label', 'Your location');
              dot = new Marker({ element: mark }).setLngLat(at).addTo(map);
            } else dot.setLngLat(at);
            map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 14) });
          },
          () => { button.disabled = false; onNote('Could not get your location.'); },
          { timeout: 15_000 },
        );
      };
      return el;
    },
    onRemove() { dot?.remove(); dot = null; el.remove(); },
  };
}
