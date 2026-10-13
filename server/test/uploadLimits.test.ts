import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp();
after(() => app.close());

const alice = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
const spotId = (await alice('POST', '/api/spots', { name: 'Lookout', lat: -33.4, lng: 149.5 })).json.id as string;

const jpeg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])], { type: 'image/jpeg' });
const cookie = (): string => [...alice.jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function upload(fields: Record<string, string>): Promise<{ status: number; json: any }> {
  const form = new FormData();
  form.append('photo', jpeg, 'a.jpg');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${app.base}/api/spots/${spotId}/photos`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('a normal photo upload still works, with its size and time stored', async () => {
  const r = await upload({ w: '4000', h: '3000', takenAt: '2026-01-02T03:04:05.000Z', caption: 'hi' });
  assert.equal(r.status, 201);
  assert.equal(r.json.w, 4000);
  assert.equal(r.json.takenAt, '2026-01-02T03:04:05.000Z');
  assert.equal((await upload({})).status, 201, 'a size and time left out are fine');
});

test('too many form fields, a huge field, or too many parts is a 400', async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 25; i++) many[`f${i}`] = 'x';
  assert.equal((await upload(many)).status, 400);
  assert.equal((await upload({ caption: 'x'.repeat(20_000) })).status, 400);
  const form = new FormData();
  form.append('photo', jpeg, 'a.jpg');
  for (let i = 0; i < 40; i++) form.append('thumb', jpeg, 't.jpg');
  const res = await fetch(`${app.base}/api/spots/${spotId}/photos`, { method: 'POST', headers: { Cookie: cookie() }, body: form });
  assert.equal(res.status, 400);
});

test('a malformed multipart body is a 400, not a 500', async () => {
  const headers = { Cookie: cookie(), 'Content-Type': 'multipart/form-data; boundary=abc' };
  const url = `${app.base}/api/spots/${spotId}/photos`;
  assert.equal((await fetch(url, { method: 'POST', headers, body: '--abc\r\nContent-Disposition: form-data; name="a"\r\n\r\nnever ends' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie(), 'Content-Type': 'multipart/form-data' }, body: 'x' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie(), 'Content-Type': 'text/plain' }, body: 'x' })).status, 400);
});

test('photo metadata that is not a size or a date is a 400', async () => {
  for (const fields of <Record<string, string>[]>[{ w: '-5' }, { w: '1.5' }, { h: 'abc' }, { w: '100001' }, { h: '1e9' }, { takenAt: 'last tuesday' }, { takenAt: 'x'.repeat(200) }]) {
    assert.equal((await upload(fields)).status, 400, JSON.stringify(fields));
  }
});
