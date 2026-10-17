/**
 * A tiny web plugin used as a test fixture and as a worked example of the API
 * (web/src/plugins/api.ts). Not shipped. It lives in its own folder and imports
 * the contract by relative path, the way a real bundle would import
 * `@photoscout/plugin-sdk/web`: types only, plus `definePlugin`.
 *
 * It does what a map plugin usually does: a layer behind a legend toggle, polled
 * only while the toggle is on, a popup and a details panel on click, a Settings
 * tab, a corner hint and a Drive alert source.
 */
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource } from 'maplibre-gl';
import { definePlugin, type PluginMapClick, type SettingsTabProps } from '../../../src/plugins/api.js';

interface Place {
  id: string;
  title: string;
  point: [number, number];
}

const toCollection = (places: readonly Place[]): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: places.map((p): Feature<Point> => ({
    type: 'Feature',
    id: p.id,
    geometry: { type: 'Point', coordinates: p.point },
    properties: { id: p.id, title: p.title },
  })),
});

export default definePlugin({
  activate(host) {
    const source = host.map.scopedId('places');
    const points = host.map.scopedId('points');

    // 1. The toggle. `layers` is all it takes for the host to show and hide the layer.
    const places = host.legend.add({
      key: 'places',
      label: 'Example places',
      title: 'Places from the example plugin',
      swatch: { kind: 'dot', color: '#10b981' },
      layers: [points],
    });

    // 2. The map: add the source and layer when a map is ready; poll while the toggle is on.
    host.map.onReady((map) => {
      map.addSource(source, { type: 'geojson', data: toCollection([]) });
      map.addLayer({
        id: points,
        type: 'circle',
        source,
        layout: { visibility: places.on ? 'visible' : 'none' },
        paint: { 'circle-radius': 7, 'circle-color': '#10b981' },
      });
      const setData = (list: readonly Place[]): void => {
        (map.getSource(source) as GeoJSONSource | undefined)?.setData(toCollection(list));
      };
      const poll = host.data.poll<{ places: Place[] }>({
        map,
        while: places,
        refreshOnMove: true,
        fetch: ({ signal, bounds }) => host.data.json(`/places?bbox=${bounds ? `${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}` : ''}`, { signal }),
        onData: (data) => setData(data.places),
        onError: (err) => host.activity(err instanceof Error ? err.message : 'Places unavailable', 'error'),
        onStop: () => setData([]),
      });
      return () => poll.stop();
    });

    // 3. Click: a popup, and a details panel.
    const detail = host.panel.addSide<Place>({
      id: 'detail',
      label: 'Place details',
      render: (el, { data, close }) => {
        el.replaceChildren();
        const heading = document.createElement('h2');
        heading.textContent = data.title;
        const button = document.createElement('button');
        button.textContent = 'Close';
        button.addEventListener('click', close);
        el.append(heading, button);
      },
    });
    host.map.onClick([points], (e: PluginMapClick) => {
      const feature = e.features[0];
      const title = String(feature.properties?.title ?? 'Place');
      host.map.showPopup(e.lngLat, title);
      detail.open({ id: String(feature.properties?.id ?? ''), title, point: e.lngLat });
    });

    // 4. A corner hint while the toggle is on.
    host.panel.addCorner({ id: 'hint', whileOn: 'places', render: (el) => { el.textContent = 'Example places are on'; } });

    // 5. A Settings tab, built as a React component with the host's own React.
    const { createElement: h, useState } = host.ui.react;
    function SettingsTab({ isAdmin }: SettingsTabProps) {
      const [count, setCount] = useState(0);
      return h('div', null, h('p', null, isAdmin ? 'Admin view' : 'Read-only view'), h('button', { onClick: () => setCount(count + 1) }, `Clicked ${count}`));
    }
    host.settings.addTab({ id: 'main', label: 'Example', group: 'Map', component: SettingsTab });

    // 6. Drive: report the places so the Drive screen can warn about the nearest.
    host.drive.addAlertSource({
      id: 'places',
      label: 'Example places',
      start: (ctx) => {
        const timer = setInterval(() => {
          const fix = ctx.fix();
          if (fix) ctx.report([{ id: 'near', point: fix.point, title: 'Example place', glyph: '📍' }]);
        }, 5000);
        return () => clearInterval(timer);
      },
    });
  },
});
