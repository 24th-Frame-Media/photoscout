import type { RadioStation } from './types.js';

export const RADIO_FAVORITES_STORAGE_KEY = 'photoscout.radio-garden.favorites';
export const RADIO_FAVORITES_EVENT = 'photoscout:radio-garden-favorites';

/** A local browser preference: it deliberately does not use account data or sync. */
export interface RadioFavorite extends RadioStation {
  savedAt: string;
}

function valid(value: unknown): value is RadioFavorite {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof item.placeId === 'string'
    && typeof item.listenUrl === 'string';
}

export function loadRadioFavorites(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): RadioFavorite[] {
  try {
    const raw = storage?.getItem(RADIO_FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

export function saveRadioFavorites(favorites: readonly RadioFavorite[], storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(RADIO_FAVORITES_STORAGE_KEY, JSON.stringify(favorites)); } catch { /* private mode or quota */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RADIO_FAVORITES_EVENT));
}

export function toggleRadioFavorite(station: RadioStation, current = loadRadioFavorites()): RadioFavorite[] {
  const exists = current.some((favorite) => favorite.id === station.id);
  const next = exists
    ? current.filter((favorite) => favorite.id !== station.id)
    : [{ ...station, savedAt: new Date().toISOString() }, ...current.filter((favorite) => favorite.id !== station.id)];
  saveRadioFavorites(next);
  return next;
}
