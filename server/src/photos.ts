import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import { photosDir } from './db.js';

/** Photo upload: magic-byte sniffing, storage and multipart parsing. No sharp — resizing happens in the browser. */

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** JPEG, PNG or WebP by magic bytes, or null for anything else. */
export function detectImageType(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Write a validated image buffer under data/photos/, return its filename. */
export function saveImage(buf: Buffer): string {
  const ext = detectImageType(buf);
  if (!ext) throw new Error('Not a JPEG, PNG or WebP file');
  if (buf.length > MAX_PHOTO_BYTES) throw new Error(`Image exceeds ${MAX_PHOTO_BYTES} bytes`);
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(photosDir, name), buf);
  return name;
}

/** Delete photo files by name, ignoring ones already gone. */
export function deleteImages(names: (string | null | undefined)[]): void {
  for (const name of names) {
    if (!name) continue;
    try {
      fs.unlinkSync(path.join(photosDir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** A safe filename to serve: no path separators, no traversal. */
export function isSafePhotoName(name: string): boolean {
  return /^[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(name);
}

/**
 * Read a `multipart/form-data` body into named buffers, capped at
 * `limitBytes` total. Small and purpose-built rather than a general form
 * parser — this app only ever expects a `photo` file and a `thumb` file.
 */
export interface MultipartResult {
  fields: Record<string, string>;
  files: Record<string, Buffer>;
}

/** What is wrong with an upload that is the sender's doing; `status` lets the API error handler answer it as such. */
export class UploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Form fields, field size and parts one upload may carry. A photo form has a handful of each. */
const MAX_FIELDS = 20;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_PARTS = 30;

export function parseMultipart(req: IncomingMessage, limitBytes: number): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: limitBytes, files: 4, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES, parts: MAX_PARTS } });
    } catch {
      return reject(new UploadError('Expected a multipart/form-data upload'));
    }
    const files: Record<string, Buffer> = {};
    const fields: Record<string, string> = {};
    let problem: UploadError | null = null;
    const refuse = (message: string, status = 400): void => {
      problem ??= new UploadError(message, status);
      req.unpipe(bb);
      reject(problem);
    };
    bb.on('field', (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) refuse('A form field is too long');
      fields[name] = value;
    });
    bb.on('file', (name, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => refuse(`Upload exceeds ${limitBytes} bytes`, 413));
      stream.on('close', () => { files[name] = Buffer.concat(chunks); });
    });
    bb.on('partsLimit', () => refuse('Too many parts in the upload'));
    bb.on('fieldsLimit', () => refuse('Too many form fields'));
    bb.on('filesLimit', () => refuse('Too many files'));
    bb.on('error', () => reject(problem ?? new UploadError('Malformed upload')));
    bb.on('close', () => (problem ? reject(problem) : resolve({ fields, files })));
    req.pipe(bb);
  });
}

/** Largest width or height a stored photo may claim. */
const MAX_PHOTO_SIDE = 100_000;

/**
 * The size and capture time a photo form states. A size left out is 0 (unknown) and a time left out is
 * null; one that is given has to be a whole number of pixels, or a date.
 */
export function photoMeta(fields: Record<string, string>): { w: number; h: number; takenAt: string | null } {
  const side = (name: 'w' | 'h'): number => {
    const raw = fields[name];
    if (raw === undefined || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PHOTO_SIDE) throw new UploadError(`${name} must be a whole number of pixels`);
    return n;
  };
  let takenAt: string | null = null;
  if (fields.takenAt) {
    const ms = fields.takenAt.length <= 40 ? Date.parse(fields.takenAt) : NaN;
    if (!Number.isFinite(ms)) throw new UploadError('takenAt must be a date');
    takenAt = new Date(ms).toISOString();
  }
  return { w: side('w'), h: side('h'), takenAt };
}

/**
 * Extra columns for `SELECT spots.*, ${SPOT_COVER_COLS} FROM spots`: the photo count and the
 * cover photo's id (a location photo first, then the earliest), so a spot list carries its map
 * thumbnail without a request per spot. Correlated subqueries ride the idx_photos_spot index.
 */
export const SPOT_COVER_COLS =
  '(SELECT COUNT(*) FROM photos p WHERE p.spot_id = spots.id) AS photo_count, ' +
  "(SELECT p.id FROM photos p WHERE p.spot_id = spots.id ORDER BY (p.kind = 'of_location') DESC, p.created_at, p.id LIMIT 1) AS cover_id";

/** The payload fields for a row selected with SPOT_COVER_COLS (a row without them reads as no photos). */
export function coverFields(r: { photo_count?: number | bigint | null; cover_id?: string | null }): { photoCount: number; coverThumbUrl: string | null } {
  return { photoCount: Number(r.photo_count ?? 0), coverThumbUrl: r.cover_id ? `/api/photos/${r.cover_id}/thumb` : null };
}
