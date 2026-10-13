import type { RadioStation } from '../api.js';
import type { PlaybackState } from './RadioPanel.js';

export interface RadioWidgetProps {
  station: RadioStation;
  playbackState: PlaybackState;
  playbackError: string | null;
  onPlayPause: () => void;
  onStop: () => void;
}

/**
 * Compact persistent player widget rendered in the bottom-right of the map.
 * Displays station title and playback state, providing play/pause/retry and explicit stop controls.
 * Stays available whenever a station is selected, including when the Radio layer is toggled off
 * or its place panel is closed.
 */
export default function RadioWidget({
  station,
  playbackState,
  playbackError,
  onPlayPause,
  onStop,
}: RadioWidgetProps) {
  const isPlaying = playbackState === 'playing';
  const isLoading = playbackState === 'loading';
  const isPaused = playbackState === 'paused';
  const isError = playbackState === 'error';

  return (
    <aside
      className={`radiowidget${isError ? ' has-error' : ''}`}
      role="region"
      aria-label={`Radio player: ${station.title}`}
    >
      <div
        className="radiowidget__info"
        title={playbackError ? `${station.title} — ${playbackError}` : station.title}
      >
        <span className="radiowidget__badge">
          {isLoading && '⌛ Connecting'}
          {isPlaying && '🔊 Playing'}
          {isPaused && '⏸ Paused'}
          {isError && '⚠️ Unavailable'}
        </span>
        <strong className="radiowidget__title">{station.title}</strong>
      </div>

      <div className="radiowidget__controls">
        <button
          type="button"
          className={`button${isPlaying ? '' : ' primary'} radiowidget__btn`}
          onClick={onPlayPause}
          aria-label={
            isPlaying
              ? `Pause ${station.title}`
              : isPaused
              ? `Resume ${station.title}`
              : isLoading
              ? `Pause connecting to ${station.title}`
              : `Retry ${station.title}`
          }
          title={
            isPlaying
              ? 'Pause'
              : isPaused
              ? 'Resume'
              : isLoading
              ? 'Pause connecting'
              : 'Retry connection'
          }
        >
          {(isPlaying || isLoading) && '⏸ Pause'}
          {isPaused && '▶ Resume'}
          {isError && '↻ Retry'}
        </button>

        <button
          type="button"
          className="button radiowidget__btn"
          onClick={onStop}
          aria-label={`Stop ${station.title}`}
          title="Stop playback"
        >
          ⏹ Stop
        </button>
      </div>
    </aside>
  );
}
