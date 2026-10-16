import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RADIO_CONNECTION_TIMEOUT_MS,
  RADIO_STREAM_UNAVAILABLE_ERROR,
  RadioAudioController,
} from '../src/web/player.js';
import type { RadioStation } from '../src/web/types.js';

// The audio controller moved here from the app's RadioPanel (web/src/components) with the radio-garden web bundle.

test('Player lifecycle: no autoplay, cleans up previous stream, and handles errors', () => {
  // Test simulated player state transitions matching RadioPanel
  class MockAudio {
    src = '';
    paused = true;
    hasAttribute = true;
    listeners: Record<string, () => void> = {};

    addEventListener(event: string, fn: () => void) {
      this.listeners[event] = fn;
    }
    removeEventListener(event: string) {
      delete this.listeners[event];
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    load() {
      // resets buffer
    }
  }

  const s1: RadioStation = {
    id: 'st-1',
    title: 'Station 1',
    placeId: 'pl-1',
    listenUrl: '/api/plugins/media.24thframe.radio-garden/stations/st-1/listen',
  };
  const s2: RadioStation = {
    id: 'st-2',
    title: 'Station 2',
    placeId: 'pl-1',
    listenUrl: '/api/plugins/media.24thframe.radio-garden/stations/st-2/listen',
  };

  // State tracker
  let activeAudio: MockAudio | null = null;
  let activeStationId: string | null = null;
  let playbackState: 'idle' | 'loading' | 'playing' | 'paused' | 'error' = 'idle';

  function cleanupAudio() {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.removeAttribute('src');
      activeAudio.load();
      activeAudio = null;
    }
  }

  function playStation(st: RadioStation) {
    cleanupAudio();
    activeStationId = st.id;
    playbackState = 'loading';
    const audio = new MockAudio();
    activeAudio = audio;
    audio.src = st.listenUrl;
    audio.play();
    playbackState = 'playing';
  }

  // 1. Initial selection has no autoplay
  assert.equal(activeAudio, null);
  assert.equal(playbackState, 'idle');

  // 2. Manual play starts station 1
  playStation(s1);
  assert.equal(activeStationId, 'st-1');
  assert.equal(playbackState, 'playing');
  assert.equal(activeAudio!.src, '/api/plugins/media.24thframe.radio-garden/stations/st-1/listen');
  assert.equal(activeAudio!.paused, false);

  const prevAudio = activeAudio!;

  // 3. Selecting station 2 stops and replaces previous audio
  playStation(s2);
  assert.equal(prevAudio.paused, true, 'previous audio was paused');
  assert.equal(prevAudio.src, '', 'previous audio src was cleared');
  assert.equal(activeStationId, 'st-2');
  assert.equal(activeAudio!.src, '/api/plugins/media.24thframe.radio-garden/stations/st-2/listen');

  // 4. Cleanup on close or unmount
  cleanupAudio();
  assert.equal(activeAudio, null);
});

test('DEFAULT_RADIO_CONNECTION_TIMEOUT_MS is 15 seconds', () => {
  assert.equal(DEFAULT_RADIO_CONNECTION_TIMEOUT_MS, 15_000);
});

