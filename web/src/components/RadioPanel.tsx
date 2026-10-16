import { useEffect, useRef, useState } from 'react';
import { api, type RadioPlace, type RadioStation } from '../api.js';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export const DEFAULT_RADIO_CONNECTION_TIMEOUT_MS = 15_000;
export const RADIO_STREAM_UNAVAILABLE_ERROR = 'Stream unavailable. The station may be offline or geo-blocked.';

export interface AudioElementLike {
  src: string;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  onplaying: ((this: any, ev: any) => any) | null;
  onwaiting: ((this: any, ev: any) => any) | null;
  onpause: ((this: any, ev: any) => any) | null;
  onerror: ((this: any, ev: any) => any) | null;
  onended: ((this: any, ev: any) => any) | null;
}

export type AudioFactory = (url: string) => AudioElementLike;

export interface RadioPlayerState {
  activeStation: RadioStation | null;
  playbackState: PlaybackState;
  playbackError: string | null;
}

export interface RadioAudioControllerOptions {
  connectionTimeoutMs?: number;
  audioFactory?: AudioFactory;
  onStateChange?: (state: RadioPlayerState) => void;
}

/**
 * Manages HTMLAudioElement lifecycle, bounded connection timeouts (default 15s),
 * terminal offline/unavailable error states, and protection against stale callbacks.
 */
export class RadioAudioController {
  private activeStation: RadioStation | null = null;
  private playbackState: PlaybackState = 'idle';
  private playbackError: string | null = null;
  private activeAudio: AudioElementLike | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeoutMs: number;
  private currentGeneration = 0;
  private audioFactory: AudioFactory;
  private onStateChange?: (state: RadioPlayerState) => void;

  constructor(options: RadioAudioControllerOptions = {}) {
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_RADIO_CONNECTION_TIMEOUT_MS;
    this.audioFactory =
      options.audioFactory ??
      ((_url: string) => {
        if (typeof Audio === 'undefined') {
          throw new Error('Audio constructor is not available');
        }
        return new Audio();
      });
    this.onStateChange = options.onStateChange;
  }

  setConnectionTimeoutMs(ms: number): void {
    this.connectionTimeoutMs = ms;
  }

  setOnStateChange(callback?: (state: RadioPlayerState) => void): void {
    this.onStateChange = callback;
    if (callback) {
      callback(this.getState());
    }
  }

  getState(): RadioPlayerState {
    return {
      activeStation: this.activeStation,
      playbackState: this.playbackState,
      playbackError: this.playbackError,
    };
  }

  getActiveAudio(): AudioElementLike | null {
    return this.activeAudio;
  }

  hasPendingTimeout(): boolean {
    return this.timeoutId !== null;
  }

