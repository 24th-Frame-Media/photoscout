import { useEffect, useState } from 'react';
import { api, MoonInfo, PhotoConditions, SunDay, WeatherDay } from './api.js';
import { isNotSetUp, SetUpNotice } from './shared.js';

const time = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
const span = (w: { start: string; end: string } | null): string => (w ? `${time(w.start)} – ${time(w.end)}` : '—');

/** Clear skies are flat; broken cloud is what makes a sky worth shooting. */
function cloudNote(pct: number): string {
  if (pct < 15) return 'clear, flat sky';
  if (pct < 40) return 'some cloud, good';
  if (pct < 75) return 'broken cloud, best';
  return 'overcast, soft light';
}

function moonGlyph(illumination: number, phase: string): string {
  if (phase === 'New moon') return '🌑';
  if (phase === 'Full moon') return '🌕';
  const waxing = phase.startsWith('Waxing') || phase === 'First quarter';
  if (illumination < 35) return waxing ? '🌒' : '🌘';
  if (illumination < 65) return waxing ? '🌓' : '🌗';
  return waxing ? '🌔' : '🌖';
}

/** The date the figures are for, read off the sun day so a tab left open overnight is not misleading. */
const dayDate = (sun: SunDay): string =>
  new Date(`${sun.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function DayBlock({ label, sun, weather, moon }: { label: string; sun: SunDay; weather: WeatherDay | null; moon: MoonInfo }) {
  const rows: [string, string, string?][] = [
    ['Golden hour', span(sun.goldenMorning)],
    ['Golden hour', span(sun.goldenEvening)],
    ['Blue hour', span(sun.blueMorning)],
    ['Blue hour', span(sun.blueEvening)],
    ['Sun', `${time(sun.sunrise)} – ${time(sun.sunset)}`, sun.dayLength ?? undefined],
  ];
  if (weather) {
    rows.push(['Sky', weather.summary, weather.tempMin != null && weather.tempMax != null ? `${Math.round(weather.tempMin)}–${Math.round(weather.tempMax)}°` : undefined]);
    if (weather.cloudCover != null) rows.push(['Cloud', `${Math.round(weather.cloudCover)}%`, cloudNote(weather.cloudCover)]);
    rows.push(['Rain / UV', weather.rainChance != null ? `${weather.rainChance}%` : '—',
      [weather.uvMax != null ? `UV ${weather.uvMax.toFixed(1)}` : '', weather.windMax != null ? `${Math.round(weather.windMax)} km/h` : ''].filter(Boolean).join(' · ') || undefined]);
  }
  rows.push(['Moon', `${moonGlyph(moon.illumination, moon.phase)} ${moon.phase}`, `${moon.illumination}% lit`]);
  return (
    <table className="triptable">
      <thead><tr><th colSpan={2}>{label} <span className="hint">{dayDate(sun)}</span></th></tr></thead>
      <tbody>
        {rows.map(([k, v, sub], i) => (
          <tr key={i}><td className="hint">{k}</td><td>{v}{sub && <span className="hint"> · {sub}</span>}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** Shooting conditions: light windows, sky and moon for today and tomorrow, at the events location. */
export default function Conditions() {
  const [data, setData] = useState<PhotoConditions | null>(null);
  const [error, setError] = useState('');
  const [notSetUp, setNotSetUp] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => api.photo()
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((err) => { if (!alive) return; if (isNotSetUp(err)) setNotSetUp(true); else setError((err as Error).message); });
    void load();
    // The engine keeps it for 20 minutes; this only keeps a long-open tab honest.
    const id = setInterval(load, 15 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (notSetUp) return <SetUpNotice />;
  return (
    <section>
      <h2>📷 Conditions {data?.location && <span className="hint">{data.location.city}</span>}</h2>
      {error && <p className="status-line error">{error}</p>}
      {!data ? (!error && <p className="hint">Loading conditions…</p>) : (
        <>
          {data.now && (
            <p>
              <b>{Math.round(data.now.temp ?? 0)}°</b>{' '}
              <span className="hint">{data.now.summary}{data.now.cloudCover != null && ` · ${data.now.cloudCover}% cloud`}{data.now.wind != null && ` · ${Math.round(data.now.wind)} km/h`}</span>
            </p>
          )}
          <DayBlock label="Today" sun={data.today.sun} weather={data.today.weather} moon={data.today.moon} />
          <DayBlock label="Tomorrow" sun={data.tomorrow.sun} weather={data.tomorrow.weather} moon={data.tomorrow.moon} />
          {!data.location && <p className="hint">Set a location under Events for local times and weather.</p>}
          <p className="hint">Sun times computed locally · weather from Open-Meteo.</p>
        </>
      )}
    </section>
  );
}