test('RadioAudioController: connection timeout triggers terminal unavailable state and releases audio when playback stalls in connecting', async () => {
  class TestAudio {
    src = '';
    paused = true;
    released = false;
    onplaying: ((ev?: any) => void) | null = null;
    onwaiting: ((ev?: any) => void) | null = null;
    onpause: ((ev?: any) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onended: ((ev?: any) => void) | null = null;

    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    load() {
      this.released = true;
    }
  }

  let createdAudio: TestAudio | null = null;
  const timeoutMs = 25;

  const controller = new RadioAudioController({
    connectionTimeoutMs: timeoutMs,
    audioFactory: () => {
      createdAudio = new TestAudio();
      return createdAudio as any;
    },
  });

  const station2MCE: RadioStation = {
    id: '7gjakH-C',
    title: '2MCE FM 92.3 Charles Sturt University',
    placeId: 'DdiFsWw5',
    streamDomain: '2mce.org',
    listenUrl: '/api/plugins/media.24thframe.radio-garden/stations/7gjakH-C/listen',
  };

  // 1. User selects 2MCE FM 92.3
  controller.playStation(station2MCE);

  assert.equal(controller.getState().activeStation?.id, '7gjakH-C');
  assert.equal(controller.getState().playbackState, 'loading');
  assert.equal(controller.hasPendingTimeout(), true, 'connection timeout is armed');
  assert.ok(createdAudio, 'audio element created');
  const targetAudio = createdAudio as TestAudio;
  assert.equal(targetAudio.src, '/api/plugins/media.24thframe.radio-garden/stations/7gjakH-C/listen');

  // 2. Audio stalls in loading and does not reach playing within timeout
  await new Promise((resolve) => setTimeout(resolve, timeoutMs + 15));

  // 3. Controller must have stopped/released audio and entered terminal error state
  const stateAfterTimeout = controller.getState();
  assert.equal(stateAfterTimeout.playbackState, 'error', 'transitions to error on timeout');
  assert.equal(
    stateAfterTimeout.playbackError,
    RADIO_STREAM_UNAVAILABLE_ERROR,
    'displays clear stream unavailable error'
  );
  assert.equal(controller.hasPendingTimeout(), false, 'timer is cleared');
  assert.equal(targetAudio.paused, true, 'audio element was paused');
  assert.equal(targetAudio.src, '', 'audio src was removed');
  assert.equal(targetAudio.released, true, 'audio load() called to release buffers');
  assert.equal(controller.getActiveAudio(), null, 'audio reference cleared');
  assert.equal(stateAfterTimeout.activeStation?.id, '7gjakH-C', 'active station retained for retry');

  controller.destroy();
});

test('RadioAudioController: clears connection timer for playing, error, station replacement, pause, stop, and destroy', () => {
  class TestAudio {
    src = '';
    paused = true;
    onplaying: ((ev?: any) => void) | null = null;
    onwaiting: ((ev?: any) => void) | null = null;
    onpause: ((ev?: any) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onended: ((ev?: any) => void) | null = null;

    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    load() {}
  }

  let audios: TestAudio[] = [];
  const controller = new RadioAudioController({
    connectionTimeoutMs: 10_000,
    audioFactory: () => {
      const a = new TestAudio();
      audios.push(a);
      return a as any;
    },
  });

  const s1: RadioStation = { id: 's1', title: 'Station 1', placeId: 'p1', listenUrl: '/s1' };
  const s2: RadioStation = { id: 's2', title: 'Station 2', placeId: 'p1', listenUrl: '/s2' };

  // A. Cleared on playing
  controller.playStation(s1);
  assert.equal(controller.hasPendingTimeout(), true);
  audios[audios.length - 1].onplaying!();
  assert.equal(controller.getState().playbackState, 'playing');
  assert.equal(controller.hasPendingTimeout(), false, 'cleared on playing');

  // B. Cleared on error
  controller.playStation(s1);
  assert.equal(controller.hasPendingTimeout(), true);
  audios[audios.length - 1].onerror!();
  assert.equal(controller.getState().playbackState, 'error');
  assert.equal(controller.hasPendingTimeout(), false, 'cleared on error');

  // C. Cleared on station replacement
  controller.playStation(s1);
  assert.equal(controller.hasPendingTimeout(), true);
  const s1Audio = audios[audios.length - 1];
  controller.playStation(s2);
  const s2Audio = audios[audios.length - 1];
  assert.notEqual(s1Audio, s2Audio);
  assert.equal(controller.getState().activeStation?.id, 's2');
  assert.equal(controller.hasPendingTimeout(), true, 'new station has its own timer');

  // D. Cleared on manual pause
  controller.pause();
  assert.equal(controller.getState().playbackState, 'paused');
  assert.equal(controller.hasPendingTimeout(), false, 'cleared on manual pause');

  // E. Cleared on manual stop
  controller.resume();
  assert.equal(controller.hasPendingTimeout(), true);
  controller.stop();
  assert.equal(controller.getState().playbackState, 'idle');
  assert.equal(controller.hasPendingTimeout(), false, 'cleared on manual stop');

  // F. Cleared on destroy/unmount
  controller.playStation(s1);
  assert.equal(controller.hasPendingTimeout(), true);
  controller.destroy();
  assert.equal(controller.hasPendingTimeout(), false, 'cleared on destroy/unmount');
});

test('RadioAudioController: stale callbacks from previous station do not affect newer station', async () => {
  class TestAudio {
    src = '';
    paused = true;
    onplaying: ((ev?: any) => void) | null = null;
    onwaiting: ((ev?: any) => void) | null = null;
    onpause: ((ev?: any) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onended: ((ev?: any) => void) | null = null;

    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    load() {}
  }

  let audio1: TestAudio | null = null;
  let audio2: TestAudio | null = null;
  let count = 0;

  const controller = new RadioAudioController({
    connectionTimeoutMs: 200,
    audioFactory: () => {
      count++;
      if (count === 1) {
        audio1 = new TestAudio();
        return audio1 as any;
      }
      audio2 = new TestAudio();
      return audio2 as any;
    },
  });

  const s1: RadioStation = { id: 's1', title: 'Station 1', placeId: 'p1', listenUrl: '/s1' };
  const s2: RadioStation = { id: 's2', title: 'Station 2', placeId: 'p1', listenUrl: '/s2' };

  // Select station 1
  controller.playStation(s1);
  const oldAudio = audio1!;
  const oldOnPlaying = oldAudio.onplaying;
  const oldOnError = oldAudio.onerror;

  // Quickly switch to station 2 before station 1 timeout expires
  controller.playStation(s2);
  assert.equal(controller.getState().activeStation?.id, 's2');
  assert.equal(controller.getState().playbackState, 'loading');

  // Stale audio 1 events fire after replacement
  if (oldOnPlaying) oldOnPlaying();
  if (oldOnError) oldOnError();

  // Station 2 must still be in its loading state with its own timer (not affected by station 1's callbacks)
  assert.equal(controller.getState().activeStation?.id, 's2');
  assert.equal(controller.getState().playbackState, 'loading');
  assert.equal(controller.hasPendingTimeout(), true);

  // Now let station 2 successfully play
  audio2!.onplaying!();
  assert.equal(controller.getState().activeStation?.id, 's2');
  assert.equal(controller.getState().playbackState, 'playing');
  assert.equal(controller.getState().playbackError, null);
  assert.equal(controller.hasPendingTimeout(), false);

  controller.destroy();
});

test('RadioAudioController: old connection timeout cannot mutate newer station after delay expires', async () => {
  class TestAudio {
    src = '';
    paused = true;
    released = false;
    onplaying: ((ev?: any) => void) | null = null;
    onwaiting: ((ev?: any) => void) | null = null;
    onpause: ((ev?: any) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onended: ((ev?: any) => void) | null = null;

    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    load() {
      this.released = true;
    }
  }

  let audios: TestAudio[] = [];
  const controller = new RadioAudioController({
    connectionTimeoutMs: 30,
    audioFactory: () => {
      const a = new TestAudio();
      audios.push(a);
      return a as any;
    },
  });

  const s1: RadioStation = { id: 's1', title: 'Station 1', placeId: 'p1', listenUrl: '/s1' };
  const s2: RadioStation = { id: 's2', title: 'Station 2', placeId: 'p1', listenUrl: '/s2' };

  // Start station 1
  controller.playStation(s1);
  assert.equal(controller.getState().activeStation?.id, 's1');
  assert.equal(controller.getState().playbackState, 'loading');

  // After 10ms (before s1 30ms timeout), user selects station 2 with longer timeout (60ms)
  await new Promise((r) => setTimeout(r, 10));
  controller.setConnectionTimeoutMs(60);
  controller.playStation(s2);
  assert.equal(controller.getState().activeStation?.id, 's2');
  assert.equal(controller.getState().playbackState, 'loading');

  // Wait until s1's original 30ms timer would have fired (e.g. at 35ms total)
  await new Promise((r) => setTimeout(r, 35));

  // Station 2 MUST still be loading and NOT mutated into error by station 1's timer
  assert.equal(controller.getState().activeStation?.id, 's2', 's2 is still active');
  assert.equal(controller.getState().playbackState, 'loading', 's2 still in loading state');
  assert.equal(controller.getState().playbackError, null);
  assert.equal(controller.hasPendingTimeout(), true, 's2 has its own active timeout');

  // Station 2 successfully emits onplaying
  audios[1].onplaying!();
  assert.equal(controller.getState().activeStation?.id, 's2');
  assert.equal(controller.getState().playbackState, 'playing');
  assert.equal(controller.hasPendingTimeout(), false, 'cleared upon successful play');

  controller.destroy();
});

test('Panel close persistence: closing station panel preserves playback, widget retains control, stop releases audio', () => {
  class TestAudio {
    src = '';
    paused = true;
    released = false;
    onplaying: ((ev?: any) => void) | null = null;
    onwaiting: ((ev?: any) => void) | null = null;
    onpause: ((ev?: any) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onended: ((ev?: any) => void) | null = null;

    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    load() {
      this.released = true;
    }
  }

  let createdAudio: TestAudio | null = null;
  const controller = new RadioAudioController({
    connectionTimeoutMs: 10_000,
    audioFactory: () => {
      createdAudio = new TestAudio();
      return createdAudio as any;
    },
  });

  const station: RadioStation = {
    id: 'st-syd',
    title: 'FBi Radio 94.5 FM',
    placeId: 'pl-syd',
    listenUrl: '/api/plugins/media.24thframe.radio-garden/stations/st-syd/listen',
  };

  // Simulating MapPage state
  let selectedRadioPlace: { id: string; title: string } | null = { id: 'pl-syd', title: 'Sydney' };

  // 1. User starts station from station panel
  controller.playStation(station);
  assert.ok(createdAudio);
  const audio = createdAudio as TestAudio;
  assert.equal(controller.getState().activeStation?.id, 'st-syd');
  assert.equal(controller.getState().playbackState, 'loading');

  // Audio reaches playing
  audio.onplaying!();
  assert.equal(controller.getState().playbackState, 'playing');

  // 2. User closes station panel (onClose called -> selectedRadioPlace = null)
  selectedRadioPlace = null;

  // Crucial requirement: player ownership in MapPage means panel close does NOT pause or stop audio
  assert.equal(selectedRadioPlace, null, 'station panel is closed');
  assert.equal(controller.getState().activeStation?.id, 'st-syd', 'station remains active after panel close');
  assert.equal(controller.getState().playbackState, 'playing', 'playback continues playing');
  assert.equal(audio.paused, false, 'audio element is not paused');

  // 3. Persistent widget controls: pause from widget
  controller.pause();
  assert.equal(controller.getState().playbackState, 'paused');
  assert.equal(audio.paused, true);
  assert.equal(controller.getState().activeStation?.id, 'st-syd', 'widget remains available while paused');

  // Resume from widget
  controller.resume();
  assert.equal(controller.getState().playbackState, 'loading');
  audio.onplaying!();
  assert.equal(controller.getState().playbackState, 'playing');

  // 4. User clicks explicit Stop on widget
  controller.stop();
  assert.equal(controller.getState().activeStation, null, 'active station is cleared, removing widget');
  assert.equal(controller.getState().playbackState, 'idle');
  assert.equal(audio.paused, true, 'audio is paused');
  assert.equal(audio.src, '', 'audio src is cleared');
  assert.equal(audio.released, true, 'audio load() called to release buffers');

  controller.destroy();
});
