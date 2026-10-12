import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeLensStats,
  extractCommonMetadata,
  extractHour,
  focalBucket,
  lensStats,
  parseRational,
  peakHourWindow,
} from '../src/sources/commons.js';

test('parseRational: integers, fractions, and invalid values', () => {
  assert.equal(parseRational(50), 50);
  assert.equal(parseRational('50'), 50);
  assert.equal(parseRational('420/10'), 42);
  assert.equal(parseRational('24/1'), 24);
  assert.ok(Math.abs((parseRational('2147483647/31796922') ?? 0) - 67.537) < 0.01);

  assert.equal(parseRational(0), null);
  assert.equal(parseRational('0'), null);
  assert.equal(parseRational('0/0'), null);
  assert.equal(parseRational('10/0'), null);
  assert.equal(parseRational('-5'), null);
  assert.equal(parseRational(null), null);
  assert.equal(parseRational(undefined), null);
  assert.equal(parseRational('invalid'), null);
});

test('extractCommonMetadata: extracts focal length, 35mm equivalent, date, and model', () => {
  const meta = [
    { name: 'ImageWidth', value: 2544 },
    { name: 'DateTimeOriginal', value: '2008:12:02 10:59:25' },
    { name: 'FocalLength', value: '420/10' },
    { name: 'FocalLengthIn35mmFilm', value: '63' },
    { name: 'Model', value: 'NIKON D80' },
  ];
  const parsed = extractCommonMetadata(meta);
  assert.equal(parsed.focalRaw, 42);
  assert.equal(parsed.focal35, 63);
  assert.equal(parsed.takenAt, '2008:12:02 10:59:25');
  assert.equal(parsed.model, 'NIKON D80');

  assert.deepEqual(extractCommonMetadata(undefined), { focalRaw: null, focal35: null, takenAt: null, model: null });
  assert.deepEqual(extractCommonMetadata([]), { focalRaw: null, focal35: null, takenAt: null, model: null });
});

test('focalBucket: partitions focal lengths into standard categories', () => {
  // <24 ultra-wide
  assert.equal(focalBucket(14), 'ultra-wide');
  assert.equal(focalBucket(23), 'ultra-wide');
  assert.equal(focalBucket(23.4), 'ultra-wide');

  // 24-35 wide
  assert.equal(focalBucket(24), 'wide');
  assert.equal(focalBucket(28), 'wide');
  assert.equal(focalBucket(35), 'wide');
  assert.equal(focalBucket(35.4), 'wide');

  // 36-70 standard
  assert.equal(focalBucket(36), 'standard');
  assert.equal(focalBucket(50), 'standard');
  assert.equal(focalBucket(70), 'standard');
  assert.equal(focalBucket(70.4), 'standard');

  // 71-200 tele
  assert.equal(focalBucket(71), 'tele');
  assert.equal(focalBucket(85), 'tele');
  assert.equal(focalBucket(135), 'tele');
  assert.equal(focalBucket(200), 'tele');
  assert.equal(focalBucket(200.4), 'tele');

  // >200 super-tele
  assert.equal(focalBucket(201), 'super-tele');
  assert.equal(focalBucket(300), 'super-tele');
  assert.equal(focalBucket(600), 'super-tele');
});

test('extractHour: extracts local hour from EXIF without timezone conversion, but local hour from ISO UTC', () => {
  assert.equal(extractHour('2008:12:02 10:59:25'), 10);
  assert.equal(extractHour('2024-05-14T17:34:00'), 17);
  assert.equal(extractHour('2024-05-14 17:34:00'), 17);
  
  const d1 = new Date('2024-05-14T00:15:30Z');
  assert.equal(extractHour('2024-05-14T00:15:30Z'), d1.getHours());
  
  const d2 = new Date('2024-05-14T00:15:30+05:00');
  assert.equal(extractHour('2024-05-14T00:15:30+05:00'), d2.getHours());

  assert.equal(extractHour('09:30'), 9);
  assert.equal(extractHour('invalid'), null);
  assert.equal(extractHour(null), null);
});

test('peakHourWindow: finds highest density 2-hour window', () => {
  const hours = new Array(24).fill(0);
  hours[17] = 20;
  hours[18] = 24;
  assert.equal(peakHourWindow(hours), '17:00-19:00');

  const morning = new Array(24).fill(0);
  morning[6] = 5;
  morning[7] = 7;
  assert.equal(peakHourWindow(morning), '06:00-08:00');

  const empty = new Array(24).fill(0);
  assert.equal(peakHourWindow(empty), null);
});

