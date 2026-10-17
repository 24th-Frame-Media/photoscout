import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { createDb } from '../src/db.js';
import { forEachCsvRow } from '../src/csv.js';
import {
  bearingDeg, buildPointPassesResponse, clampPassHours, cumulativeKm, emptyFeedData, isServiceActiveOn, isTrainRoute, loadFeedData, nextPasses, parseGtfsTime,
  parsePointPassRequest, PATH_BACK_KM, predictTrainPositions, shapeSlice, storeStaticGtfsZip, TrainsFeedData, vehicleExtras,
} from '../src/feeds/trains.js';

test('parseGtfsTime: handles times past midnight (>24:00:00)', () => {
  assert.equal(parseGtfsTime('00:00:00'), 0);
  assert.equal(parseGtfsTime('09:05:30'), 9 * 3600 + 5 * 60 + 30);
  assert.equal(parseGtfsTime('25:30:00'), 25 * 3600 + 30 * 60); // a service still running the next calendar day
});

const cal = { serviceId: 'weekday', days: [true, true, true, true, true, false, false] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean], startDate: '20260101', endDate: '20261231' };

test('isServiceActiveOn: weekday calendar, date range, and weekday mapping', () => {
  // 2026-01-05 is a Monday.
  assert.equal(isServiceActiveOn(cal, '20260105', new Date('2026-01-05T00:00:00').getDay()), true);
  // 2026-01-10 is a Saturday.
  assert.equal(isServiceActiveOn(cal, '20260110', new Date('2026-01-10T00:00:00').getDay()), false);
  assert.equal(isServiceActiveOn(cal, '20250105', new Date('2025-01-05T00:00:00').getDay()), false, 'before the service period');
});

/**
 * A tiny fixture: a straight shape from A (dist 0) to B (dist ~11.1km),
 * departing A at 09:00:00 and arriving B at 09:10:00 — a steady 66.7km/h run.
 */
function fixture(): TrainsFeedData {
  const feed = emptyFeedData();
  feed.routes.set('R1', { id: 'R1', shortName: 'BB', longName: 'Bathurst Bullet' });
  feed.trips.push({ id: 'T1', routeId: 'R1', serviceId: 'weekday', shapeId: 'S1', headsign: 'Bathurst' });
  feed.stopsById.set('A', { id: 'A', name: 'Stop A', lat: -33.0, lng: 150.0 });
  feed.stopsById.set('B', { id: 'B', name: 'Stop B', lat: -33.1, lng: 150.0 });
  feed.stopTimesByTrip.set('T1', [
    { stopId: 'A', seq: 1, arrivalSec: parseGtfsTime('09:00:00'), departureSec: parseGtfsTime('09:00:00') },
    { stopId: 'B', seq: 2, arrivalSec: parseGtfsTime('09:10:00'), departureSec: parseGtfsTime('09:10:00') },
  ]);
  feed.shapesById.set('S1', [{ lat: -33.0, lng: 150.0 }, { lat: -33.05, lng: 150.0 }, { lat: -33.1, lng: 150.0 }]);
  feed.calendarByService.set('weekday', cal);
  return feed;
}

test('predictTrainPositions: halfway through the run, on a day the service runs', () => {
  const feed = fixture();
  const at = new Date('2026-01-05T09:05:00'); // Monday, halfway between 09:00 and 09:10
  const [pos] = predictTrainPositions(feed, at, []);
  assert.ok(pos, 'a position was predicted');
  assert.equal(pos.status, 'scheduled');
  assert.ok(Math.abs(pos.lat - -33.05) < 0.005, `expected ~halfway (-33.05), got ${pos.lat}`);
});

test('predictTrainPositions: a realtime vehicle position wins over the interpolated one, and is marked live', () => {
  const feed = fixture();
  const at = new Date('2026-01-05T09:05:00');
  const [pos] = predictTrainPositions(feed, at, [{ tripId: 'T1', delaySec: 0, vehicleLat: -33.02, vehicleLng: 150.0 }]);
  assert.equal(pos.status, 'live');
  assert.equal(pos.lat, -33.02);
});

test('predictTrainPositions: nothing running outside the trip\'s window, or on a day off', () => {
  const feed = fixture();
  assert.equal(predictTrainPositions(feed, new Date('2026-01-05T08:00:00'), []).length, 0, 'before the trip starts');
  assert.equal(predictTrainPositions(feed, new Date('2026-01-10T09:05:00'), []).length, 0, 'Saturday: service off');
});

test('nextPasses: finds the scheduled time nearest a spot on the line, within the window', () => {
  const feed = fixture();
  const spot = { lat: -33.05, lng: 150.0 }; // right at the shape's midpoint
  const now = new Date('2026-01-05T06:00:00'); // Monday morning, before the 09:00 departure
  const passes = nextPasses(feed, spot, 6, now);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].tripId, 'T1');
  const hhmm = `${String(passes[0].at.getHours()).padStart(2, '0')}:${String(passes[0].at.getMinutes()).padStart(2, '0')}`;
  assert.equal(hhmm, '09:05', 'local time, timezone-independent: midpoint in distance ≈ midpoint in time here');
});

