/** RFC 4180 CSV parser, copied from web/src/importers.ts (kept in sync by hand, not imported — separate workspaces). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

/** CSV text with a header row into objects keyed by header name. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/**
 * Stream CSV rows from UTF-8 bytes one row at a time without holding the full
 * file string or row list in memory (Sydney Trains stop_times.txt has >1.5M rows).
 */
export function forEachCsvRow(bytes: Uint8Array | undefined, onRow: (get: (col: string) => string) => void): void {
  if (!bytes || !bytes.length) return;
  const decoder = new TextDecoder();
  let head: Map<string, number> | null = null;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let cr = false;
  const emit = () => {
    if (!row.some((f) => f.trim())) { row = []; return; }
    if (!head) {
      head = new Map(row.map((h, i) => [h.trim(), i]));
    } else {
      const current = row;
      const cols = head;
      onRow((col) => {
        const idx = cols.get(col);
        return idx != null ? (current[idx] ?? '').trim() : '';
      });
    }
    row = [];
  };

  const CHUNK = 65536;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    let chunk = decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
    if (offset === 0) chunk = chunk.replace(/^\uFEFF/, '');
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (cr) {
        cr = false;
        if (c === '\n') continue;
      }
      if (quoted) {
        if (c === '"') { quoted = false; afterQuote = true; }
        else field += c;
      } else {
        if (afterQuote) {
          afterQuote = false;
          if (c === '"') { field += '"'; quoted = true; continue; }
        }
        if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r') cr = true;
          row.push(field); field = '';
          emit();
        } else field += c;
      }
    }
  }
  if (field || row.length) {
    row.push(field);
    emit();
  }
}
