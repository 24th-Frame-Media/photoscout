import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRfs } from '../src/feeds/rfs.js';

test('parseRfs: parses point and GeometryCollection features with status, size, and category', () => {
  const fixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [151.97, -32.65] },
        properties: {
          title: 'TAREAN RD, KARUAH',
          link: 'https://www.rfs.nsw.gov.au/fire-information/fires-near-me',
          category: 'Advice',
          guid: 'https://incidents.rfs.nsw.gov.au/api/v1/incidents/679856',
          pubDate: '29/09/2026 9:58:00 AM',
          description: 'ALERT LEVEL: Advice <br />LOCATION: TAREAN RD, KARUAH 2324 <br />STATUS: Under control <br />TYPE: Bush Fire <br />FIRE: Yes <br />SIZE: 120 ha <br />UPDATED: 29 Sep 2026 19:58',
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [152.76, -30.68] },
            { type: 'Polygon', coordinates: [[[152.77, -30.69], [152.78, -30.69], [152.77, -30.69]]] },
          ],
        },
        properties: {
          title: 'TULLOCK RD, YARRANBELLA',
          link: 'https://www.rfs.nsw.gov.au/fire-information/fires-near-me',
          category: 'Emergency Warning',
          guid: 'https://incidents.rfs.nsw.gov.au/api/v1/incidents/676936',
          pubDate: '29/09/2026 7:04:00 AM',
          description: 'STATUS: Out of control <br />SIZE: 997 ha <br />UPDATED: 29 Sep 2026 17:04',
        },
      },
    ],
  };

  const incidents = parseRfs(fixture);
  assert.equal(incidents.length, 2);

  const [first, second] = incidents;
  assert.equal(first.id, '679856');
  assert.equal(first.title, 'TAREAN RD, KARUAH');
  assert.equal(first.category, 'Advice');
  assert.equal(first.status, 'Under control');
  assert.equal(first.sizeHa, 120);
  assert.equal(first.updated, '29 Sep 2026 19:58');
  assert.equal(first.geometry.type, 'Point');

  assert.equal(second.id, '676936');
  assert.equal(second.title, 'TULLOCK RD, YARRANBELLA');
  assert.equal(second.category, 'Emergency Warning');
  assert.equal(second.status, 'Out of control');
  assert.equal(second.sizeHa, 997);
  assert.equal(second.geometry.type, 'GeometryCollection');
});

test('parseRfs: handles missing fields, zero or non-numeric size, and invalid payloads', () => {
  assert.deepEqual(parseRfs(null), []);
  assert.deepEqual(parseRfs({}), []);
  assert.deepEqual(parseRfs({ features: [] }), []);

  const sparse = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'inc-42',
        geometry: { type: 'Point', coordinates: [150.0, -34.0] },
        properties: {
          title: 'Spot Fire',
          pubDate: '01/10/2026 10:00:00 AM',
        },
      },
    ],
  };

  const [res] = parseRfs(sparse);
  assert.equal(res.id, 'inc-42');
  assert.equal(res.title, 'Spot Fire');
  assert.equal(res.category, 'Not Applicable');
  assert.equal(res.status, '');
  assert.equal(res.sizeHa, undefined);
  assert.equal(res.updated, '01/10/2026 10:00:00 AM');
});
