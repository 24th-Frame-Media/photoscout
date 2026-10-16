import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import { accessConfigView, publicReads, setPublicReads } from '../src/access.js';

const saved = process.env.PUBLIC_READS;
beforeEach(() => { delete process.env.PUBLIC_READS; });
afterEach(() => {
  if (saved === undefined) delete process.env.PUBLIC_READS;
  else process.env.PUBLIC_READS = saved;
});

test('access: a fresh instance is private', () => {
  const db = createDb(':memory:');
  assert.equal(publicReads(db), false);
  assert.deepEqual(accessConfigView(db), { publicReads: false, source: 'default' });
});

test('access: an admin\'s choice is saved, and read back as theirs', () => {
  const db = createDb(':memory:');
  setPublicReads(db, true);
  assert.equal(publicReads(db), true);
  assert.deepEqual(accessConfigView(db), { publicReads: true, source: 'stored' });
  assert.deepEqual(JSON.parse(db.getKv('access')!), { publicReads: true });
  setPublicReads(db, false);
  assert.equal(publicReads(db), false);
  assert.deepEqual(accessConfigView(db), { publicReads: false, source: 'stored' }, 'a stored "private" is still a choice');
});

test('access: the choice survives the database being closed and opened again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-access-'));
  try {
    const file = path.join(dir, 'photoscout.db');
    const first = createDb(file);
    setPublicReads(first, true);
    first.handle.close();
    const second = createDb(file);
    assert.equal(publicReads(second), true);
    second.handle.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('access: PUBLIC_READS in the environment wins over what is stored', () => {
  const db = createDb(':memory:');
  setPublicReads(db, true);
  process.env.PUBLIC_READS = '0';
  assert.deepEqual(accessConfigView(db), { publicReads: false, source: 'env' });
  assert.equal(publicReads(db), false);

  setPublicReads(db, false);
  process.env.PUBLIC_READS = '1';
  assert.deepEqual(accessConfigView(db), { publicReads: true, source: 'env' });
  assert.equal(publicReads(db), true);

  // It wins over the default too.
  const fresh = createDb(':memory:');
  assert.deepEqual(accessConfigView(fresh), { publicReads: true, source: 'env' });
});

test('access: PUBLIC_READS accepts 1 and true to open, and anything else that is set keeps it private', () => {
  const db = createDb(':memory:');
  setPublicReads(db, true); // so that only the environment can be what makes these private
  for (const open of ['1', 'true', 'TRUE', 'True', ' 1 ']) {
    process.env.PUBLIC_READS = open;
    assert.deepEqual(accessConfigView(db), { publicReads: true, source: 'env' }, JSON.stringify(open));
  }
  for (const closed of ['0', 'false', 'FALSE', 'yes', 'on', 'enabled', 'public', '2']) {
    process.env.PUBLIC_READS = closed;
    assert.deepEqual(accessConfigView(db), { publicReads: false, source: 'env' }, `${JSON.stringify(closed)}: a typo never opens an instance`);
  }
});

test('access: a blank PUBLIC_READS counts as unset', () => {
  const db = createDb(':memory:');
  for (const blank of ['', '   ']) {
    process.env.PUBLIC_READS = blank;
    assert.deepEqual(accessConfigView(db), { publicReads: false, source: 'default' }, JSON.stringify(blank));
  }
  setPublicReads(db, true);
  process.env.PUBLIC_READS = '';
  assert.deepEqual(accessConfigView(db), { publicReads: true, source: 'stored' });
});

test('access: a stored row that is not a boolean falls back to private', () => {
  const db = createDb(':memory:');
  for (const bad of ['not json', '', 'null', '[]', '{}', '{"publicReads":"true"}', '{"publicReads":1}', '{"publicReads":null}', '"true"', 'true']) {
    db.setKv('access', bad);
    assert.deepEqual(accessConfigView(db), { publicReads: false, source: 'default' }, JSON.stringify(bad));
  }
});
