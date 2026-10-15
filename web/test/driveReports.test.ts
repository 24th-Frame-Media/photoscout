import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upcomingReports } from '../src/drive/reports.js';
import { reportLabel, reportIconType, reportEmoji } from '../src/map/waze.js';
import type { WazeAlert } from '../src/api.js';

const now = 1791989400000;
const route: [number, number][] = [[151.2, -33.87], [151.22, -33.87]];
const report = (id: string, lng: number, lat = -33.87, reportTime: number | null = now): WazeAlert => ({ id, type: 'POLICE', point: [lng, lat], reportTime });

test('navigation warns only for fresh reports on the road ahead', () => {
  const alerts = [report('ahead', 151.21), report('behind', 151.201), report('parallel', 151.21, -33.872), report('old', 151.212, -33.87, now - 3 * 3600_000), report('future', 151.212, -33.87, now + 120000)];
  const upcoming = upcomingReports(alerts, route, [151.205, -33.87], now);
  assert.deepEqual(upcoming.map(r => r.alert.id), ['ahead']);
  assert.ok(upcoming[0].distanceM > 450 && upcoming[0].distanceM < 470);
  assert.deepEqual(upcomingReports(alerts, route, [151.205, -33.88], now), []);
});

test('camera warnings can omit report timestamps and police labels preserve subtype', () => {
  const camera = { ...report('camera', 151.207, -33.87, null), type: 'CAMERA' };
  assert.equal(upcomingReports([camera], route, [151.205, -33.87], now).length, 1);
  assert.equal(reportLabel({ type: 'POLICE', subType: 'POLICE_HIDDEN' }), 'Police hiding nearby');
  assert.equal(reportLabel({ type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA' }), 'Mobile speed camera reported');
  assert.equal(reportIconType({ type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA' }), 'CAMERA');
  assert.equal(reportIconType({ type: 'POLICE', subType: 'POLICE_WITH_MOBILE_CAMERA' }), 'CAMERA');
  assert.equal(reportIconType({ type: 'POLICE', subType: 'POLICE_DEFAULT' }), 'POLICE');
  assert.equal(reportEmoji({ type: 'POLICE' }), '👮');
});