  clearConnectionTimeout(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private notifyState(): void {
    this.onStateChange?.(this.getState());
  }

  private stopAudioInternal(): void {
    if (this.activeAudio) {
      const audio = this.activeAudio;
      this.activeAudio = null;
      audio.onplaying = null;
      audio.onwaiting = null;
      audio.onpause = null;
      audio.onerror = null;
      audio.onended = null;
      try {
        audio.pause();
      } catch {}
      try {
        audio.removeAttribute('src');
      } catch {}
      try {
        audio.load();
      } catch {}
    }
  }

  handleStationClick(station: RadioStation): void {
    // 1. If this station is currently playing or loading -> pause it
    if (this.activeStation?.id === station.id && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.pause();
      return;
    }

    // 2. If this station is currently paused -> resume it
    if (this.activeStation?.id === station.id && this.playbackState === 'paused' && this.activeAudio) {
      this.resume();
      return;
    }

    // 3. New station, or restarting after error/idle -> full start
    this.playStation(station);
  }

  pause(): void {
    this.clearConnectionTimeout();
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
      } catch {}
    }
    if (this.playbackState === 'playing' || this.playbackState === 'loading') {
      this.playbackState = 'paused';
      this.notifyState();
    }
  }

  resume(): void {
    if (this.activeStation && this.playbackState === 'paused' && this.activeAudio) {
      const audio = this.activeAudio;
      this.clearConnectionTimeout();
      this.playbackState = 'loading';
      const generation = ++this.currentGeneration;
      this.startConnectionTimeout(audio, generation);
      this.notifyState();

      try {
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err: Error) => {
            if (this.activeAudio !== audio) return;
            if (err.name !== 'AbortError') {
              this.clearConnectionTimeout();
              this.stopAudioInternal();
              this.playbackState = 'error';
              this.playbackError = 'Playback failed. The stream may be offline or unreachable.';
              this.notifyState();
            }
          });
        }
      } catch (err: any) {
        if (this.activeAudio !== audio) return;
        if (err.name !== 'AbortError') {
          this.clearConnectionTimeout();
          this.stopAudioInternal();
          this.playbackState = 'error';
          this.playbackError = 'Playback failed. The stream may be offline or unreachable.';
          this.notifyState();
        }
      }
    }
  }

  playStation(station: RadioStation): void {
    this.clearConnectionTimeout();
    this.currentGeneration++;
    this.stopAudioInternal();

    this.activeStation = station;
    this.playbackState = 'loading';
    this.playbackError = null;

    const audio = this.audioFactory(station.listenUrl);
    this.activeAudio = audio;
    const generation = ++this.currentGeneration;

    audio.onplaying = () => {
      if (this.activeAudio !== audio) return;
      this.clearConnectionTimeout();
      this.playbackState = 'playing';
      this.playbackError = null;
      this.notifyState();
    };

    audio.onwaiting = () => {
      if (this.activeAudio !== audio) return;
      this.playbackState = 'loading';
      this.notifyState();
    };

    audio.onpause = () => {
      if (this.activeAudio !== audio) return;
      if (this.playbackState === 'playing') {
        this.playbackState = 'paused';
        this.notifyState();
      }
    };

    audio.onerror = () => {
      if (this.activeAudio !== audio) return;
      this.clearConnectionTimeout();
      this.stopAudioInternal();
      this.playbackState = 'error';
      this.playbackError = RADIO_STREAM_UNAVAILABLE_ERROR;
      this.notifyState();
    };

    audio.onended = () => {
      if (this.activeAudio !== audio) return;
      this.clearConnectionTimeout();
      this.stopAudioInternal();
      this.activeStation = null;
      this.playbackState = 'idle';
      this.notifyState();
    };

    this.startConnectionTimeout(audio, generation);
    this.notifyState();

    audio.src = station.listenUrl;
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: Error) => {
          if (this.activeAudio !== audio) return;
          if (err.name !== 'AbortError') {
            this.clearConnectionTimeout();
            this.stopAudioInternal();
            this.playbackState = 'error';
            this.playbackError = 'Playback failed. The station stream may be offline.';
            this.notifyState();
          }
        });
      }
    } catch (err: any) {
      if (this.activeAudio !== audio) return;
      if (err.name !== 'AbortError') {
        this.clearConnectionTimeout();
        this.stopAudioInternal();
        this.playbackState = 'error';
        this.playbackError = 'Playback failed. The station stream may be offline.';
        this.notifyState();
      }
    }
  }

  private startConnectionTimeout(audio: AudioElementLike, generation: number): void {
    this.clearConnectionTimeout();
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      if (this.currentGeneration !== generation || this.activeAudio !== audio) {
        return; // Stale callback
      }
      this.stopAudioInternal();
      this.playbackState = 'error';
      this.playbackError = RADIO_STREAM_UNAVAILABLE_ERROR;
      this.notifyState();
    }, this.connectionTimeoutMs);
  }

  close(): void {
    this.stop();
  }

  stop(): void {
    this.clearConnectionTimeout();
    this.currentGeneration++;
    this.stopAudioInternal();
    this.activeStation = null;
    this.playbackState = 'idle';
    this.playbackError = null;
    this.notifyState();
  }

  destroy(): void {
    this.clearConnectionTimeout();
    this.currentGeneration++;
    this.stopAudioInternal();
    this.activeStation = null;
    this.playbackState = 'idle';
    this.playbackError = null;
    this.onStateChange = undefined;
  }
}

