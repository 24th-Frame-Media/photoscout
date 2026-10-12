import { useEffect, useState } from 'react';
import { api, DensityStatus } from './api.js';
import { ListArea, LINE_BREAK, SaveBar, SetUpNotice, useEventSettings } from './shared.js';

/** Venue density: how busy local venues get, sampled on a timer. */
export default function Density() {
  const s = useEventSettings();
  const { draft, set } = s;
  const [density, setDensity] = useState<DensityStatus | null>(null);
  const [densityMsg, setDensityMsg] = useState('');

  // Poll while a sample is in flight; a pass takes minutes.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.densityStatus()
        .then((st) => { if (alive) setDensity(st); })
        .catch(() => { if (alive) setDensity(null); });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  async function runDensity(action: 'refresh' | 'discover'): Promise<void> {
    setDensityMsg(action === 'refresh' ? 'Sampling venues…' : 'Rebuilding venue list…');
    try {
      const res = action === 'refresh' ? await api.densityRefresh() : await api.densityDiscover();
      setDensityMsg(res.message);
    } catch (err) {
      setDensityMsg((err as Error).message);
    }
    api.densityStatus().then(setDensity).catch(() => undefined);
  }

  if (s.notSetUp) return <SetUpNotice />;
  if (!draft) return s.error ? <p className="status-line error">{s.error}</p> : <p className="hint">Loading…</p>;

  return (
    <>
      <section>
        <h2>
          📊 Venue density
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.densityEnabled === true}
              onChange={(e) => set({ densityEnabled: e.target.checked })}
            />{' '}
            Enabled
          </label>
        </h2>
        <p className="hint">
          Samples how busy local venues are, on its own schedule alongside the event sources.
          Each pass opens one page per venue, so keep the interval relaxed.
        </p>

        <div className="formrow" style={{ marginTop: 12 }}>
          <label>Every: {draft.densityIntervalMinutes ?? 60} min</label>
          <input
            type="range"
            min={15}
            max={240}
            step={15}
            value={draft.densityIntervalMinutes ?? 60}
            onChange={(e) => set({ densityIntervalMinutes: Number(e.target.value) })}
          />
        </div>

        <label className="hint">
          Areas — one per line as <code>Name, lat, lng, radiusKm</code>. Leave blank to use the
          location above.
        </label>
        <ListArea
          text={(draft.densityAreas ?? [])
            .map((a) => [a.name, a.lat, a.lng, a.radiusKm].filter((v) => v != null && v !== '').join(', '))
            .join(LINE_BREAK)}
          placeholder="Bathurst, -33.4300, 149.5750, 5.5"
          onText={(raw) =>
            set({
              densityAreas: raw
                .split(LINE_BREAK)
                .map((line) => line.split(',').map((p) => p.trim()))
                .filter((parts) => parts[0])
                .map((parts) => ({
                  name: parts[0],
                  lat: parts[1] ? Number(parts[1]) : undefined,
                  lng: parts[2] ? Number(parts[2]) : undefined,
                  radiusKm: parts[3] ? Number(parts[3]) : undefined,
                })),
            })
          }
        />

        <div className="formrow" style={{ marginTop: 10 }}>
          <label>Max venues</label>
          <input
            type="number"
            min={0}
            step={5}
            value={draft.densityMaxVenues ?? 30}
            onChange={(e) => set({ densityMaxVenues: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          <b>0 tracks every place found.</b> Each venue is one page load, so this is a
          time budget rather than a limit — around 10 seconds each, and the hourly run
          skips itself while one is still going.
        </p>

        <div className="formrow">
          <label>Pause between pages (s)</label>
          <input
            type="number"
            min={0}
            step={0.5}
            value={(draft.densityRequestDelayMs ?? 2000) / 1000}
            onChange={(e) => set({ densityRequestDelayMs: Math.max(0, Math.round((Number(e.target.value) || 0) * 1000)) })}
          />
        </div>
        <div className="formrow">
          <label>Page settle time (s)</label>
          <input
            type="number"
            min={1}
            step={0.5}
            value={(draft.densityWaitMs ?? 7000) / 1000}
            onChange={(e) => set({ densityWaitMs: Math.max(1000, Math.round((Number(e.target.value) || 1) * 1000)) })}
          />
        </div>
        <div className="formrow">
          <label>Matches per named place</label>
          <input
            type="number"
            min={1}
            step={1}
            value={draft.densityPlacesPerName ?? 2}
            onChange={(e) => set({ densityPlacesPerName: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
          />
        </div>

        <label className="hint" style={{ display: 'block', marginTop: 10 }}>
          Always include these venues — a name, or a Google Maps link. A link pins
          exactly one place, which a name cannot: searching{' '}
          <code>Mount Panorama</code> returns the mountain, the reserve and the
          circuit, and only one of them carries busyness data.
        </label>
        <ListArea
          text={(draft.densityPlaces ?? []).join(LINE_BREAK)}
          placeholder={'Mount Panorama' + LINE_BREAK + 'https://maps.app.goo.gl/…'}
          onText={(raw) =>
            set({ densityPlaces: raw.split(LINE_BREAK).map((v) => v.trim()).filter(Boolean) })
          }
        />

        {density && (
          <div className={`status-line ${density.running ? 'never_run' : 'ok'}`}>
            {density.running
              ? '○ Sampling now…'
              : `● ${density.lastResult ?? 'not sampled yet'}${
                  density.lastRun ? ` (${new Date(density.lastRun).toLocaleString()})` : ''
                }`}
          </div>
        )}

        {density && density.areas.length > 0 && (
          <p className="map-panel__meta" style={{ marginTop: 6 }}>
            {density.areas
              .map((a) => `${a.name}: ${a.venues} venues, ${a.withProfile} profiled`)
              .join(' · ')}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="ghost" disabled={density?.running} onClick={() => runDensity('refresh')}>
            Sample now
          </button>
          <button className="ghost" disabled={density?.running} onClick={() => runDensity('discover')}>
            Rebuild venue list
          </button>
        </div>
        {densityMsg && <p className="hint" style={{ marginTop: 8 }}>{densityMsg}</p>}
      </section>
      <SaveBar save={s.save} dirty={s.dirty} saved={s.saved} busy={s.busy} error={s.error} canRefresh={draft.lat != null} />
    </>
  );
}
