import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { PluginError } from './manifest.js';

/**
 * Reading a plugin package safely. A package is untrusted input, so every
 * entry's name, size and type is checked before anything is written to disk.
 *
 * fflate does not expose a zip entry's Unix mode, so the central directory is
 * read here to find symbolic links (mode S_IFLNK in the high 16 bits of the
 * external attributes).
 */

export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_ENTRIES = 2000;

interface CentralEntry {
  name: string;
  size: number;
  attrs: number;
  flags: number;
}

function scanCentralDirectory(buf: Buffer): CentralEntry[] {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PluginError('The package is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new PluginError('Zip64 packages are not supported');
  }
  if (count > MAX_ENTRIES) throw new PluginError(`The package has more than ${MAX_ENTRIES} files`);
  if (cdOffset + cdSize > buf.length) throw new PluginError('The package directory is corrupt');

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new PluginError('The package directory is corrupt');
    const flags = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, size, attrs, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * A safe relative name for an entry, or null for a directory entry. Throws for
 * anything that could leave the package folder.
 */
export function safeEntryName(raw: string): string | null {
  if (raw.length === 0 || raw.length > 512 || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new PluginError(`Unsafe path in the package: ${JSON.stringify(raw)}`);
  }
  const isDir = raw.endsWith('/');
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new PluginError(`Unsafe path in the package: ${JSON.stringify(raw)}`);
  if (parts.length === 0 || isDir) return null;
  return parts.join('/');
}

/** Decompress a package into relative names and bytes, after every entry has been checked. */
export function unpackZip(zip: Uint8Array): Map<string, Uint8Array> {
  if (zip.byteLength > MAX_PACKAGE_BYTES) throw new PluginError('The package is larger than 50 MB', 413);
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = scanCentralDirectory(buf);

  const seen = new Set<string>();
  let declared = 0;
  for (const entry of entries) {
    if (entry.flags & 1) throw new PluginError('Encrypted packages are not supported');
    if (((entry.attrs >>> 16) & 0o170000) === 0o120000) {
      throw new PluginError(`${entry.name} is a symbolic link; packages may not contain links`);
    }
    const rel = safeEntryName(entry.name);
    if (rel === null) continue;
    if (seen.has(rel)) throw new PluginError(`The package lists ${rel} twice`);
    seen.add(rel);
    declared += entry.size;
    if (declared > MAX_PACKAGE_BYTES) throw new PluginError('The package unpacks to more than 50 MB', 413);
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zip);
  } catch {
    throw new PluginError('The package could not be read; it may be corrupt');
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [name, data] of Object.entries(unzipped)) {
    const rel = safeEntryName(name);
    if (rel === null) continue;
    if (files.has(rel)) throw new PluginError(`The package lists ${rel} twice`);
    total += data.byteLength;
    if (total > MAX_PACKAGE_BYTES) throw new PluginError('The package unpacks to more than 50 MB', 413);
    files.set(rel, data);
  }
  if (files.size > MAX_ENTRIES) throw new PluginError(`The package has more than ${MAX_ENTRIES} files`);
  return files;
}

/** A package zipped inside one folder (`my-plugin/plugin.json`) is accepted: the folder is stripped. */
export function stripSingleFolder(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has('plugin.json')) return files;
  const tops = new Set([...files.keys()].map((name) => name.split('/')[0]));
  if (tops.size !== 1) return files;
  const [top] = tops;
  if (!files.has(`${top}/plugin.json`)) return files;
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of files) out.set(name.slice(top.length + 1), data);
  return out;
}

/** Write the files of a package into an empty directory. */
export function writeStage(dir: string, files: Map<string, Uint8Array>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, data] of files) {
    const target = path.join(dir, ...rel.split('/'));
    if (!target.startsWith(dir + path.sep)) throw new PluginError(`Unsafe path in the package: ${rel}`);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { flag: 'wx' });
    } catch {
      throw new PluginError(`The package has conflicting paths at ${rel}`);
    }
  }
}

/** Read a plugin folder (for installing from a directory) into memory, refusing links. */
export function collectDir(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new PluginError(`${rel} is a symbolic link; packages may not contain links`);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const data = fs.readFileSync(full);
      total += data.byteLength;
      if (total > MAX_PACKAGE_BYTES) throw new PluginError('The plugin folder is larger than 50 MB', 413);
      if (files.size + 1 > MAX_ENTRIES) throw new PluginError(`The plugin folder has more than ${MAX_ENTRIES} files`);
      files.set(rel, data);
    }
  };
  walk(dir, '');
  return files;
}
