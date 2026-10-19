import type * as React from 'react';
import type { SidePanelProps } from '@photoscout/plugin-sdk/web';
import type { RadioAudioController, RadioPlayerState } from './player.js';
import type { RadioPlace, RadioStation, RadioStationsResponse } from './types.js';
import { loadRadioFavorites, RADIO_FAVORITES_EVENT, toggleRadioFavorite, type RadioFavorite } from './favorites.js';

/**
 * The radio UI as React components, built with the host's React (host.ui.react)
 * so this bundle ships no copy of it and its hooks work. No JSX: the bundle has
 * no React to import, so elements are made with createElement.
 *
 * Two views:
 *   - the stations panel, drawn inside the host's side-panel frame (the frame
 *     owns the grab handle and the close button; this is only the content);
 *   - the persistent player widget in the map's bottom-right corner.
 */

/** The player's latest state, shared by both views. `get` returns the same object until the state changes. */
export interface PlayerStore {
  get(): RadioPlayerState;
  subscribe(listener: () => void): () => void;
}

export interface RadioViewDeps {
  react: typeof React;
  store: PlayerStore;
  player: RadioAudioController;
  /** Fetches the stations of one place. */
  loadStations(placeId: string): Promise<RadioStationsResponse>;
}

/** What the stations list draws, with no state of its own: the panel below feeds it, and a test can render it directly. */
export interface StationsContentProps {
  place: RadioPlace;
  stations: readonly RadioStation[];
  loading: boolean;
  error: string | null;
  player: RadioPlayerState;
  onStation(station: RadioStation): void;
  onStop(): void;
  onRetry(): void;
}