test('nextPasses: a spot far from the line gets nothing', () => {
  const feed = fixture();
  const passes = nextPasses(feed, { lat: -33.05, lng: 152.0 }, 24, new Date('2026-01-05T06:00:00'));
  assert.equal(passes.length, 0);
});

test('predictTrainPositions: a realtime vehicle with no running scheduled trip is still shown, as live', () => {
  const feed = fixture();
  const at = new Date('2026-01-05T08:00:00'); // before T1's window
  const out = predictTrainPositions(feed, at, [
    { tripId: 'T1', delaySec: 120, vehicleLat: -33.01, vehicleLng: 150.0 },
    { tripId: 'UNKNOWN', delaySec: 0, vehicleLat: -33.5, vehicleLng: 150.5 },
    { tripId: 'NOPOS', delaySec: 0 },
  ]);
  assert.equal(out.length, 2, 'the entry without a position is dropped');
  const t1 = out.find((p) => p.tripId === 'T1')!;
  assert.equal(t1.status, 'live');
  assert.equal(t1.route, 'BB', 'route and headsign come from the static trip when known');
  assert.equal(t1.headsign, 'Bathurst');
  assert.equal(t1.delaySec, 120);
  assert.equal(out.find((p) => p.tripId === 'UNKNOWN')!.status, 'live');
});

test('predictTrainPositions: scheduled trains carry bearing, speed, network and a shape slice around them', () => {
  const feed = fixture();
  feed.trips[0].feed = 'nswtrains';
  const [pos] = predictTrainPositions(feed, new Date('2026-01-05T09:05:00'), []);
  assert.ok(Math.abs(pos.bearing! - 180) < 0.5, `heading south, got ${pos.bearing}`);
  assert.ok(Math.abs(pos.speedMps! - 11_132 / 600) < 0.5, `~18.5 m/s scheduled, got ${pos.speedMps}`);
  assert.equal(pos.network, 'nswtrains');
  assert.equal(pos.carriages, null);
  assert.ok(pos.path && pos.path.length >= 2);
  assert.ok(Math.abs(pos.pathAtKm! - PATH_BACK_KM) < 0.01, 'train sits PATH_BACK_KM into its slice');
});

test('predictTrainPositions: realtime bearing, speed and carriages win', () => {
  const [pos] = predictTrainPositions(fixture(), new Date('2026-01-05T09:05:00'), [
    { tripId: 'T1', delaySec: 0, vehicleLat: -33.02, vehicleLng: 150.0, bearing: 179, speedMps: 22, carriages: 8 },
  ]);
  assert.equal(pos.bearing, 179);
  assert.equal(pos.speedMps, 22);
  assert.equal(pos.carriages, 8);
  assert.ok(pos.path, 'on the shape, so it gets a path');
});

test('shapeSlice: clamps to the line, re-bases atKm and interpolates the ends', () => {
  const line: [number, number][] = [[150, -33], [150, -33.1]]; // ~11.13 km due south
  const s = shapeSlice(line, 5, 1, 2)!;
  assert.ok(Math.abs(s.atKm - 1) < 1e-9);
  const cum = cumulativeKm(s.path);
  assert.ok(Math.abs(cum.at(-1)! - 3) < 0.01, `slice ~3km, got ${cum.at(-1)}`);
  assert.ok(Math.abs(s.bearing! - 180) < 1e-6);
  const start = shapeSlice(line, 0.2, 1, 1)!;
  assert.ok(Math.abs(start.atKm - 0.2) < 1e-9, 'clamped at the start');
  assert.equal(Math.round(bearingDeg([150, -33], [150.01, -33])), 90);
});

test('vehicleExtras: bearing/speed/carriages, with protobuf zero defaults treated as absent', () => {
  assert.deepEqual(vehicleExtras({ position: { bearing: 90, speed: 12 }, multiCarriageDetails: [{}, {}, {}, {}] }), { bearing: 90, speedMps: 12, carriages: 4 });
  assert.deepEqual(vehicleExtras({ position: { bearing: 0, speed: 0 } }), {});
  assert.deepEqual(vehicleExtras({ position: { bearing: -90 } }), { bearing: 270 });
  assert.deepEqual(vehicleExtras(null), {});
});

