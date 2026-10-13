import { useEffect, useRef, useState } from 'react';
import type { Light, ObservedHour } from './api.js';

// Busyness ramp, quiet to packed. One place for it so a colour means the same thing in the list and the chart.
const STOPS = ['#3b2f6b', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'];

export function busyColour(score: number): string {
  const t = Math.max(0, Math.min(score, 1)) * (STOPS.length - 1);
  const i = Math.min(Math.floor(t), STOPS.length - 2);
  const f = t - i;
  const hex = (s: string): number[] => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
  const a = hex(STOPS[i]);
  const b = hex(STOPS[i + 1]);
  return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('');
}

/**
 * Hourly busyness as inline SVG.
 *
 * Bars are the typical profile for the day; dots are what was measured at that
 * hour on that weekday, so a dot well above its bar means something unusual is
 * on. Drawn in real pixels (the box is measured) because a stretched viewBox
 * turns the dots into ovals.
 */
export default function BusyChart({ hours, observed, markHour, light, best, height = 92 }: {
  /** Typical percentage by hour. */
  hours: Record<string, number>;
  /** Measured averages by hour, for the weekday being shown. */
  observed?: Record<number, ObservedHour>;
  markHour?: number | null;
  /** Light band per hour; the dark hours are shaded. */
  light?: Record<number, Light>;
  /** The stretch worth shooting, drawn as a band. */
  best?: { from: number; to: number; label: string } | null;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const entries = Object.entries(hours).map(([h, pct]) => ({ hour: Number(h), pct })).sort((a, b) => a.hour - b.hour);
  if (entries.length === 0) return <p className="hint">No profile for this day.</p>;

  const first = entries[0].hour;
  const last = entries[entries.length - 1].hour;
  const barW = width / Math.max(1, last - first + 1);
  const plot = height - 16;
  const y = (pct: number) => plot - (pct / 100) * plot;
  const x = (hour: number) => (hour - first) * barW;
  const dark = light ? entries.filter((e) => light[e.hour] === 'night').map((e) => e.hour) : [];

  return (
    <div className="busychart" ref={box}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Busyness by hour, ${first}:00 to ${last}:00`}>
        {dark.map((hour) => <rect key={`dark-${hour}`} x={x(hour)} y={0} width={barW} height={plot} className="busychart__dark" />)}
        {best && best.to >= first && best.from <= last && (
          <rect x={x(Math.max(best.from, first))} y={0} width={(Math.min(best.to, last) - Math.max(best.from, first) + 1) * barW} height={plot} className="busychart__best">
            <title>{`Best window: ${best.from}:00-${best.to + 1}:00 (${best.label})`}</title>
          </rect>
        )}
        {markHour != null && markHour >= first && markHour <= last && (
          <rect x={x(markHour) + barW * 0.14} y={plot + 1} width={Math.max(2, barW * 0.72)} height={2} className="busychart__now" />
        )}
        {entries.map(({ hour, pct }) => (
          <rect key={hour} x={x(hour) + barW * 0.14} y={y(pct)} width={Math.max(1, barW * 0.72)} height={Math.max(1, plot - y(pct))}
            rx={Math.min(2, barW * 0.2)} fill={busyColour(pct / 100)} opacity={markHour === hour ? 1 : 0.75}>
            <title>{`${hour}:00 - ${pct}% typical`}</title>
          </rect>
        ))}
        {observed && Object.entries(observed).map(([h, o]) => ({ hour: Number(h), ...o })).filter((o) => o.hour >= first && o.hour <= last).map((o) => (
          <circle key={`obs-${o.hour}`} cx={x(o.hour) + barW / 2} cy={y(o.avg)} r={3.5} className="busychart__dot">
            <title>{`${o.hour}:00 - measured ${o.avg}% live (${o.samples} reading${o.samples === 1 ? '' : 's'})`}</title>
          </circle>
        ))}
        {entries.filter((e) => e.hour % 3 === 0).map(({ hour }) => (
          <text key={`ax-${hour}`} x={x(hour) + barW / 2} y={height - 4} className="busychart__axis" textAnchor="middle">{hour}</text>
        ))}
      </svg>
    </div>
  );
}
