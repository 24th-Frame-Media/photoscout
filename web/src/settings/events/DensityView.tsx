import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DensityArea, DensityGrid } from './api.js';
import { busyColour } from './BusyChart.js';
import { isNotSetUp, SetUpNotice } from './shared.js';

const WINDOWS = [
  { key: '24', label: 'Last 24 hours', query: '' },
  { key: '168', label: 'Last 7 days', query: 'hours=168' },
  { key: 'all', label: 'All history', query: 'all=1' },
] as const;

/** The middle of a cell, from its outline (GeoJSON order: lng, lat). */
function centreOf(ring: [number, number][]): { lat: number; lng: number } {
  const pts = ring.slice(0, -1);
  return { lng: pts.reduce((n, p) => n + p[0], 0) / pts.length, lat: pts.reduce((n, p) => n + p[1], 0) / pts.length };
}

/**
 * Where the crowds have been, as a ranked list of grid cells rather than a
 * heat layer: the busiest cells for an area, a window of time and optionally an
 * hour of the day, each with a link that opens it on the map.
 */
export default function DensityView() {
  const [areas, setAreas] = useState<DensityArea[]>([]);
  const [area, setArea] = useState('');
  const [window, setWindow] = useState<(typeof WINDOWS)[number]['key']>('24');
  const [hour, setHour] = useState('');
  const [grid, setGrid] = useState<DensityGrid | null>(null);
  const [message, setMessage] = useState('');
  const [notSetUp, setNotSetUp] = useState(false);

  useEffect(() => {
    api.densityAreas()
      .then((r) => { setAreas(r.areas); if (r.areas.length) setArea(r.areas[0].slug); })
      .catch((err) => { if (isNotSetUp(err)) setNotSetUp(true); else setMessage((err as Error).message); });
  }, []);

  useEffect(() => {
    if (!area) return;
    const query = [WINDOWS.find((w) => w.key === window)!.query, hour !== '' ? `hour=${hour}` : ''].filter(Boolean).join('&');
    setGrid(null);
    setMessage('');
    api.densityGrid(area, query ? `?${query}` : '')
      .then(setGrid)
      // A 404 here means nothing was observed in that window, which is an answer and not a failure.
      .catch((err) => setMessage((err as Error).message));
  }, [area, window, hour]);

  const cells = useMemo(() => (grid?.features ?? [])
    .map((f) => ({ ...f.properties, ...centreOf(f.geometry.coordinates[0]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25), [grid]);

  if (notSetUp) return <SetUpNotice />;
  return (
    <section>
      <h2>🔥 Busy map</h2>
      <p className="hint">The busiest places in an area from the venue sampler. Open any row on the map.</p>
      <div className="places__bar">
        {areas.length > 1 && (
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            {areas.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
          </select>
        )}
        <select value={window} onChange={(e) => setWindow(e.target.value as typeof window)}>
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        <select value={hour} onChange={(e) => setHour(e.target.value)}>
          <option value="">Any hour</option>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
        </select>
      </div>
      {message && <p className="hint">{message}</p>}
      {!grid && !message && <p className="hint">Loading…</p>}
      {grid && (
        <>
          <p className="hint">{grid.metadata.area}: {grid.metadata.label}, {grid.metadata.observations.toLocaleString()} observations.</p>
          <ol className="places__list">
            {cells.map((c, i) => (
              <li key={i}>
                <div className="places__row">
                  <span className="places__dot" style={{ background: busyColour(c.score) }} />
                  <span className="places__name">{c.topName ?? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`}</span>
                  <span className="places__pct">{Math.round(c.score * 100)}</span>
                  <Link to={`/?lat=${c.lat}&lng=${c.lng}`}>Map</Link>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