export interface RadioPanelProps {
  place: RadioPlace;
  onClose: () => void;
  sheetSize?: 'peek' | 'half';
  onToggleSheet?: () => void;
  connectionTimeoutMs?: number;
  playerState?: RadioPlayerState;
  onStationClick?: (station: RadioStation) => void;
  onStop?: () => void;
}

/**
 * Station panel for a selected Radio Garden location.
 * Playback is owned by the app-level controller so closing the panel
 * or hiding the layer preserves background playback under the persistent widget.
 */
export default function RadioPanel({
  place,
  onClose,
  sheetSize = 'half',
  onToggleSheet,
  connectionTimeoutMs = DEFAULT_RADIO_CONNECTION_TIMEOUT_MS,
  playerState: externalPlayerState,
  onStationClick,
  onStop,
}: RadioPanelProps) {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loadingStations, setLoadingStations] = useState(true);
  const [stationsError, setStationsError] = useState<string | null>(null);

  const [internalState, setInternalState] = useState<RadioPlayerState>({
    activeStation: null,
    playbackState: 'idle',
    playbackError: null,
  });

  const internalPlayerRef = useRef<RadioAudioController | null>(null);
  if (!onStationClick && !internalPlayerRef.current) {
    internalPlayerRef.current = new RadioAudioController({
      connectionTimeoutMs,
      onStateChange: (state) => setInternalState(state),
    });
  }

  useEffect(() => {
    internalPlayerRef.current?.setConnectionTimeoutMs(connectionTimeoutMs);
  }, [connectionTimeoutMs]);

  const activeStation = externalPlayerState ? externalPlayerState.activeStation : internalState.activeStation;
  const playbackState = externalPlayerState ? externalPlayerState.playbackState : internalState.playbackState;
  const playbackError = externalPlayerState ? externalPlayerState.playbackError : internalState.playbackError;

  const handleStationClick = (station: RadioStation) => {
    if (onStationClick) {
      onStationClick(station);
    } else {
      internalPlayerRef.current?.handleStationClick(station);
    }
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
    } else {
      internalPlayerRef.current?.stop();
    }
  };

  const handleClose = () => {
    onClose();
  };

  // Close with Escape key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clean up internal fallback audio on unmount if used.
  useEffect(() => {
    return () => {
      internalPlayerRef.current?.destroy();
    };
  }, []);

  // Fetch stations for the selected place on demand.
  useEffect(() => {
    let cancelled = false;
    setLoadingStations(true);
    setStationsError(null);
    setStations([]);

    api.radioStations(place.id)
      .then((res) => {
        if (cancelled) return;
        setStations(res.stations ?? []);
        setLoadingStations(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setStationsError((err as Error).message || 'Failed to load stations');
        setLoadingStations(false);
      });

    return () => {
      cancelled = true;
    };
  }, [place.id]);

  return (
    <aside className={`panel panel--${sheetSize} radiopanel`} role="region" aria-label={`Radio stations in ${place.title}`}>
      {onToggleSheet && (
        <button
          type="button"
          className="panel__handle"
          aria-label={sheetSize === 'half' ? 'Collapse panel' : 'Expand panel'}
          aria-expanded={sheetSize === 'half'}
          onClick={onToggleSheet}
        >
          <span className="panel__grab" aria-hidden="true" />
        </button>
      )}

      <button className="panel__close" onClick={handleClose} title="Close radio panel" aria-label="Close">
        ✕
      </button>

      <div className="radiopanel__header">
        <h2>📻 {place.title}</h2>
        <p className="hint">
          {place.country ? `${place.country} · ` : ''}
          {place.stationCount} {place.stationCount === 1 ? 'station' : 'stations'}
        </p>
      </div>

      <div className="radiopanel__notice-box">
        <p className="hint radiopanel__notice">
          Streams are supplied by third-party stations and may be geo-blocked or unavailable.
        </p>
        <p className="hint radiopanel__attribution">
          Radio locations via{' '}
          <a href="https://radio.garden" target="_blank" rel="noopener noreferrer">
            Radio Garden
          </a>
        </p>
      </div>

      {activeStation && (
        <div className={`radiopanel__player-card${playbackState === 'error' ? ' has-error' : ''}`} role="status">
          <div className="radiopanel__player-meta">
            <span className="radiopanel__player-badge">
              {playbackState === 'loading' && '⌛ Connecting...'}
              {playbackState === 'playing' && '🔊 Playing'}
              {playbackState === 'paused' && '⏸ Paused'}
              {playbackState === 'error' && '⚠️ Stream error'}
              {playbackState === 'idle' && 'Radio'}
            </span>
            <strong className="radiopanel__player-title">{activeStation.title}</strong>
            {activeStation.streamDomain && (
              <span className="radiopanel__station-domain">{activeStation.streamDomain}</span>
            )}
          </div>

          <div className="radiopanel__player-controls">
            {(playbackState === 'playing' || playbackState === 'loading') && (
              <button
                type="button"
                className="button"
                onClick={() => handleStationClick(activeStation)}
                aria-label="Pause station"
              >
                ⏸ Pause
              </button>
            )}
            {playbackState === 'paused' && (
              <button
                type="button"
                className="button primary"
                onClick={() => handleStationClick(activeStation)}
                aria-label="Resume station"
              >
                ▶ Resume
              </button>
            )}
            {playbackState === 'error' && (
              <button
                type="button"
                className="button"
                onClick={() => handleStationClick(activeStation)}
                aria-label="Retry station"
              >
                ↻ Retry
              </button>
            )}
            <button
              type="button"
              className="button"
              onClick={handleStop}
              aria-label="Stop playback"
            >
              ⏹ Stop
            </button>
          </div>

          {playbackError && (
            <p className="status-line error" role="alert">
              {playbackError}
            </p>
          )}
        </div>
      )}

      <h4>Stations</h4>

      {loadingStations && (
        <div className="radiopanel__loading hint" role="status">
          Loading stations for {place.title}...
        </div>
      )}

      {stationsError && (
        <div className="status-line error" role="alert">
          {stationsError}
          <div className="mt-6">
            <button
              type="button"
              onClick={() => {
                setLoadingStations(true);
                setStationsError(null);
                api.radioStations(place.id)
                  .then((res) => {
                    setStations(res.stations ?? []);
                    setLoadingStations(false);
                  })
                  .catch((err) => {
                    setStationsError((err as Error).message || 'Failed to load stations');
                    setLoadingStations(false);
                  });
              }}
            >
              ↻ Retry
            </button>
          </div>
        </div>
      )}

      {!loadingStations && !stationsError && stations.length === 0 && (
        <p className="hint">No online stations listed for this location.</p>
      )}

      {!loadingStations && stations.length > 0 && (
        <ul className="plainlist radiopanel__list">
          {stations.map((st) => {
            const isActive = activeStation?.id === st.id;
            const isPlaying = isActive && playbackState === 'playing';
            const isLoading = isActive && playbackState === 'loading';
            const isPaused = isActive && playbackState === 'paused';
            const isError = isActive && playbackState === 'error';

            return (
              <li
                key={st.id}
                className={`radiopanel__item${isActive ? ' is-active' : ''}`}
              >
                <div className="radiopanel__item-info">
                  <div className="radiopanel__item-name">{st.title}</div>
                  {st.streamDomain && (
                    <span className="radiopanel__station-domain">{st.streamDomain}</span>
                  )}
                </div>

                <button
                  type="button"
                  className={`radiopanel__item-btn${isPlaying ? ' primary' : ''}`}
                  onClick={() => handleStationClick(st)}
                  aria-label={
                    isPlaying
                      ? `Pause ${st.title}`
                      : isPaused
                      ? `Resume ${st.title}`
                      : isLoading
                      ? `Connecting to ${st.title}`
                      : `Play ${st.title}`
                  }
                >
                  {isLoading && '⌛ Loading'}
                  {isPlaying && '⏸ Pause'}
                  {isPaused && '▶ Resume'}
                  {isError && '⚠️ Retry'}
                  {!isActive && '▶ Play'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
