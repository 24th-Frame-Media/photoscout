import type { FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource } from 'maplibre-gl';
import type { LegendEntry, PluginHost, WebPlugin } from '@photoscout/plugin-sdk/web';
import { RadioAudioController, type RadioPlayerState } from './web/player.js';
import type { RadioPlace, RadioPlacesResponse, RadioStationsResponse } from './web/types.js';
import { createPlayerWidget, createStationsPanel, type PlayerStore } from './web/view.js';

/**
 * Radio Garden's web half: the "Radio" toggle, the clustered station map, the
 * stations panel and the persistent player. It was hardcoded in the app; it now
 * uses only the plugin web API (`@photoscout/plugin-sdk/web`), and imports only
 * types from it. This bundle ships no React: the views use `host.ui.react`.
 *
 * The data comes from this plugin's own server routes (`/places`,
 * `/places/:id/stations`), read through `host.data`.
 */

/** Radio Garden layer colour: distinct emerald green. */
const RADIO_COLOR = '#10b981';
const FONT = ['Noto Sans Regular'];
const CONNECTION_TIMEOUT_MS = 15_000;

/** The GeoJSON for the map: one point per place, [lng, lat]. */
export function radioGeoJSON(places: readonly RadioPlace[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      id: p.id,
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { id: p.id, title: p.title, country: p.country, stationCount: p.stationCount },
    })),
  };
}

/** The place a clicked marker stands for, read back from its feature properties. */
export function placeFromProperties(properties: Record<string, unknown> | null | undefined, [lng, lat]: [number, number]): RadioPlace {
  return {
    id: String(properties?.id ?? ''),
    title: (properties?.title as string) || '',
    country: (properties?.country as string) || '',
    lng,
    lat,
    stationCount: Number(properties?.stationCount || 1),
  };
}

/** Test and debug hook, as the app exposed before the move. */
type PlayerGlobal = { __photoscoutRadioPlayer?: RadioAudioController };

let activePlayer: RadioAudioController | null = null;

const plugin: WebPlugin = {
  activate(host: PluginHost) {
    // --- the player: one for the page, shared by the panel and the corner widget ---
    let state: RadioPlayerState = { activeStation: null, playbackState: 'idle', playbackError: null };
    const listeners = new Set<() => void>();
    const player = new RadioAudioController({
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      onStateChange: (next) => {
        state = next;
        for (const listener of [...listeners]) listener();
      },
    });
    state = player.getState();
    const store: PlayerStore = {
      get: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    activePlayer = player;
    (globalThis as PlayerGlobal).__photoscoutRadioPlayer = player;

    const views = {
      react: host.ui.react,
      store,
      player,
      loadStations: (placeId: string) => host.data.json<RadioStationsResponse>(`/places/${encodeURIComponent(placeId)}/stations`),
    };

    // --- ids ---
    const SOURCE = host.map.scopedId('src');
    const CLUSTERS = host.map.scopedId('clusters');
    const COUNT = host.map.scopedId('cluster-count');
    const POINTS = host.map.scopedId('points');

    // --- the toggle ---
    const radio: LegendEntry = host.legend.add({
      key: 'radio',
      label: 'Radio',
      title: 'World radio locations (Radio Garden)',
      swatch: { kind: 'glyph', color: RADIO_COLOR, glyph: '📻' },
      defaultOn: false,
      menu: 'live',
      layers: [CLUSTERS, COUNT, POINTS],
    });

    // --- the panels ---
    const stations = host.panel.addSide<RadioPlace>({
      id: 'stations',
      label: 'Radio stations',
      component: createStationsPanel(views),
    });
    // No `whileOn`: the player stays on screen while the layer is off, like the app's widget did.
    host.panel.addCorner({ id: 'player', component: createPlayerWidget(views) });

    // Turning the layer off closes the stations panel (the player keeps going).
    radio.onChange((on) => {
      if (!on) stations.close();
    });

    // --- the map ---
    host.map.onReady((map) => {
      map.addSource(SOURCE, {
        type: 'geojson',
        data: radioGeoJSON([]),
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 40,
        attribution: 'Radio locations via <a href="https://radio.garden/" target="_blank" rel="noopener noreferrer">Radio Garden</a>',
      });
      const visibility = radio.on ? 'visible' : 'none';
      map.addLayer({
        id: CLUSTERS,
        type: 'circle',
        source: SOURCE,
        filter: ['has', 'point_count'],
        layout: { visibility },
        paint: {
          'circle-radius': 15,
          'circle-color': '#0d2818',
          'circle-stroke-color': RADIO_COLOR,
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: COUNT,
        type: 'symbol',
        source: SOURCE,
        filter: ['has', 'point_count'],
        layout: {
          visibility,
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': FONT,
          'text-size': 12,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': RADIO_COLOR },
      });
      map.addLayer({
        id: POINTS,
        type: 'circle',
        source: SOURCE,
        filter: ['!', ['has', 'point_count']],
        layout: { visibility },
        paint: {
          'circle-radius': 6,
          'circle-color': RADIO_COLOR,
          'circle-stroke-color': '#0e1014',
          'circle-stroke-width': 1.5,
        },
      });

      // Locations are fetched once, when the layer is first on for this map. No polling.
      let places: RadioPlace[] | null = null;
      let loading = false;
      let removed = false;
      const draw = (list: readonly RadioPlace[]): void => {
        (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(radioGeoJSON(list));
      };
      const load = (): void => {
        if (!radio.on || removed) return;
        if (places) {
          draw(places);
          return;
        }
        if (loading) return;
        loading = true;
        host.data.json<RadioPlacesResponse>('/places')
          .then((res) => {
            if (removed) return;
            places = res.places;
            draw(res.places);
          })
          .catch((err: unknown) => {
            if (!removed) host.activity(err instanceof Error ? err.message : 'Radio stations are unavailable', 'error');
          })
          .finally(() => {
            loading = false;
          });
      };
      const unsubscribe = radio.onChange((on) => {
        if (on) load();
      });
      load();

      // Leaving the map page stops the radio, as the app's player did when the page unmounted.
      return () => {
        removed = true;
        unsubscribe();
        player.stop();
      };
    });

    // --- clicks: a cluster zooms in; a marker opens the stations panel ---
    host.map.onClick([CLUSTERS, POINTS], (e) => {
      const feature = e.features[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const center = feature.geometry.coordinates as [number, number];
      if (e.layerId === CLUSTERS) {
        const clusterId = Number(feature.properties?.cluster_id);
        (e.map.getSource(SOURCE) as GeoJSONSource | undefined)?.getClusterExpansionZoom(clusterId)
          .then((zoom) => e.map.easeTo({ center, zoom }));
        return;
      }
      stations.open(placeFromProperties(feature.properties, center));
    });
  },

  deactivate() {
    activePlayer?.destroy();
    activePlayer = null;
    delete (globalThis as { __photoscoutRadioPlayer?: unknown }).__photoscoutRadioPlayer;
  },
};

export default plugin;
