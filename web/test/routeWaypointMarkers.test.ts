import assert from 'node:assert/strict';
import test from 'node:test';
import { updateRouteWaypointElement } from '../src/map/routeWaypointMarkers.js';

test('waypoint refresh preserves MapLibre marker positioning classes', () => {
  const classes = new Set(['maplibregl-marker', 'maplibregl-marker-anchor-center', 'route-waypoint-handle--via']);
  const element = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
    },
    textContent: '',
    title: '',
  } as unknown as HTMLElement;

  updateRouteWaypointElement(element, 0, 3);

  assert.equal(classes.has('maplibregl-marker'), true);
  assert.equal(classes.has('maplibregl-marker-anchor-center'), true);
  assert.equal(classes.has('route-waypoint-handle--start'), true);
  assert.equal(classes.has('route-waypoint-handle--via'), false);
  assert.equal(element.textContent, 'A');
});
