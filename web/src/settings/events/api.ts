import type {
  CrawlerFind, CrawlerPageRow, CrawlerStatus, CrawlPageReport, DensityArea, DensityStatus, EventTopic, GeocodeResult,
  IcalPreview, LlmQueueResponse, LlmStatus, LogEntry, NotifyStatus, Settings, StatusResponse, TaskStatus, VersionInfo,
} from './types.js';

export * from './types.js';

/** The events engine's own API, which the server only opens to admins. */
const BASE = '/api/events-admin';

/** The events service has no address yet (the proxy answers 503). */
export class NotSetUp extends Error {
  constructor() { super('Set the events service URL under Instance first.'); this.name = 'NotSetUp'; }
}
export class Unauthorized extends Error {}

function failure(res: Response, body: { error?: string }): Error {
  if (res.status === 503) return new NotSetUp();
  if (res.status === 401) return new Unauthorized(body.error ?? 'Sign in again');
  return new Error(body.error ?? `HTTP ${res.status}`);
}

async function raw(path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await raw(path, method, body);
  if (!res.ok) throw failure(res, await res.json().catch(() => ({})));
  return res.json() as Promise<T>;
}

/** For calls whose refusal carries a reason worth showing (a busy task, a bad feed). */
async function callLenient<T extends object>(path: string, body: unknown, fallback: T): Promise<T> {
  const res = await raw(path, 'POST', body);
  if (res.status === 503 || res.status === 401) throw failure(res, await res.json().catch(() => ({})));
  const data = (await res.json().catch(() => ({}))) as Partial<T>;
  return { ...fallback, message: `HTTP ${res.status}`, ...data } as T;
}

type Ok = { ok: boolean; message: string };

export const api = {
  status: () => call<StatusResponse>('/status'),
  settings: () => call<Settings>('/settings'),
  saveSettings: (s: Partial<Settings>) => call<Settings>('/settings', 'PUT', s),
  topics: () => call<{ topics: EventTopic[]; categories?: string[] }>('/topics'),
  geocode: (q: string) => call<GeocodeResult[]>(`/geocode?q=${encodeURIComponent(q)}`),
  refresh: () => call<StatusResponse>('/refresh', 'POST', {}),
  version: () => call<VersionInfo>('/version'),
  crawlerStatus: () => call<CrawlerStatus>('/crawler/status'),
  crawlerPages: (sort: 'reads' | 'recent' | 'yield') => call<{ pages: CrawlerPageRow[]; problem?: string }>(`/crawler/pages?sort=${sort}`),
  crawlerEvents: () => call<{ events: CrawlerFind[]; count: number; problem?: string }>('/crawler/events'),
  crawlerRun: () => call<{ ok: boolean; message?: string }>('/crawler/run', 'POST', {}),
  crawlerCrawl: (url: string) =>
    callLenient<CrawlPageReport>('/crawler/crawl', { url }, { url, ok: false, message: '', events: [], links: 0, feeds: [] }),
  icalPreview: (url: string) => callLenient<IcalPreview>('/ical/preview', { url }, { url, ok: false, message: '' } as IcalPreview),
  notifyStatus: () => call<NotifyStatus>('/notify/status'),
  notifyLooks: (id: string) => call<Ok>('/notify/looks', 'POST', { id }),
  notifyTest: (id: string) => call<Ok>('/notify/test', 'POST', { id }),
  llmStatus: () => call<LlmStatus>('/llm/status'),
  llmQueue: (status = 'all', limit = 100) => call<LlmQueueResponse>(`/llm/queue?status=${encodeURIComponent(status)}&limit=${limit}`),
  llmReset: () => call<{ cleared: number }>('/llm/reset', 'POST', {}),
  visionReset: () => call<{ cleared: number }>('/vision/reset', 'POST', {}),
  // `since` is the highest sequence number already held, so a poll carries only what is new.
  tasks: (since = 0) => call<{ tasks: TaskStatus[]; log: LogEntry[]; seq: number }>(`/tasks?since=${since}`),
  // A refused run (already going, or sharing a busy browser) answers 409 with a reason worth showing.
  runTask: (name: string, body: { holdSeconds?: number } = {}) => callLenient<Ok>(`/tasks/${encodeURIComponent(name)}/run`, body, { ok: false, message: '' }),
  enableTask: (name: string, enabled: boolean) => callLenient<Ok>(`/tasks/${encodeURIComponent(name)}/enable`, { enabled }, { ok: false, message: '' }),
  densityStatus: () => call<DensityStatus>('/density/status'),
  densityRefresh: () => call<Ok>('/density/refresh', 'POST', {}),
  densityDiscover: () => call<Ok>('/density/discover', 'POST', {}),
  densityAreas: () => call<{ areas: DensityArea[] }>('/density/areas'),
  venues: (area: string) => call<{ name: string }[]>(`/density/${encodeURIComponent(area)}/venues`),
};
