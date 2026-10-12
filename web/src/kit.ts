/** Small pure helpers for the profile and Kit pages, kept here so they can be tested without a browser. */
import type { Gear, Ride } from './api.js';

/** The same rule the server applies (server/src/bodyLimits.ts): a handle, never a URL. */
const INSTAGRAM = /^(?!\.+$)[A-Za-z0-9._]{1,30}$/;

/**
 * Where an Instagram handle points, or null when it is not a plain handle.
 * The server refuses anything else, but a link is built from stored text, so it is checked again here.
 */
export function instagramUrl(handle: string): string | null {
  return INSTAGRAM.test(handle) ? `https://instagram.com/${encodeURIComponent(handle)}` : null;
}

/** "2023 Porsche 911 GT3 “Gwen”", leaving out what is not there. */
export function rideTitle(r: Pick<Ride, 'year' | 'make' | 'model' | 'nickname'>): string {
  return [r.year, r.make, r.model, r.nickname && `“${r.nickname}”`].filter(Boolean).join(' ');
}

/** "Sigma 150-600mm", without saying the brand twice when the name already starts with it. */
export function gearTitle(g: Pick<Gear, 'brand' | 'name'>): string {
  return g.name.toLowerCase().startsWith(g.brand.toLowerCase()) ? g.name : `${g.brand} ${g.name}`;
}

/** An ISO instant as the value of a `datetime-local` input, in the reader's own zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The ISO instant for a `datetime-local` value read in the reader's own zone, or null when it is empty or not a date. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
