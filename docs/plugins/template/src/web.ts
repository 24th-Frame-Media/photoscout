import type { Feature, FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource } from 'maplibre-gl';
import type { PluginHost, WebPlugin } from './sdk/web-api.js';

interface Place {
  id: string;
  title: string;
  point: [number, number];
}

interface PlacesReply {
  places: Place[];
}

const toCollection = (places: readonly Place[]): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: places.map((p): Feature<Point> => ({
    type: 'Feature',
    properties: { id: p.id, title: p.title },
    geometry: { type: 'Point', coordinates: p.point },
  })),
});

// The bundle imports types only, so it needs no runtime code from the app.
const plugin: WebPlugin = {
  activate(host: PluginHost) {
    const source = host.map.scopedId('places');
    const points = host.map.scopedId('points');
    const byId = new Map<string, Place>();

    // 1. A legend toggle. The host shows and hides `points` with it.
    const toggle = host.legend.add({
      key: 'places',
      label: 'Hello places',
      swatch: { kind: 'dot', color: '#10b981' },
      defaultOn: true,
      layers: [points],
    });

    // 2. The source, the layer and a poll, once per map page. The poll runs only while the toggle is on.
    host.map.onReady((map) => {
      const sourceOf = () => map.getSource(source) as GeoJSONSource | undefined;
      map.addSource(source, { type: 'geojson', data: toCollection([]) });
      map.addLayer({
        id: points,
        type: 'circle',
        source,
        layout: { visibility: toggle.on ? 'visible' : 'none' },
        paint: { 'circle-radius': 7, 'circle-color': '#10b981' },
      });
      const poll = host.data.poll<PlacesReply>({
        map,
        while: toggle,
        refreshOnMove: true,
        fetch: ({ signal, bounds }) => {
          const bbox = bounds ? `?bbox=${bounds.minLng},${bounds.minLat},${bounds.maxLng},${bounds.maxLat}` : '';
          return host.data.json<PlacesReply>(`/places${bbox}`, { signal });
        },
        onData: ({ places }) => {
          byId.clear();
          for (const p of places) byId.set(p.id, p);
          sourceOf()?.setData(toCollection(places));
        },
        onError: () => host.activity('Hello places did not load', 'error'),
        onStop: () => sourceOf()?.setData(toCollection([])),
      });
      return () => poll.stop();
    });

    // 3. A side panel with the details, opened by a click on a point. A popup shows the title.
    const details = host.panel.addSide<Place>({
      id: 'details',
      label: 'Place details',
      render: (el, { data, close }) => {
        el.replaceChildren();
        const title = document.createElement('h2');
        title.textContent = data.title;
        const done = document.createElement('button');
        done.textContent = 'Close';
        done.addEventListener('click', close);
        el.append(title, done);
      },
    });
    host.map.onClick([points], (e) => {
      const place = byId.get(String(e.features[0]?.properties?.id));
      if (!place) return;
      host.map.showPopup(e.lngLat, place.title);
      details.open(place);
    });

    // 4. A Settings tab. Only admins see it, the default.
    host.settings.addTab({
      id: 'about',
      label: 'Hello places',
      render: (el, { isAdmin }) => {
        el.textContent = isAdmin ? 'Hello places: admin view.' : 'Hello places.';
      },
    });
  },
};

export default plugin;
