import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import {
  parseRouteSnap,
  parseRouteStaging,
  parseRouteVertices,
  parseRouteWaypoints,
  serializeRouteWaypoints,
  routeJson,
  type RouteRow,
} from '../src/routes.js';

type Visibility = 'private' | 'unlisted' | 'public';
type RouteType = 'sprint' | 'circuit';

function insertRoute(
  db: ReturnType<typeof createDb>,
  opts: {
    id?: string;
    ownerId?: string;
    name?: string;
    notes?: string;
    access?: string;
    type?: RouteType;
    vertices?: [number, number][];
    staging?: { lat: number; lng: number } | null;
    waypoints?: [number, number][];
    snap?: boolean;
    visibility?: Visibility;
  } = {},
) {
  const id = opts.id ?? 'r1';
  const now = new Date().toISOString();
  db.handle
    .prepare(
      'INSERT INTO routes (id, owner_id, name, notes, access, type, vertices, waypoints, snap, staging, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      opts.ownerId ?? 'u1',
      opts.name ?? 'Test Route',
      opts.notes ?? '',
      opts.access ?? '',
      opts.type ?? 'sprint',
      JSON.stringify(opts.vertices ?? [[151.2, -33.8], [151.3, -33.7]]),
      opts.waypoints === undefined ? null : JSON.stringify(opts.waypoints),
      opts.snap ? 1 : 0,
      opts.staging ? JSON.stringify(opts.staging) : null,
      opts.visibility ?? 'private',
      now,
      now,
    );
  return id;
}

function getRoute(db: ReturnType<typeof createDb>, id = 'r1'): RouteRow {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow | undefined;
  assert.ok(row, `expected route ${id}`);
  return row;
}

test('routes: a persisted route round-trips ordered vertices, type, staging and visibility', () => {
  const db = createDb(':memory:');
  insertRoute(db, {
    vertices: [[151.2, -33.8], [151.3, -33.7], [151.4, -33.6]],
    type: 'circuit',
    staging: { lat: -33.85, lng: 151.15 },
    visibility: 'public',
  });

  const out = routeJson(getRoute(db));
  assert.equal(out.type, 'circuit');
  assert.deepEqual(out.vertices, [[151.2, -33.8], [151.3, -33.7], [151.4, -33.6]]);
  assert.deepEqual(out.staging, { lat: -33.85, lng: 151.15 });
  assert.equal(out.visibility, 'public');
});

test('routes: waypoints and snap settings persist and serialize', () => {
  const db = createDb(':memory:');
  const waypoints: [number, number][] = [[151.2, -33.8], [151.3, -33.7]];
  insertRoute(db, { waypoints, snap: true });
  assert.deepEqual(routeJson(getRoute(db)).waypoints, waypoints);
  assert.equal(routeJson(getRoute(db)).snap, true);
});

test('routes: null waypoints clear the column, valid ones serialize', () => {
  assert.equal(serializeRouteWaypoints(null), null);
  assert.equal(serializeRouteWaypoints([[151.2, -33.8]]), '[[151.2,-33.8]]');
  assert.throws(() => serializeRouteWaypoints('bad'));
});

test('routes: legacy rows omit waypoints and default snap to false', () => {
  const db = createDb(':memory:');
  insertRoute(db);
  const out = routeJson(getRoute(db));
  assert.equal('waypoints' in out, false);
  assert.equal(out.snap, false);
});

test('routes: staging is nullable and separate from route vertices', () => {
  const db = createDb(':memory:');
  insertRoute(db, { type: 'sprint', staging: null });

  const out = routeJson(getRoute(db));
  assert.equal(out.staging, null);
  assert.deepEqual(out.vertices, [[151.2, -33.8], [151.3, -33.7]]);
});

test('routes: can update vertices and type without reordering vertices', () => {
  const db = createDb(':memory:');
  insertRoute(db);
  const newVertices: [number, number][] = [[0, 0], [1, 1], [2, 2], [3, 3]];

  db.handle.prepare('UPDATE routes SET vertices = ?, type = ? WHERE id = ?').run(
    JSON.stringify(newVertices), 'circuit', 'r1',
  );

  const out = routeJson(getRoute(db));
  assert.equal(out.type, 'circuit');
  assert.deepEqual(out.vertices, newVertices);
});

test('routes: can delete a route', () => {
  const db = createDb(':memory:');
  insertRoute(db);

  db.handle.prepare('DELETE FROM routes WHERE id = ?').run('r1');

  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get('r1');
  assert.equal(row, undefined);
});

test('routes: multiple routes list in name order', () => {
  const db = createDb(':memory:');
  insertRoute(db, { id: 'r1', name: 'Zeta Route' });
  insertRoute(db, { id: 'r2', name: 'Alpha Route' });
  insertRoute(db, { id: 'r3', name: 'Beta Route' });

  const rows = db.handle.prepare('SELECT id FROM routes ORDER BY name').all() as unknown as { id: string }[];

  assert.deepEqual(rows.map((r) => r.id), ['r2', 'r3', 'r1']);
});

test('routes: vertex validation requires finite [lng, lat] pairs in bounds', () => {
  assert.deepEqual(parseRouteVertices([[151.2, -33.8], [151.3, -33.7]]), [[151.2, -33.8], [151.3, -33.7]]);
  assert.throws(() => parseRouteVertices('bad'), /vertices must be an array/);
  assert.throws(() => parseRouteVertices([[151.2, 'bad']]), /vertex 1 must be \[lng, lat\] numbers/);
  assert.throws(() => parseRouteVertices([[181, -33.8]]), /outside valid lng\/lat bounds/);
});

test('routes: waypoint and snap validation reject malformed input', () => {
  assert.deepEqual(parseRouteWaypoints([[151.2, -33.8]]), [[151.2, -33.8]]);
  assert.throws(() => parseRouteWaypoints([[151.2, 91]]), /waypoint 1 is outside valid lng\/lat bounds/);
  assert.throws(() => parseRouteWaypoints([[151.2, 'bad']]), /waypoint 1 must be \[lng, lat\] numbers/);
  assert.equal(parseRouteSnap(true), true);
  assert.throws(() => parseRouteSnap(1), /snap must be a boolean/);
});

test('routes: opening a pre-waypoint database adds compatible columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'location-scout-routes-'));
  const file = path.join(dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE routes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', access TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'sprint', vertices TEXT NOT NULL DEFAULT '[]', staging TEXT, visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  legacy.close();
  try {
    const db = createDb(file);
    const cols = db.handle.prepare('PRAGMA table_info(routes)').all() as { name: string }[];
    assert.ok(cols.some((col) => col.name === 'waypoints'));
    assert.ok(cols.some((col) => col.name === 'snap'));
    db.handle.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes: staging validation accepts null or finite lat/lng in bounds', () => {
  assert.equal(parseRouteStaging(null), null);
  assert.deepEqual(parseRouteStaging({ lat: -33.85, lng: 151.15 }), { lat: -33.85, lng: 151.15 });
  assert.throws(() => parseRouteStaging({ lat: -33.85 }), /staging must be null or \{ lat, lng \}/);
  assert.throws(() => parseRouteStaging({ lat: -91, lng: 151.15 }), /staging is outside valid lat\/lng bounds/);
});