export function createStationsContent(react: typeof React): React.FunctionComponent<StationsContentProps> {
  const h = react.createElement;

  return function RadioStationsContent({ place, stations, loading, error, player, onStation, onStop, onRetry }: StationsContentProps) {
    const { activeStation, playbackState, playbackError } = player;
    const [favorites, setFavorites] = react.useState<RadioFavorite[]>(() => loadRadioFavorites());
    const [showFavorites, setShowFavorites] = react.useState(false);
    react.useEffect(() => {
      const refresh = (): void => setFavorites(loadRadioFavorites());
      window.addEventListener(RADIO_FAVORITES_EVENT, refresh);
      window.addEventListener('storage', refresh);
      return () => { window.removeEventListener(RADIO_FAVORITES_EVENT, refresh); window.removeEventListener('storage', refresh); };
    }, []);
    const isFavorite = (station: RadioStation): boolean => favorites.some((favorite) => favorite.id === station.id);
    const toggleFavorite = (station: RadioStation): void => setFavorites(toggleRadioFavorite(station, favorites));

    const playerCard = activeStation && h('div', { className: `radiopanel__player-card${playbackState === 'error' ? ' has-error' : ''}`, role: 'status' },
      h('div', { className: 'radiopanel__player-meta' },
        h('span', { className: 'radiopanel__player-badge' },
          playbackState === 'loading' && '⌛ Connecting...',
          playbackState === 'playing' && '🔊 Playing',
          playbackState === 'paused' && '⏸ Paused',
          playbackState === 'error' && '⚠️ Stream error',
          playbackState === 'idle' && 'Radio'),
        h('strong', { className: 'radiopanel__player-title' }, activeStation.title),
        activeStation.streamDomain && h('span', { className: 'radiopanel__station-domain' }, activeStation.streamDomain)),
      h('div', { className: 'radiopanel__player-controls' },
        (playbackState === 'playing' || playbackState === 'loading') &&
          h('button', { type: 'button', className: 'button', onClick: () => onStation(activeStation), 'aria-label': 'Pause station' }, '⏸ Pause'),
        playbackState === 'paused' &&
          h('button', { type: 'button', className: 'button primary', onClick: () => onStation(activeStation), 'aria-label': 'Resume station' }, '▶ Resume'),
        playbackState === 'error' &&
          h('button', { type: 'button', className: 'button', onClick: () => onStation(activeStation), 'aria-label': 'Retry station' }, '↻ Retry'),
        h('button', { type: 'button', className: 'button', onClick: onStop, 'aria-label': 'Stop playback' }, '⏹ Stop')),
      playbackError && h('p', { className: 'status-line error', role: 'alert' }, playbackError));

    const stationRow = (st: RadioStation) => {
      const isActive = activeStation?.id === st.id;
      const isPlaying = isActive && playbackState === 'playing';
      const isLoading = isActive && playbackState === 'loading';
      const isPaused = isActive && playbackState === 'paused';
      const isError = isActive && playbackState === 'error';
      const label = isPlaying ? `Pause ${st.title}` : isPaused ? `Resume ${st.title}` : isLoading ? `Connecting to ${st.title}` : `Play ${st.title}`;
      return h('li', { key: st.id, className: `radiopanel__item${isActive ? ' is-active' : ''}` },
        h('div', { className: 'radiopanel__item-info' },
          h('div', { className: 'radiopanel__item-name' }, st.title),
          st.streamDomain && h('span', { className: 'radiopanel__station-domain' }, st.streamDomain)),
        h('button', { type: 'button', className: 'radiopanel__item-fav', onClick: () => toggleFavorite(st), 'aria-label': isFavorite(st) ? `Remove ${st.title} from favorites` : `Save ${st.title} as a favorite`, title: isFavorite(st) ? 'Remove favorite' : 'Save favorite' }, isFavorite(st) ? '★' : '☆'),
        h('button', { type: 'button', className: `radiopanel__item-btn${isPlaying ? ' primary' : ''}`, onClick: () => onStation(st), 'aria-label': label },
          isLoading && '⌛ Loading',
          isPlaying && '⏸ Pause',
          isPaused && '▶ Resume',
          isError && '⚠️ Retry',
          !isActive && '▶ Play'));
    };

    return h('div', { className: 'radiopanel' },
      h('div', { className: 'radiopanel__header' },
        h('h2', null, '📻 ', place.title),
        h('p', { className: 'hint' },
          place.country ? `${place.country} · ` : '',
          place.stationCount, ' ', place.stationCount === 1 ? 'station' : 'stations')),

      h('div', { className: 'radiopanel__notice-box' },
        h('p', { className: 'hint radiopanel__notice' }, 'Streams are supplied by third-party stations and may be geo-blocked or unavailable.'),
        h('p', { className: 'hint radiopanel__attribution' },
          'Radio locations via',
          ' ',
          h('a', { href: 'https://radio.garden', target: '_blank', rel: 'noopener noreferrer' }, 'Radio Garden'))),

      playerCard,

      h('div', { className: 'radiopanel__tabs', role: 'tablist', 'aria-label': 'Radio stations' },
        h('button', { type: 'button', className: `radiopanel__tab${!showFavorites ? ' is-active' : ''}`, onClick: () => setShowFavorites(false), role: 'tab', 'aria-selected': !showFavorites }, 'Stations'),
        h('button', { type: 'button', className: `radiopanel__tab${showFavorites ? ' is-active' : ''}`, onClick: () => setShowFavorites(true), role: 'tab', 'aria-selected': showFavorites }, `Favorites (${favorites.length})`)),

      showFavorites && favorites.length === 0 && h('p', { className: 'hint radiopanel__empty' }, 'No saved stations yet. Use ☆ beside a station to keep it here on this device.'),
      showFavorites && favorites.length > 0 && h('ul', { className: 'plainlist radiopanel__list' }, favorites.map(stationRow)),

      !showFavorites && loading && h('div', { className: 'radiopanel__loading hint', role: 'status' }, `Loading stations for ${place.title}...`),

      !showFavorites && error && h('div', { className: 'status-line error', role: 'alert' },
        error,
        h('div', { className: 'mt-6' },
          h('button', { type: 'button', onClick: onRetry }, '↻ Retry'))),

      !showFavorites && !loading && !error && stations.length === 0 && h('p', { className: 'hint' }, 'No online stations listed for this location.'),

      !showFavorites && !loading && !error && stations.length > 0 && h('ul', { className: 'plainlist radiopanel__list' }, stations.map(stationRow)));
  };
}

