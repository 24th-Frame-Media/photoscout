import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsDecision } from '../src/cors.js';

const MAP = 'https://map.example';
const read = (path: string, origin: string | undefined = MAP) => ({ origin, method: 'GET', path });
const preflight = (path: string) => ({ origin: MAP, method: 'OPTIONS', path, requestMethod: 'GET' });

test('cors: with public reads on, another origin may read the public map and the sign-in routes', () => {
  for (const path of ['/api/places', '/api/spots/abc', '/api/auth/status', '/api/version']) {
    const decision = corsDecision(read(path), [MAP], true);
    assert.equal(decision?.headers['Access-Control-Allow-Origin'], MAP, path);
  }
  assert.equal(corsDecision(preflight('/api/places'), [MAP], true)?.preflight, true);
});

test('cors: on a private instance only the routes that stay open are offered to another origin', () => {
  for (const path of ['/api/places', '/api/spots/abc', '/api/plugins-web', '/api/settings']) {
    assert.equal(corsDecision(read(path), [MAP], false), null, path);
    assert.equal(corsDecision(preflight(path), [MAP], false), null, `preflight ${path}`);
  }
  for (const path of ['/api/auth/status', '/api/version']) {
    assert.equal(corsDecision(read(path), [MAP], false)?.headers['Access-Control-Allow-Origin'], MAP, path);
  }
});

test('cors: the access mode changes nothing about who is allowed or what is written', () => {
  for (const publicReads of [true, false]) {
    assert.equal(corsDecision(read('/api/version', 'https://other.example'), [MAP], publicReads), null, 'an origin that was not named');
    assert.equal(corsDecision({ origin: undefined, method: 'GET', path: '/api/version' }, [MAP], publicReads), null, 'no origin at all');
    assert.equal(corsDecision(read('/api/version'), [], publicReads), null, 'no origins named');
    assert.equal(corsDecision({ origin: MAP, method: 'POST', path: '/api/version' }, [MAP], publicReads), null, 'a write');
    assert.equal(corsDecision(read('/api/plugins/media.x/ping'), [MAP], publicReads), null, 'a plugin route is never offered');
    assert.equal(corsDecision(read('/api/settings/access'), [MAP], publicReads), null, 'an admin route');
  }
});
