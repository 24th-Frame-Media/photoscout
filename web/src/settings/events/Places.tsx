import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DensityArea, ShootVerdict, VenueHistory, VenueReading } from './api.js';
import BusyChart, { busyColour } from './BusyChart.js';
import { isNotSetUp, SetUpNotice } from './shared.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 9 and 13 as "9:00-14:00": the window runs to the end of the last hour. */
const windowLabel = (from: number, to: number): string => `${from}:00-${to + 1}:00`;

function ShootBadge({ shoot }: { shoot: ShootVerdict }) {
  if (shoot.label === 'Unknown') return null;
  return (
    <span className={`shoot shoot--${shoot.label.toLowerCase()}${shoot.estimated ? ' is-estimated' : ''}`} title={shoot.why}>
      {shoot.estimated ? '~' : ''}{shoot.label}{shoot.surge && ' ↑'}
    </span>
  );
}

/**
 * Every tracked place, with how busy it is now and how busy it usually is.
 *
 * The weekly profile says when a place is worth shooting; the measured readings
 * say whether today is unusual. Both are shown together because either alone
 * misleads.
 */
export default function Places() {
  const [areas, setAreas] = useState<DensityArea[]>([]);
  const [area, setArea] = useState('');
  const [venues, setVenues] = useState<VenueReading[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, VenueHistory>>({});
  const [day, setDay] = useState(new Date().getDay());
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'busy' | 'shoot'>('busy');
  const [notSetUp, setNotSetUp] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.densityAreas()
      .then((r) => { setAreas(r.areas); if (r.areas.length) setArea(r.areas[0].slug); })
      .catch((err) => { if (isNotSetUp(err)) setNotSetUp(true); else setError((err as Error).message); });
  }, []);

  useEffect(() => {
    if (!area) return;
    setOpen(null);
    setHistory({});
    api.venues(area).then(setVenues).catch((err) => { setVenues([]); setError((err as Error).message); });
  }, [area]);

  async function toggle(name: string) {
    if (open === name) return setOpen(null);
    setOpen(name);
    if (history[name]) return;
    try {
      const h = await api.venueHistory(area, name, 14);
      setHistory((prev) => ({ ...prev, [name]: h }));
    } catch { /* leaves the row open with its loading note */ }
  }

  if (notSetUp) return <SetUpNotice />;

  const shown = venues
    .filter((v) => v.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === 'shoot') return (b.shoot?.score ?? 0) - (a.shoot?.score ?? 0) || a.name.localeCompare(b.name);
      const rank = (v: VenueReading) => (v.live != null ? 0 : v.typical != null ? 1 : 2);
      return rank(a) - rank(b) || (b.live ?? b.typical ?? 0) - (a.live ?? a.typical ?? 0);
    });
  const today = new Date().getDay();
  const hourNow = new Date().getHours();

  return (
    <section>
      <h2>📍 Places</h2>
      <p className="hint">Venues the density sampler tracks, with how busy each is now and how busy it usually is.</p>
      <div className="places__bar">
        {areas.length > 1 && (
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            {areas.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
          </select>
        )}
        <input value={filter} placeholder="Filter places…" onChange={(e) => setFilter(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as 'busy' | 'shoot')}>
          <option value="busy">Busiest first</option>
          <option value="shoot">Best to shoot</option>
        </select>
        <span className="hint">{shown.length} of {venues.length}</span>
      </div>
      {error && <p className="status-line error">{error}</p>}
      {venues.length === 0 && !error && <p className="hint">No places tracked yet. Enable venue density under Density, then use Rebuild venue list.</p>}

      <ul className="places__list">
        {shown.map((v) => {
          const h = history[v.name];
          const expanded = open === v.name;
          const profileDay = h?.byDay?.[DAYS[day]] ?? null;
          const summary = h?.daySummary?.[day];
          return (
            <li key={`${v.name}@${v.lat},${v.lon}`} className={expanded ? 'is-open' : ''}>
              <button className="places__row" onClick={() => void toggle(v.name)}>
                <span className="places__dot" style={{ background: busyColour(v.score) }} />
                <span className="places__name">{v.name}</span>
                {v.shoot && <ShootBadge shoot={v.shoot} />}
                {v.busiestDay && <span className="places__busiest">busiest {v.busiestDay}{v.busiestHour != null && ` ${v.busiestHour}:00`}</span>}
                <span className="places__pct">{v.live != null ? `${v.live}%` : v.typical != null ? `~${v.typical}%` : '–'}</span>
                <span className="places__chev">{expanded ? '▾' : '▸'}</span>
              </button>

              {expanded && (
                <div className="places__detail">
                  {!h ? <p className="hint">Loading…</p> : (
                    <>
                      {h.now && <p className="places__verdict"><ShootBadge shoot={h.now} /> <span>{h.now.why}</span></p>}
                      <p><Link to={`/?lat=${v.lat}&lng=${v.lon}`}>Show on the map</Link></p>
                      <div className="places__days">
                        {DAYS.map((d, i) => (
                          <button key={d} className={i === day ? 'active' : ''} disabled={!h.byDay?.[d] || Object.keys(h.byDay[d]).length === 0}
                            onClick={() => setDay(i)} title={i === today ? 'Today' : undefined}>
                            {d.slice(0, 3)}{i === today && ' •'}
                          </button>
                        ))}
                      </div>
                      {profileDay && Object.keys(profileDay).length > 0 ? (
                        <>
                          {/* Readings for the weekday shown, not for today: picking a tab asks what that day looks like. */}
                          <BusyChart hours={profileDay} observed={h.observedByDay?.[day]} light={h.lightByDay?.[day]}
                            best={summary?.best ?? null} markHour={day === today ? hourNow : null} />
                          <p className="hint">
                            Bars: typical for {DAYS[day]} · dots: measured live ·{' '}
                            {summary?.live ? `${summary.live} live reading${summary.live === 1 ? '' : 's'} on ${DAYS[day].slice(0, 3)}` : `no live readings on ${DAYS[day].slice(0, 3)} yet`}
                            {summary && summary.readings > summary.live && ` (of ${summary.readings} checks)`}
                          </p>
                          <p className="hint">
                            {summary?.best
                              ? <>Best on {DAYS[day]}: <b>{windowLabel(summary.best.from, summary.best.to)}</b> · {summary.best.label.toLowerCase()} for photos</>
                              : <>Nothing worth a trip on {DAYS[day]}: too quiet all day.</>}
                          </p>
                        </>
                      ) : <p className="hint">Closed on {DAYS[day]}, or no profile.</p>}

                      {h.points.length > 0 && (
                        <>
                          <h4>Recent readings</h4>
                          <ul className="places__recent">
                            {h.points.slice(-8).reverse().map((p) => (
                              <li key={p.ts}>
                                <span>{new Date(p.ts * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                                <span>
                                  {p.live != null ? `${p.live}%` : '–'}
                                  {p.typical != null && <span className="hint"> {p.live != null && p.live > p.typical ? '↑' : p.live != null && p.live < p.typical ? '↓' : '·'}{p.typical}%</span>}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
