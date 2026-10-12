import { useMemo, useState } from 'react';
import { type Route, type RouteType, type Visibility } from '../api.js';
import {
  formatDuration,
  reverseWaypoints,
  routeDistanceKm,
  routeLightingMix,
  routePlanAnchor,
  routeStops,
  stopLabel,
} from '../map/routeGeometry.js';
import { sunPos } from '../map/sun.js';

export interface RouteDraft {
  id?: string;
  name: string;
  notes: string;
  access: string;
  type: RouteType;
  vertices: [number, number][];
  staging: { lat: number; lng: number } | null;
  visibility: Visibility;
  /** Road routing preference. Old saved routes may not have this field. */
  snap?: boolean;
  /** Server timestamp this draft was based on, to spot a stale recovered draft. */
  updatedAt?: string;
  /** Ordered user-selected stops, distinct from routed geometry. */
  waypoints?: [number, number][];
}

export function routeToDraft(r: Route): RouteDraft {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes,
    access: r.access,
    type: r.type,
    vertices: r.vertices.slice(),
    staging: r.staging ? { ...r.staging } : null,
    visibility: r.visibility,
    ...(r.waypoints ? { waypoints: r.waypoints.map((point) => [...point] as [number, number]) } : {}),
    snap: r.snap ?? false,
    updatedAt: r.updatedAt,
  };
}

export function blankRouteDraft(): RouteDraft {
  return {
    name: '',
    notes: '',
    access: '',
    type: 'sprint',
    vertices: [],
    staging: null,
    visibility: 'private',
    snap: true,
    waypoints: [],
  };
}

/** The API body for saving a draft. */
export function draftToRoute(d: RouteDraft): Partial<Route> {
  return {
    name: d.name.trim(),
    notes: d.notes,
    access: d.access,
    type: d.type,
    vertices: d.vertices,
    staging: d.staging ?? null,
    visibility: d.visibility,
    ...(d.waypoints === undefined ? {} : { waypoints: d.waypoints }),
    ...(d.snap === undefined ? {} : { snap: d.snap }),
  };
}

