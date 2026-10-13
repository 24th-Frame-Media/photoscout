import { useState } from 'react';
import type { Cruise, CruiseInput, Route, RouteType } from '../api.js';
import { fromLocalInput, toLocalInput } from '../kit.js';
import CruiseMap from './CruiseMap.js';

/** The cruise part of the event form, as the fields hold it. */
export interface CruiseDraft {
  enabled: boolean;
  source: 'saved' | 'draw';
  routeId: string;
  vertices: [number, number][];
  name: string;
  type: RouteType;
  meetLat: string;
  meetLng: string;
  meetNote: string;
  /** A `datetime-local` value. */
  rollOut: string;
}

export const blankCruise: CruiseDraft = { enabled: false, source: 'draw', routeId: '', vertices: [], name: '', type: 'sprint', meetLat: '', meetLng: '', meetNote: '', rollOut: '' };

/** An event's cruise as the fields start out when editing: its line comes back as a drawn one, which can be reshaped. */
export function draftFromCruise(c: Cruise | null): CruiseDraft {
  if (!c) return blankCruise;
  return {
    enabled: true, source: 'draw', routeId: '', vertices: (c.route.vertices ?? []).map((p) => [...p] as [number, number]),
    name: c.route.name, type: c.route.type, meetLat: String(c.meet.lat), meetLng: String(c.meet.lng), meetNote: c.meet.note, rollOut: toLocalInput(c.rollOut),
  };
}

/** What to send, or why not. */
export function cruiseInput(d: CruiseDraft): { ok: true; value: CruiseInput } | { ok: false; error: string } {
  const rollOut = fromLocalInput(d.rollOut);
  const lat = d.meetLat.trim() === '' ? NaN : Number(d.meetLat), lng = d.meetLng.trim() === '' ? NaN : Number(d.meetLng);
  if (d.source === 'saved' && !d.routeId) return { ok: false, error: 'Choose a saved route, or draw one' };
  if (d.source === 'draw' && d.vertices.length < 2) return { ok: false, error: 'Draw the route: click at least two points on the map' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'Place the meeting point on the map' };
  if (!rollOut) return { ok: false, error: 'Choose the roll-out time' };
  return {
    ok: true,
    value: {
      ...(d.source === 'saved' ? { routeId: d.routeId } : { vertices: d.vertices, type: d.type }),
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      meet: { lat, lng, note: d.meetNote.trim() },
      rollOut,
    },
  };
}

/**
 * Plan a cruise: a route to drive (one of yours, or a line drawn here), where to meet and when to roll out.
 * A saved route is copied onto the event, which is said out loud because it changes who can see the line.
 */
export default function CruiseFields({ draft, onChange, routes }: { draft: CruiseDraft; onChange: (patch: Partial<CruiseDraft>) => void; routes: Route[] | null }) {
  const [mode, setMode] = useState<'line' | 'meet'>('line');
  const picked = draft.source === 'saved' ? routes?.find((r) => r.id === draft.routeId) : undefined;
  const line = draft.source === 'saved' ? picked?.vertices ?? [] : draft.vertices;
  const lat = Number(draft.meetLat), lng = Number(draft.meetLng);
  const meet = draft.meetLat.trim() !== '' && draft.meetLng.trim() !== '' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const editMode = draft.source === 'saved' ? 'meet' : mode;

  return (
    <>
      <label className="toggle">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        This is a cruise: a route to drive together
      </label>
      {draft.enabled && (
        <div className="cruisefields">
          <div className="chiprow">
            <button type="button" className={`chip${draft.source === 'draw' ? ' active' : ''}`} onClick={() => { onChange({ source: 'draw' }); setMode('line'); }}>Draw a route</button>
            <button type="button" className={`chip${draft.source === 'saved' ? ' active' : ''}`} onClick={() => onChange({ source: 'saved' })}>Use a saved route</button>
          </div>
          {draft.source === 'saved' && (
            <>
              <label>Your saved routes
                <select value={draft.routeId} onChange={(e) => { const r = routes?.find((x) => x.id === e.target.value); onChange({ routeId: e.target.value, ...(r ? { name: r.name, type: r.type } : {}) }); }}>
                  <option value="">Choose…</option>
                  {(routes ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}{r.visibility === 'private' ? ' (private)' : ''}</option>)}
                </select>
              </label>
              {routes && routes.length === 0 && <p className="hint">You have no saved routes yet. Save one from the map, or draw one here.</p>}
              <p className="hint">Attaching copies this route&apos;s line onto the event, so anyone who can see the event can see the line, even if the saved route is private. Its notes, access remarks and staging point are not copied.</p>
            </>
          )}
          {draft.source === 'draw' && (
            <div className="eventcard__actions">
              <button type="button" className={mode === 'line' ? 'primary' : ''} onClick={() => setMode('line')}>Draw route</button>
              <button type="button" onClick={() => onChange({ vertices: draft.vertices.slice(0, -1) })} disabled={draft.vertices.length === 0}>Undo point</button>
              <button type="button" onClick={() => onChange({ vertices: [] })} disabled={draft.vertices.length === 0}>Clear</button>
              <span className="hint">{draft.vertices.length} points, straight lines between them</span>
            </div>
          )}
          <div className="eventcard__actions">
            {draft.source === 'draw' && <button type="button" className={mode === 'meet' ? 'primary' : ''} onClick={() => setMode('meet')}>Place meeting point</button>}
            {draft.source === 'saved' && <span className="hint">Click the map to place the meeting point.</span>}
          </div>
          <CruiseMap line={line} type={draft.type} meet={meet} fitKey={draft.source === 'saved' ? draft.routeId : 'draw'}
            edit={{ mode: editMode, onPoint: (p) => onChange({ vertices: [...draft.vertices, [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]] }), onMeet: (a, o) => { onChange({ meetLat: a.toFixed(6), meetLng: o.toFixed(6) }); } }} />
          {draft.source === 'draw' && (
            <div className="formrow">
              <label>Route name</label>
              <input value={draft.name} maxLength={100} placeholder="Optional" onChange={(e) => onChange({ name: e.target.value })} />
              <select value={draft.type} onChange={(e) => onChange({ type: e.target.value as RouteType })} aria-label="Route type">
                <option value="sprint">Point to point</option>
                <option value="circuit">Circuit</option>
              </select>
            </div>
          )}
          <label>Meeting point note <input value={draft.meetNote} maxLength={200} placeholder="Servo car park, full tank please" onChange={(e) => onChange({ meetNote: e.target.value })} /></label>
          <label>Roll out at <input type="datetime-local" value={draft.rollOut} onChange={(e) => onChange({ rollOut: e.target.value })} /></label>
          <p className="hint">The roll-out time has to fall while the event is on. Once it is saved, people who say they are going can start the convoy from the event.</p>
        </div>
      )}
    </>
  );
}
