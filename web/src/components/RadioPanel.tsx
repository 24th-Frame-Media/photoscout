import { useEffect, useRef, useState } from 'react';
import { api, type RadioPlace, type RadioStation } from '../api.js';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface RadioPanelProps {
  place: RadioPlace;
  onClose: () => void;
  sheetSize?: 'peek' | 'half';
  onToggleSheet?: () => void;
}

/**
 * Station panel and audio player for a selected Radio Garden location.
 * Uses a single HTMLAudioElement with strict manual playback, clear error/offline states,
 * third-party stream disclaimers, and reliable cleanup on close or unmount.
 */
export default function RadioPanel({ place, onClose, sheetSize = 'half', onToggleSheet }: RadioPanelProps) {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loadingStations, setLoadingStations] = useState(true);
  const [stationsError, setStationsError] = useState<string | null>(null);

  const [activeStation, setActiveStation] = useState<RadioStation | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop playback and release audio resources.
  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }
  };

  // Close with Escape key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clean up audio on unmount.
  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, []);

  // Fetch stations for the selected place on demand.
  useEffect(() => {
    let cancelled = false;
    setLoadingStations(true);
    setStationsError(null);
    setStations([]);

    // Stop audio if the selected place changes
    stopAudio();
    setActiveStation(null);
    setPlaybackState('idle');
    setPlaybackError(null);

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

  const handleStationClick = (station: RadioStation) => {
    // 1. If this station is currently playing -> pause it
    if (activeStation?.id === station.id && playbackState === 'playing') {
      audioRef.current?.pause();
      setPlaybackState('paused');
      return;
    }

    // 2. If this station is currently paused -> resume it
    if (activeStation?.id === station.id && playbackState === 'paused' && audioRef.current) {
      setPlaybackState('loading');
      audioRef.current.play().catch((err) => {
        if (err.name !== 'AbortError') {
          setPlaybackState('error');
          setPlaybackError('Playback failed. The stream may be offline or unreachable.');
        }
      });
      return;
    }

    // 3. New station or restarting after error -> stop previous stream completely
    stopAudio();
    setActiveStation(station);
    setPlaybackState('loading');
    setPlaybackError(null);

    const audio = new Audio();
    audioRef.current = audio;

    audio.onplaying = () => {
      setPlaybackState('playing');
      setPlaybackError(null);
    };

    audio.onwaiting = () => {
      setPlaybackState('loading');
    };

    audio.onpause = () => {
      setPlaybackState((prev) => (prev === 'playing' ? 'paused' : prev));
    };

    audio.onerror = () => {
      setPlaybackState('error');
      setPlaybackError('Stream unavailable. The station may be offline or geo-blocked.');
    };

    audio.onended = () => {
      setPlaybackState('idle');
    };

    audio.src = station.listenUrl;
    audio.play().catch((err: Error) => {
      if (err.name !== 'AbortError') {
        setPlaybackState('error');
        setPlaybackError('Playback failed. The station stream may be offline.');
      }
    });
  };

  const handleClose = () => {
    stopAudio();
    onClose();
  };

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
              onClick={() => {
                stopAudio();
                setActiveStation(null);
                setPlaybackState('idle');
                setPlaybackError(null);
              }}
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
          <div style={{ marginTop: '6px' }}>
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