/** The map owns road routing and history; this form edits the ordered stops. */
export default function RouteEditor({
  draft, drawing, stagingMode, time, onDrawing, onStagingMode, onChange,
  onWaypointsChange, routingBusy = false, routingError = '', onRetryRouting,
  onUndo, onRedo, canUndo = false, canRedo = false, routeDurationSec,
  onSave, onCancel, onDelete,
}: {
  draft: RouteDraft;
  drawing: boolean;
  stagingMode: boolean;
  time: Date;
  onDrawing: (on: boolean) => void;
  onStagingMode: (on: boolean) => void;
  onChange: (d: RouteDraft) => void;
  onWaypointsChange: (waypoints: [number, number][]) => void;
  routingBusy?: boolean;
  routingError?: string;
  onRetryRouting?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  routeDurationSec?: number | null;
  onSave: () => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<RouteDraft>) => onChange({ ...draft, ...patch });

  const points = routeStops(draft);
  const distKm = routeDistanceKm(draft.vertices, draft.type);
  const anchor = routePlanAnchor(draft.vertices, draft.staging) ?? { lat: -33.8688, lng: 151.2093 };
  const azimuth = sunPos(time, anchor.lat, anchor.lng).azimuth;
  const light = useMemo(() => routeLightingMix(draft.vertices, draft.type, azimuth), [draft.vertices, draft.type, azimuth]);

  function movePoint(index: number, direction: -1 | 1) {
    const next = points.slice();
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onWaypointsChange(next);
  }

  async function save() {
    setError('');
    if (!draft.name.trim()) return setError('Enter a route name.');
    if (draft.vertices.length < 2) return setError('Choose a start and finish on the map.');
    if (routingBusy || routingError) return;
    setSaving(true);
    try { await onSave(); }
    catch (err) { setError((err as Error).message || 'Could not save route.'); }
    finally { setSaving(false); }
  }

  return (
    <form className="editor-form route-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{draft.id ? 'Edit route' : 'New route'}</h2>

      <div className="route-editor__guide" aria-live="polite">
        <strong>{routingBusy ? 'Finding road route…' : routingError ? 'Road route needs attention' : points.length === 0 ? '1. Choose a start' : points.length === 1 ? '2. Choose a finish' : 'Route ready to refine'}</strong>
        <span>{routingError ? 'Retry routing below before saving.' : points.length < 2 ? 'Click the map to place it.' : 'Click the map for another stop, or drag a point to adjust the route.'}</span>
      </div>
      <div className="chiprow mt-8">
        <button type="button" className={drawing ? 'primary' : ''} onClick={() => { onDrawing(!drawing); onStagingMode(false); }}>
          {drawing ? 'Stop adding points' : 'Add points on map'}
        </button>
        <button type="button" onClick={onUndo} disabled={!canUndo}>Undo</button>
        <button type="button" onClick={onRedo} disabled={!canRedo}>Redo</button>
        <button type="button" onClick={() => onWaypointsChange([])} disabled={points.length === 0 || routingBusy}>Clear</button>
      </div>
      <label className="row mt-8">
        <input type="checkbox" checked={!!draft.snap} onChange={(e) => set({ snap: e.target.checked })} disabled={routingBusy} />
        Follow roads
      </label>
      {routingBusy && <p className="status-line" role="status">Finding the driveable route…</p>}
      {routingError && (
        <p className="status-line error" role="alert">
          Road routing failed: {routingError} {onRetryRouting && <button type="button" onClick={onRetryRouting}>Retry</button>}
        </p>
      )}

      {points.length > 0 && (
        <ol className="route-editor__points" aria-label="Route points">
          {points.map(([lng, lat], index) => (
            <li key={index}>
              <span className="route-editor__point-label">{stopLabel(index, points.length)}</span>
              <span className="route-editor__coord">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
              <div className="route-editor__point-actions">
                <button type="button" aria-label={`Move point ${index + 1} earlier`} onClick={() => movePoint(index, -1)} disabled={index === 0 || routingBusy}>↑</button>
                <button type="button" aria-label={`Move point ${index + 1} later`} onClick={() => movePoint(index, 1)} disabled={index === points.length - 1 || routingBusy}>↓</button>
                <button type="button" aria-label={`Remove point ${index + 1}`} onClick={() => onWaypointsChange(points.filter((_, i) => i !== index))} disabled={routingBusy}>×</button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="route-telemetry">
        <div className="route-telemetry__item"><span className="route-telemetry__lbl">Distance</span><span className="route-telemetry__val">{distKm ? `${distKm.toFixed(2)} km` : '—'}</span></div>
        <div className="route-telemetry__item"><span className="route-telemetry__lbl">Drive time</span><span className="route-telemetry__val">{routeDurationSec != null && routeDurationSec > 0 ? formatDuration(routeDurationSec) : '—'}</span></div>
      </div>
      {routeDurationSec == null && points.length >= 2 && <p className="hint">Drive time appears when road routing succeeds.</p>}
      {draft.vertices.length >= 2 && <p className="hint">Light now: {light.side}% side · {light.backlit}% backlit · {light.front}% into sun</p>}

      <h4>Direction</h4>
      <div className="chiprow">
        <button type="button" className={draft.type === 'sprint' ? 'active' : ''} aria-pressed={draft.type === 'sprint'} onClick={() => set({ type: 'sprint' })} disabled={routingBusy}>Sprint</button>
        <button type="button" className={draft.type === 'circuit' ? 'active' : ''} aria-pressed={draft.type === 'circuit'} onClick={() => set({ type: 'circuit' })} disabled={routingBusy}>Circuit</button>
      </div>
      <p className="hint">{draft.type === 'circuit' ? 'Circuit: returns to the start after the last stop.' : 'Sprint: ends at the final stop.'}</p>
      {points.length >= 2 && (
        <button type="button" onClick={() => draft.waypoints ? onWaypointsChange(reverseWaypoints(points)) : onChange({ ...draft, vertices: reverseWaypoints(draft.vertices) })} disabled={routingBusy}>
          Reverse direction
        </button>
      )}

      <label className="mt-8">Route name
        <input value={draft.name} placeholder="e.g. Sea Cliff Bridge northbound" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>Visibility
        <select value={draft.visibility} onChange={(e) => set({ visibility: e.target.value as Visibility })}>
          <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
        </select>
      </label>

      <details className="route-editor__details">
        <summary>Meetup & notes</summary>
        <div className="chiprow mt-8">
          <button type="button" className={stagingMode ? 'primary' : ''} onClick={() => { onStagingMode(!stagingMode); onDrawing(false); }}>
            {stagingMode ? 'Click map for meetup' : draft.staging ? 'Move meetup' : 'Set meetup on map'}
          </button>
          {draft.staging && <button type="button" onClick={() => set({ staging: null })}>Clear meetup</button>}
        </div>
        {draft.staging && <p className="hint">Meetup: {draft.staging.lat.toFixed(5)}, {draft.staging.lng.toFixed(5)}</p>}
        <label>Access & turnaround<textarea rows={2} value={draft.access} onChange={(e) => set({ access: e.target.value })} /></label>
        <label>Notes<textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      </details>

      {error && <p className="status-line error" role="alert">{error}</p>}
      <div className="panel__actions route-editor__actions">
        <button className="primary" type="submit" disabled={saving || routingBusy || !!routingError || draft.vertices.length < 2}>
          {saving ? 'Saving…' : routingBusy ? 'Routing…' : 'Save route'}
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {onDelete && <button type="button" onClick={onDelete}>Delete</button>}
      </div>
    </form>
  );
}