/** The stations panel: owns the fetch and the Escape key, and hands everything else to the content. */
export function createStationsPanel(deps: RadioViewDeps): React.ComponentType<SidePanelProps<RadioPlace>> {
  const { react, store, player, loadStations } = deps;
  const { createElement: h, useEffect, useState, useSyncExternalStore } = react;
  const Content = createStationsContent(react);

  return function RadioStationsPanel({ data: place, close }: SidePanelProps<RadioPlace>) {
    const [stations, setStations] = useState<RadioStation[]>([]);
    const [loadingStations, setLoadingStations] = useState(true);
    const [stationsError, setStationsError] = useState<string | null>(null);
    const playerState = useSyncExternalStore(store.subscribe, store.get, store.get);

    // Close with Escape key.
    useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') close();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [close]);

    // Fetch stations for the selected place on demand.
    useEffect(() => {
      let cancelled = false;
      setLoadingStations(true);
      setStationsError(null);
      setStations([]);

      loadStations(place.id)
        .then((res) => {
          if (cancelled) return;
          setStations(res.stations ?? []);
          setLoadingStations(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setStationsError((err instanceof Error && err.message) || 'Failed to load stations');
          setLoadingStations(false);
        });

      return () => {
        cancelled = true;
      };
    }, [place.id]);

    const retryStations = (): void => {
      setLoadingStations(true);
      setStationsError(null);
      loadStations(place.id)
        .then((res) => {
          setStations(res.stations ?? []);
          setLoadingStations(false);
        })
        .catch((err: unknown) => {
          setStationsError((err instanceof Error && err.message) || 'Failed to load stations');
          setLoadingStations(false);
        });
    };

    return h(Content, {
      place,
      stations,
      loading: loadingStations,
      error: stationsError,
      player: playerState,
      onStation: (st) => player.handleStationClick(st),
      onStop: () => player.stop(),
      onRetry: retryStations,
    });
  };
}

/**
 * The persistent player widget. It shows whenever a station is selected, including
 * when the Radio layer is off or the stations panel is closed, and draws nothing
 * otherwise (the host hides an empty corner slot).
 */
export function createPlayerWidget(deps: RadioViewDeps): React.ComponentType<Record<string, never>> {
  const { react, store, player } = deps;
  const { createElement: h, useSyncExternalStore } = react;

  return function RadioPlayerWidget() {
    const { activeStation: station, playbackState, playbackError } = useSyncExternalStore(store.subscribe, store.get, store.get);
    if (!station) return null;

    const isPlaying = playbackState === 'playing';
    const isLoading = playbackState === 'loading';
    const isPaused = playbackState === 'paused';
    const isError = playbackState === 'error';

    return h('aside', { className: `radiowidget${isError ? ' has-error' : ''}`, role: 'region', 'aria-label': `Radio player: ${station.title}` },
      h('div', { className: 'radiowidget__info', title: playbackError ? `${station.title} — ${playbackError}` : station.title },
        h('span', { className: 'radiowidget__badge' },
          isLoading && '⌛ Connecting',
          isPlaying && '🔊 Playing',
          isPaused && '⏸ Paused',
          isError && '⚠️ Unavailable'),
        h('strong', { className: 'radiowidget__title' }, station.title)),
      h('div', { className: 'radiowidget__controls' },
        h('button', {
          type: 'button',
          className: `button${isPlaying ? '' : ' primary'} radiowidget__btn`,
          onClick: () => player.handleStationClick(station),
          'aria-label': isPlaying ? `Pause ${station.title}` : isPaused ? `Resume ${station.title}` : isLoading ? `Pause connecting to ${station.title}` : `Retry ${station.title}`,
          title: isPlaying ? 'Pause' : isPaused ? 'Resume' : isLoading ? 'Pause connecting' : 'Retry connection',
        },
          (isPlaying || isLoading) && '⏸ Pause',
          isPaused && '▶ Resume',
          isError && '↻ Retry'),
        h('button', { type: 'button', className: 'button radiowidget__btn', onClick: () => player.stop(), 'aria-label': `Stop ${station.title}`, title: 'Stop playback' }, '⏹ Stop')));
  };
}
