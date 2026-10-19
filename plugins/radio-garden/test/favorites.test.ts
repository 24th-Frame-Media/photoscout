import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRadioFavorites, RADIO_FAVORITES_STORAGE_KEY, toggleRadioFavorite } from '../src/web/favorites.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as Storage;
}

const station = { id: 'abc', title: 'Test FM', placeId: 'place-1', listenUrl: 'https://stream.example/fm', streamDomain: 'stream.example' };

test('radio favorites are local, valid, and toggle by station id', () => {
  const local = storage();
  assert.deepEqual(loadRadioFavorites(local), []);
  const saved = toggleRadioFavorite(station, []);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'abc');
  assert.ok(saved[0].savedAt);

  local.setItem(RADIO_FAVORITES_STORAGE_KEY, JSON.stringify(saved));
  assert.deepEqual(loadRadioFavorites(local).map(({ savedAt: _savedAt, ...favorite }) => favorite), [station]);
  assert.deepEqual(toggleRadioFavorite(station, saved), []);
});

test('radio favorites reject malformed local storage', () => {
  const local = storage();
  local.setItem(RADIO_FAVORITES_STORAGE_KEY, JSON.stringify([{ id: 3, title: 'Bad' }]));
  assert.deepEqual(loadRadioFavorites(local), []);
});
