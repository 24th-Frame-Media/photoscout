import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AuroraData } from '../api.js';
import { dayPhases, moonPhase, moonPos, PHASE_COLOR, PHASE_LABEL, phaseAt, sunPos } from '../map/sun.js';
import { galacticCorePosition, milkyWayWindows } from '../map/galaxy.js';
import { hhmm, useMapTime, ymd } from '../time.js';

/** Date picker, Now button and a slider over the selected day with its sun phases drawn on the track. */
export default function TimeBar({ lat, lng }: { lat: number; lng: number }) {
  const { time, live, setTime, goLive } = useMapTime();
  const [aurora, setAurora] = useState<AuroraData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const timebarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.aurora().then((a) => { if (alive) setAurora(a); }).catch(() => {});
    const id = setInterval(() => api.aurora().then((a) => { if (alive) setAurora(a); }).catch(() => {}), 30 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const el = timebarRef.current;
    if (!el) return;
    const shell = (el.closest('.mapshell') as HTMLElement) ?? document.documentElement;
    const measure = () => {
      const h = el.offsetHeight;
      shell.style.setProperty('--timebar-h', `${h}px`);
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => {
      ro.disconnect();
      shell.style.removeProperty('--timebar-h');
    };
  }, []);

  const dayStart = new Date(time.getFullYear(), time.getMonth(), time.getDate());
  const dayKey = dayStart.getTime();
  const rLat = Math.round(lat * 20) / 20; // bands barely move within ~5 km
  const rLng = Math.round(lng * 20) / 20;

  const gradient = useMemo(() => {
    const bands = dayPhases(new Date(dayKey), rLat, rLng);
    const span = bands.at(-1)!.end.getTime() - dayKey;
    const stops = bands.map((b) => {
      const a = ((b.start.getTime() - dayKey) / span) * 100;
      const z = ((b.end.getTime() - dayKey) / span) * 100;
      return `${PHASE_COLOR[b.phase]} ${a}% ${z}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [dayKey, rLat, rLng]);

  const minutes = time.getHours() * 60 + time.getMinutes();
  const sun = sunPos(time, lat, lng);
  const moon = moonPos(time, lat, lng);
  const phase = phaseAt(time, lat, lng);
  const maxKp = Math.max(aurora?.kpNow ?? 0, aurora?.kpMaxNext24h ?? 0);
  const showAurora = maxKp >= 5 && Math.abs(lat) >= 30;

  const mwWindows = useMemo(() => milkyWayWindows(dayStart, rLat, rLng), [dayKey, rLat, rLng]);
  const inMwWindow = mwWindows.some((w) => time >= w.start && time < w.end);
  const mwCore = inMwWindow ? galacticCorePosition(time, lat, lng) : null;

  return (
    <div className={`timebar${expanded ? ' timebar--expanded' : ''}`} ref={timebarRef}>
      <div className="timebar__top">
        <div className="timebar__primary">
          <input type="date" value={ymd(time)} onChange={(e) => {
            if (!e.target.value) return;
            const [y, m, d] = e.target.value.split('-').map(Number);
            setTime(new Date(y, m - 1, d, time.getHours(), time.getMinutes()));
          }} />
          <button className={live ? 'active' : ''} onClick={goLive} title="Follow the clock">{live ? '● Live' : 'Now'}</button>
          <span className="timebar__time">{hhmm(time)}</span>
          <button
            type="button"
            className="timebar__toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            title={expanded ? 'Hide extra details' : 'Show extra details'}
          >
            {expanded ? '▴' : '▾'}
          </button>
        </div>
        <div className="timebar__secondary">
          <span className="timebar__phase" style={{ borderColor: PHASE_COLOR[phase] }}>{PHASE_LABEL[phase]}</span>
          <span className="timebar__meta">
            ☀ {Math.round(sun.azimuth)}° / {sun.altitude.toFixed(1)}° · ☾ {Math.round(moon.azimuth)}° / {moon.altitude.toFixed(0)}° {Math.round(moonPhase(time).fraction * 100)}%
          </span>
          {showAurora && (
            <span className="chip" title={`Current Kp: ${aurora?.kpNow?.toFixed(1) ?? '?'}, next 24h max: ${aurora?.kpMaxNext24h?.toFixed(1) ?? '?'}`}>
              Aurora possible · Kp {maxKp.toFixed(1)}
            </span>
          )}
          {inMwWindow && mwCore && (
            <span className="chip" title="Milky Way core visibility">
              MW core {Math.round(mwCore.altitude)}° @ {Math.round(mwCore.azimuth) % 360}°
            </span>
          )}
        </div>
      </div>
      <input className="timebar__slider" type="range" min={0} max={24 * 60 - 1} step={5} value={minutes} style={{ background: gradient }}
        aria-label="Time of day"
        onChange={(e) => setTime(new Date(time.getFullYear(), time.getMonth(), time.getDate(), 0, Number(e.target.value)))} />
    </div>
  );
}
