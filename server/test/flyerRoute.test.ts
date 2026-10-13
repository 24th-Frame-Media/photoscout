import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp();
const { eventSource } = await import('../src/events.js');
const { store } = await import('../src/events/flyerStore.js');
const { flyerHref, flyerName, flyerRelative } = await import('../src/events/flyers.js');
after(() => app.close());

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const shown = flyerRelative('2030-01-05', flyerName('https://img.test/a', 'png'));
const hiddenOne = flyerRelative('2030-01-05', flyerName('https://img.test/b', 'png'));
const orphan = flyerRelative('2030-01-05', flyerName('https://img.test/c', 'jpg'));
for (const rel of [shown, hiddenOne, orphan]) store.write(rel, png);

const ev = (group: string, flyer: string, extra: Record<string, unknown> = {}) => ({
  group, title: group, description: '', startTime: '2030-01-05T09:00:00.000Z', endTime: null, venueName: '', address: '', locality: '',
  lat: null, lng: null, imageUrl: 'https://img.test/x.jpg', images: [flyerHref(flyer), 'https://img.test/x.jpg'], category: '', priceText: '',
  isOnline: false, dateOnly: false, photoScore: 0, series: '', sources: [], hidden: false, culled: null, ...extra,
});
eventSource.read = () => [ev('shown', shown), ev('hidden', hiddenOne, { hidden: true })];

const anon = app.client();

test('a visitor gets the stored copy of an event on show, with a type we chose and nothing it could run', async () => {
  assert.equal((await anon('GET', '/api/events')).json[0].imageUrl, flyerHref(shown), 'the list points at the stored copy');
  const res = await anon('GET', flyerHref(shown));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(res.headers.get('content-disposition'), 'inline');
});

test('a flyer whose event is hidden, or that belongs to no event, is not served', async () => {
  assert.equal((await anon('GET', flyerHref(hiddenOne))).status, 404);
  assert.equal((await anon('GET', flyerHref(orphan))).status, 404);
  assert.equal((await anon('GET', flyerHref(flyerRelative('2030-01-05', 'ffffffffffffffff.png')))).status, 404, 'a well-formed name that is not there');
});

test('the path cannot leave the folder', async () => {
  const name = shown.split('/')[1];
  for (const path of [
    `/api/flyer/..%2f..%2fevent-scout.db/${name}`,
    '/api/flyer/2030-01-05/..%2f..%2fevent-scout.db',
    `/api/flyer/2030-01-05%2f..%2f2030-01-05/${name}`,
    `/api/flyer/..%5c..%5cphotoscout.db/${name}`,
    `/api/flyer/2030-01-05/${name}%00.png`,
    `/api/flyer/2030-01-05/${name.replace('.png', '.svg')}`,
    `/api/flyer/2030-01-05/${name}.part`,
    `/api/flyer/%2e%2e/${name}`,
    '/api/flyer/2030-01-05',
  ]) {
    const res = await anon('GET', path);
    // 401 for the two the URL parser flattens into some other, closed, path.
    assert.ok([400, 401, 404].includes(res.status), `${path} -> ${res.status}`);
    assert.ok(!res.headers.get('content-type')?.startsWith('image/'), path);
  }
});
