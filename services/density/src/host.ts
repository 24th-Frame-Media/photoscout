import type { DatabaseSync } from 'node:sqlite';
import type { DensityArea } from './areas.js';

export interface Settings {
  city?: string; lat?: number | null; lng?: number | null; areasManaged?: boolean;
  densitySearches?: string[]; densityPlaces?: string[]; densityPlacesPerName?: number;
  densityMaxVenues?: number; densityRequestDelayMs?: number; densityWaitMs?: number;
  densityBrowserPath?: string; densityCellMeters?: number; densityKernelMeters?: number;
  densityAreas?: DensityArea[];
}
export interface SunDay {
  date: string; sunrise: string | null; sunset: string | null;
  solarNoon: string | null; dayLength: string | null;
  goldenMorning: { start: string; end: string } | null;
  goldenEvening: { start: string; end: string } | null;
  blueMorning: { start: string; end: string } | null;
  blueEvening: { start: string; end: string } | null;
}
export interface DensityHost {
  db: DatabaseSync;
  getSettings: () => Settings;
  getKv: (key: string) => string | null;
  setKv: (key: string, value: string) => void;
  sunForDay: (date: Date, lat: number, lng: number) => SunDay;
  publicFetch: (url: string, init?: RequestInit) => Promise<Response>;
  readCappedText: (response: Response, maxBytes: number) => Promise<string>;
  userAgent: string;
  userAgentMetadata: Record<string, unknown>;
  browserHeaders: Record<string, string>;
}
let host: DensityHost;
export let db: DatabaseSync;
export let USER_AGENT: string;
export let USER_AGENT_METADATA: Record<string, unknown>;
export let BROWSER_HEADERS: Record<string, string>;
export function configureDensity(adapter: DensityHost): void {
  host = adapter; db = adapter.db; USER_AGENT = adapter.userAgent;
  USER_AGENT_METADATA = adapter.userAgentMetadata; BROWSER_HEADERS = adapter.browserHeaders;
}
function required(): DensityHost {
  if (!host) throw new Error('Density service host has not been configured');
  return host;
}
export const getSettings = () => required().getSettings();
export const getKv = (key: string) => required().getKv(key);
export const setKv = (key: string, value: string) => required().setKv(key, value);
export const sunForDay = (date: Date, lat: number, lng: number) => required().sunForDay(date, lat, lng);
export const publicFetch = (url: string, init?: RequestInit) => required().publicFetch(url, init);
export const readCappedText = (response: Response, maxBytes: number) => required().readCappedText(response, maxBytes);
