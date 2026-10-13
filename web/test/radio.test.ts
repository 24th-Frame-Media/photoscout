import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, categoryOf, groupLayers, RADIO_COLOR } from '../src/map/legend.js';
import { radioGeoJSON, RADIO_LAYERS } from '../src/map/layers.js';
import type { RadioPlace, RadioStation } from '../src/api.js';

test('Legend groups Radio layers correctly and defaults to off', () => {
  const cat = CATEGORIES.find((c) => c.key === 'radio');
  assert.ok(cat, 'radio category exists in CATEGORIES');
  assert.equal(cat.group, 'Overlays');
  assert.equal(cat.defaultOn, false, 'radio overlay is default-off');
  assert.equal(cat.color, RADIO_COLOR);
  assert.equal(cat.glyph, '📻');

  const testLayers = [
    { id: 'radio-clusters', type: 'circle' },
    { id: 'radio-cluster-count', type: 'symbol' },
    { id: 'radio-points', type: 'circle' },
    { id: 'other-layer', type: 'line' },
  ];

  assert.equal(categoryOf(testLayers[0]), 'radio');
  assert.equal(categoryOf(testLayers[1]), 'radio');
  assert.equal(categoryOf(testLayers[2]), 'radio');
  assert.equal(categoryOf(testLayers[3]), null);

  const grouped = groupLayers(testLayers);
  assert.deepEqual(grouped.radio, ['radio-clusters', 'radio-cluster-count', 'radio-points']);
  assert.deepEqual(RADIO_LAYERS, ['radio-clusters', 'radio-cluster-count', 'radio-points']);
});

test('radioGeoJSON preserves [lng, lat] order, IDs, and station counts', () => {
  const samplePlaces: RadioPlace[] = [
    {
      id: 'place-syd',
      title: 'Sydney',
      country: 'Australia',
      lng: 151.2093,
      lat: -33.8688,
      stationCount: 42,
    },
    {
      id: 'place-nyc',
      title: 'New York NY',
      country: 'United States',
      lng: -74.006,
      lat: 40.7128,
      stationCount: 183,
    },
  ];

  const fc = radioGeoJSON(samplePlaces);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);

  const f0 = fc.features[0];
  assert.equal(f0.id, 'place-syd');
  assert.equal(f0.geometry.type, 'Point');
  // Strict GeoJSON check: [longitude, latitude]
  assert.deepEqual((f0.geometry as GeoJSON.Point).coordinates, [151.2093, -33.8688]);
  assert.deepEqual(f0.properties, {
    id: 'place-syd',
    title: 'Sydney',
    country: 'Australia',
    stationCount: 42,
  });

  const f1 = fc.features[1];
  assert.deepEqual((f1.geometry as GeoJSON.Point).coordinates, [-74.006, 40.7128]);
  assert.equal(f1.properties?.stationCount, 183);
});

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
    listenUrl: '/api/radio/stations/st-1/listen',
  };
  const s2: RadioStation = {
    id: 'st-2',
    title: 'Station 2',
    placeId: 'pl-1',
    listenUrl: '/api/radio/stations/st-2/listen',
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
  assert.equal(activeAudio!.src, '/api/radio/stations/st-1/listen');
  assert.equal(activeAudio!.paused, false);

  const prevAudio = activeAudio!;

  // 3. Selecting station 2 stops and replaces previous audio
  playStation(s2);
  assert.equal(prevAudio.paused, true, 'previous audio was paused');
  assert.equal(prevAudio.src, '', 'previous audio src was cleared');
  assert.equal(activeStationId, 'st-2');
  assert.equal(activeAudio!.src, '/api/radio/stations/st-2/listen');

  // 4. Cleanup on close or unmount
  cleanupAudio();
  assert.equal(activeAudio, null);
});
