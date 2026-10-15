/** Read real reports from the Android bridge. Pending scans are never a fresh empty feed. */
export interface WazeBoundingBox { minLng: number; minLat: number; maxLng: number; maxLat: number }
export interface WazeAlert {
  id: string; type: string; subType?: string; reportTime: number | null;
  point: [number, number]; street?: string; city?: string; description?: string; thumbsUp?: number;
}
const TYPES = new Set(['POLICE', 'HAZARD', 'CONSTRUCTION', 'CAMERA', 'ROAD_CLOSED', 'ACCIDENT', 'JAM']);

export function validateWazeBounds(bbox: WazeBoundingBox): void {
  const { minLng, minLat, maxLng, maxLat } = bbox;
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite) || minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90 || minLng >= maxLng || minLat >= maxLat) {
    throw new Error('A valid bounding box within longitude -180..180 and latitude -90..90 is required');
  }
}

export interface WazeWorkerHealth {
  setupStage: string | null;
  firstRun: { detectedAt: number | null; how: string | null } | null;
}

/** The worker's setup stage and, while Waze waits for a person, its first-run instructions. Health is public, so no key is sent. */
export async function fetchWazeWorkerHealth(fetchFn: typeof fetch = fetch): Promise<WazeWorkerHealth | null> {
  const serviceUrl = process.env.WAZE_ALERT_SERVICE_URL?.trim();
  if (!serviceUrl) return null;
  const url = new URL(serviceUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  url.pathname = url.pathname.replace(/\/alerts\/?$/, '/health');
  url.search = '';
  const response = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  const data = await response.json() as { setup_stage?: unknown; first_run?: unknown };
  const firstRun = data.first_run && typeof data.first_run === 'object' ? data.first_run as Record<string, unknown> : null;
  return {
    setupStage: typeof data.setup_stage === 'string' ? data.setup_stage : null,
    firstRun: firstRun ? {
      detectedAt: typeof firstRun.detected_at === 'number' && Number.isFinite(firstRun.detected_at) ? firstRun.detected_at : null,
      how: typeof firstRun.how === 'string' ? firstRun.how.slice(0, 2000) : null,
    } : null,
  };
}

export async function fetchWazeAlerts(bbox: WazeBoundingBox, fetchFn: typeof fetch = fetch, move = true, priority: 'map' | 'navigation' = 'map') {
  validateWazeBounds(bbox);
  const serviceUrl = process.env.WAZE_ALERT_SERVICE_URL?.trim();
  if (!serviceUrl) throw new Error('Set up Waze police and hazard reports in Settings');
  const url = new URL(serviceUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('The report bridge needs an HTTP URL and a separate API key');
  if (move) {
    for (const [key, value] of Object.entries(bbox)) url.searchParams.set(key, String(value));
    url.searchParams.set('priority', priority);
  }
  const response = await fetchFn(url, {
    headers: { Accept: 'application/json', ...(process.env.WAZE_HARVESTER_API_KEY ? { 'X-API-Key': process.env.WAZE_HARVESTER_API_KEY } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Waze report bridge returned HTTP ${response.status}`);
  const data = await response.json() as { alerts?: unknown; coverage?: unknown; observedAt?: unknown; mock?: unknown; connected?: unknown; state?: unknown; queuePosition?: unknown };
  if (response.status === 202 && (data.state === 'queued' || data.state === 'scanning') && data.mock !== true) {
    return { alerts: [] as WazeAlert[], coverage: 'viewport' as const, observedAt: null, state: data.state, queuePosition: typeof data.queuePosition === 'number' ? data.queuePosition : null, retryAfterMs: 5000 };
  }
  if (data.mock === true || data.connected === false || !Array.isArray(data.alerts) || (data.coverage !== 'route' && data.coverage !== 'viewport') || typeof data.observedAt !== 'number' || !Number.isFinite(data.observedAt) || data.observedAt > Date.now() + 60000 || Date.now() - data.observedAt > (data.state === 'stale' ? 360000 : 120000)) {
    throw new Error('Waze report bridge returned invalid or stale data');
  }
  const alerts: WazeAlert[] = [];
  for (const value of data.alerts) {
    if (!value || typeof value !== 'object') continue;
    const a = value as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id.trim() || typeof a.type !== 'string' || !TYPES.has(a.type) || !Array.isArray(a.point) || a.point.length !== 2 || !a.point.every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    const point = a.point as [number, number];
    if (point[0] < bbox.minLng || point[0] > bbox.maxLng || point[1] < bbox.minLat || point[1] > bbox.maxLat) continue;
    const alert: WazeAlert = { id: a.id, type: a.type, point,
      reportTime: typeof a.reportTime === 'number' && Number.isFinite(a.reportTime) && a.reportTime > 0 ? a.reportTime : null };
    for (const key of ['subType', 'street', 'city', 'description'] as const) if (typeof a[key] === 'string') alert[key] = a[key];
    if (typeof a.thumbsUp === 'number' && Number.isFinite(a.thumbsUp) && a.thumbsUp >= 0) alert.thumbsUp = a.thumbsUp;
    alerts.push(alert);
  }
  return { alerts, coverage: data.coverage as 'route' | 'viewport', observedAt: data.observedAt,
    state: data.state === 'stale' ? 'stale' as const : 'fresh' as const, retryAfterMs: data.state === 'stale' ? 5000 : 30000 };
}