test('parsePointPassRequest: requires finite in-range coordinates and clamps hours to 1..24', () => {
  assert.deepEqual(parsePointPassRequest({ lat: '-33.05', lng: '150', hours: '0' }), { ok: true, point: { lat: -33.05, lng: 150 }, hours: 1 });
  assert.deepEqual(parsePointPassRequest({ lat: '-33.05', lng: '150', hours: '48' }), { ok: true, point: { lat: -33.05, lng: 150 }, hours: 24 });
  assert.deepEqual(parsePointPassRequest({ lat: '-33.05', lng: '150', hours: 'nope' }), { ok: true, point: { lat: -33.05, lng: 150 }, hours: 6 });
  assert.deepEqual(parsePointPassRequest({ lat: 'Infinity', lng: '150' }), { ok: false, error: 'lat and lng are required' });
  assert.deepEqual(parsePointPassRequest({ lat: '-91', lng: '150' }), { ok: false, error: 'lat and lng are required' });
});

test('buildPointPassesResponse: configured, not configured, and no-pass states', () => {
  const feed = fixture();
  const now = new Date('2026-01-05T06:00:00');
  assert.deepEqual(buildPointPassesResponse(false, feed, { lat: -33.05, lng: 150 }, 6, now), { configured: false, passes: [] });

  const noPasses = buildPointPassesResponse(true, feed, { lat: -33.05, lng: 152 }, 6, now);
  assert.equal(noPasses.configured, true);
  assert.deepEqual(noPasses.passes, []);

  const withPasses = buildPointPassesResponse(true, feed, { lat: -33.05, lng: 150 }, 6, now);
  assert.equal(withPasses.configured, true);
  assert.deepEqual(withPasses.passes.map((p) => ({ tripId: p.tripId, route: p.route, headsign: p.headsign })), [
    { tripId: 'T1', route: 'BB', headsign: 'Bathurst' },
  ]);
  const at = new Date(withPasses.passes[0].at);
  assert.equal(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, '09:05');
});

test('isTrainRoute: route_type decides; without it, TrainLink coach ids ("4T.C.<n>") are not trains', () => {
  assert.equal(isTrainRoute('4T.C.544'), false);
  assert.equal(isTrainRoute('4T.T.BMT'), true);
  assert.equal(isTrainRoute('BMT_1'), true);
  assert.equal(isTrainRoute(''), true);
  assert.equal(isTrainRoute('x', '2'), true);
  assert.equal(isTrainRoute('x', '106'), true);
  assert.equal(isTrainRoute('x', '204'), false);
  assert.equal(isTrainRoute('x', '714'), false);
  assert.equal(isTrainRoute('4T.C.1', '2'), true);
});

test('forEachCsvRow: streams rows, handles BOM, CRLF, and doubled quotes across chunk boundaries', () => {
  const pad = 'x'.repeat(65520);
  const csv = `\uFEFFid,label\r\n1,"${pad}""quoted"""\r\n2,plain\n`;
  const rows: [string, string][] = [];
  forEachCsvRow(strToU8(csv), (get) => rows.push([get('id'), get('label')]));
  assert.deepEqual(rows, [
    ['1', `${pad}"quoted"`],
    ['2', 'plain'],
  ]);
});

test('storeStaticGtfsZip: keeps only train trips touching configured areas and sorts stops/shapes', () => {
  const db = createDb(':memory:');
  const zip = Buffer.from(zipSync({
    'routes.txt': strToU8('route_id,route_short_name,route_long_name,route_type\nR_BMT,BMT,Blue Mountains Line,2\nR_COACH,4T.C.1,Coach,204\nR_FAR,FAR,Far Line,2\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_headsign,shape_id\nR_BMT,WKD,T_KEEP,Bathurst,SH_KEEP\nR_COACH,WKD,T_COACH,Lithgow,SH_KEEP\nR_FAR,WKD,T_FAR,Nowhere,SH_FAR\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nST_BATH,Bathurst,-33.42,149.58\nST_LITH,Lithgow,-33.48,150.15\nST_FAR,Far,-30.0,140.0\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT_KEEP,10:00:00,10:00:00,ST_BATH,2\nT_KEEP,09:00:00,09:00:00,ST_LITH,1\nT_FAR,08:00:00,08:00:00,ST_FAR,1\n'),
    'shapes.txt': strToU8('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH_KEEP,-33.42,149.58,2\nSH_KEEP,-33.48,150.15,1\nSH_FAR,-30.0,140.0,1\n'),
    'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWKD,1,1,1,1,1,0,0,20260101,20261231\n'),
  }));
  const res = storeStaticGtfsZip(db, 'sydneytrains', zip, [{ lat: -33.42, lng: 149.58, radiusKm: 100 }], () => {});
  assert.deepEqual(res, { ok: true, message: '1 trips' });
  const loaded = loadFeedData(db, 'sydneytrains');
  assert.deepEqual(loaded.trips.map((t) => t.id), ['T_KEEP']);
  assert.deepEqual(loaded.stopTimesByTrip.get('T_KEEP')?.map((s) => s.stopId), ['ST_LITH', 'ST_BATH']);
  assert.deepEqual(loaded.shapesById.get('SH_KEEP')?.map((p) => p.lat), [-33.48, -33.42]);
});