test('lensStats: phone exclusion, rational values, and minimum photo threshold', () => {
  // Fewer than 3 usable photos returns null
  assert.equal(lensStats([]), null);
  assert.equal(lensStats([{ focal35: 50, focalRaw: null, takenAt: null }]), null);
  assert.equal(lensStats([
    { focal35: 50, focalRaw: null, takenAt: null },
    { focal35: 85, focalRaw: null, takenAt: null },
  ]), null);

  // Phone exclusion: raw < 10 mm without 35mm equivalent is excluded
  assert.equal(lensStats([
    { focal35: 50, focalRaw: null, takenAt: null },
    { focal35: 85, focalRaw: null, takenAt: null },
    { focal35: null, focalRaw: 4.2, takenAt: null }, // phone dropped!
  ]), null);

  // Phone with 35mm equivalent is kept
  const statsWithPhone35 = lensStats([
    { focal35: 50, focalRaw: null, takenAt: '2024:05:01 17:10:00' },
    { focal35: 85, focalRaw: null, takenAt: '2024:05:02 17:40:00' },
    { focal35: 26, focalRaw: 4.2, takenAt: '2024:05:03 18:20:00' }, // phone kept as 26mm wide
  ]);
  assert.ok(statsWithPhone35);
  assert.equal(statsWithPhone35.total, 3);
  assert.equal(statsWithPhone35.byCategory['wide'].count, 1);
  assert.equal(statsWithPhone35.byCategory['standard'].count, 1);
  assert.equal(statsWithPhone35.byCategory['tele'].count, 1);
  assert.equal(statsWithPhone35.peakWindow, '17:00-19:00');

  // Rationals: "420/10" -> 42 (standard)
  const statsRationals = lensStats([
    { focal35: null, focalRaw: '420/10' as any, takenAt: null },
    { focal35: '700/10' as any, focalRaw: null, takenAt: null },
    { focal35: null, focalRaw: 100, takenAt: null },
  ]);
  assert.ok(statsRationals);
  assert.equal(statsRationals.total, 3);
  assert.equal(statsRationals.byCategory['standard'].count, 2); // 42mm and 70mm
  assert.equal(statsRationals.byCategory['tele'].count, 1); // 100mm
});

test('lensStats and describeLensStats: matching prompt example line', () => {
  // Reconstruct n=44: 45% tele 71-200 (20), 30% standard (13), 15% ultra-wide (7), 9% wide (4)
  const photos: { focal35: number | null; focalRaw: number | null; takenAt: string | null }[] = [];
  // 20 tele photos around 17:00-18:30
  for (let i = 0; i < 20; i++) {
    photos.push({ focal35: 70 + (i % 130) + 1, focalRaw: null, takenAt: i % 2 === 0 ? '2024:01:10 17:15:00' : '2024:01:10 18:20:00' });
  }
  // 13 standard photos
  for (let i = 0; i < 13; i++) {
    photos.push({ focal35: 50, focalRaw: null, takenAt: '2024:01:10 17:45:00' });
  }
  // 7 ultra-wide photos
  for (let i = 0; i < 7; i++) {
    photos.push({ focal35: 16, focalRaw: null, takenAt: '2024:01:10 18:05:00' });
  }
  // 4 wide photos
  for (let i = 0; i < 4; i++) {
    photos.push({ focal35: 28, focalRaw: null, takenAt: '2024:01:10 12:00:00' });
  }

  const stats = lensStats(photos);
  assert.ok(stats);
  assert.equal(stats.total, 44);
  assert.equal(stats.byCategory['tele'].pct, 45);
  assert.equal(stats.byCategory['standard'].pct, 30);
  assert.equal(stats.byCategory['ultra-wide'].pct, 16);
  assert.equal(stats.peakWindow, '17:00-19:00');

  const summary = describeLensStats(stats);
  assert.ok(summary);
  assert.ok(summary.startsWith('Lenses used here (n=44): '));
  assert.ok(summary.includes('45% tele 71-200'));
  assert.ok(summary.includes('30% standard'));
  assert.ok(summary.includes('mostly 17:00-19:00'));

  assert.equal(describeLensStats(null), null);
});
