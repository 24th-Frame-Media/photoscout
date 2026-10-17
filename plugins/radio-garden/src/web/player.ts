import type { RadioStation } from './types.js';

/**
 * The radio audio controller, moved here from the app's RadioPanel with its
 * behaviour unchanged. It has no UI and no dependency on the app, so it is
 * tested on its own.
 */

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export const DEFAULT_RADIO_CONNECTION_TIMEOUT_MS = 15_000;
export const RADIO_STREAM_UNAVAILABLE_ERROR = 'Stream unavailable. The station may be offline or geo-blocked.';

type AudioHandler = ((ev: Event) => void) | null;

/** The slice of HTMLAudioElement the controller uses, so a test can pass a fake. */
export interface AudioElementLike {
  src: string;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  onplaying: AudioHandler;
  onwaiting: AudioHandler;
  onpause: AudioHandler;
  onerror: AudioHandler;
  onended: AudioHandler;
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

const isAbort = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

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

  /** A failed play(): a real failure ends in the error state; an AbortError (a newer load interrupted it) and a stale element are ignored. */
  private failPlay(audio: AudioElementLike, err: unknown, message: string): void {
    if (this.activeAudio !== audio) return;
    if (isAbort(err)) return;
    this.clearConnectionTimeout();
    this.stopAudioInternal();
    this.playbackState = 'error';
    this.playbackError = message;
    this.notifyState();
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

      const message = 'Playback failed. The stream may be offline or unreachable.';
      try {
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err: unknown) => this.failPlay(audio, err, message));
        }
      } catch (err) {
        this.failPlay(audio, err, message);
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
    const message = 'Playback failed. The station stream may be offline.';
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => this.failPlay(audio, err, message));
      }
    } catch (err) {
      this.failPlay(audio, err, message);
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
