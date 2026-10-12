import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import {
  displayedSunBearingHits,
  planSunBearing,
  sunBearingSearchStart,
  SUN_BEARING_DEFAULT_WINDOWS,
  SUN_BEARING_RESULT_PREVIEW_COUNT,
  SUN_BEARING_RESULT_LIMIT,
  SUN_BEARING_SEARCH_DAYS,
  type SunBearingPhase,
  type SunBearingPlanHit,
} from '../map/sun.js';
import { hhmm, ymd } from '../time.js';
import BearingMiniMap from './BearingMiniMap.js';

export interface SunBearingPlannerProps {
  lat: number;
  lng: number;
  defaultBearingDeg: number | null;
  label: string;
  onApplyTime?: (time: Date) => void;
  showMap?: boolean;
}

// Sun's disc is ~0.5° wide. ponytail: fixed cutoffs; make them a setting if people want tighter/looser grading.
function matchGrade(errDeg: number): { label: string; tone: 'good' | 'ok' | 'warn' | 'bad' } {
  if (errDeg <= 0.5) return { label: 'on the line', tone: 'good' };
  if (errDeg <= 2) return { label: 'close', tone: 'ok' };
  if (errDeg <= 5) return { label: 'near miss', tone: 'warn' };
  return { label: 'sun never reaches this bearing', tone: 'bad' };
}
const Grade = ({ errDeg }: { errDeg: number }) => {
  const g = matchGrade(errDeg);
  return <strong className={`sunplan__grade sunplan__grade--${g.tone}`}> · {g.label}</strong>;
};
const fmtDeg =(n: number) => `${n.toFixed(1)}°`;
const dayLabel = (d: Date) => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function ResultRow({ hit, onApplyTime }: { hit: SunBearingPlanHit; onApplyTime?: (time: Date) => void }) {
  return (
    <li className="sunplan__result">
      <div>
        <strong>{dayLabel(hit.time)} {hhmm(hit.time)}</strong>
        <span className="hint">{hit.phase} · az {fmtDeg(hit.azimuthDeg)} · alt {fmtDeg(hit.altitudeDeg)} · error {fmtDeg(hit.signedErrorDeg)}
          <Grade errDeg={hit.absoluteErrorDeg} /></span>
      </div>
      {onApplyTime && <button type="button" onClick={() => onApplyTime(hit.time)}>Set time</button>}
    </li>
  );
}

export default function SunBearingPlanner({ lat, lng, defaultBearingDeg, label, onApplyTime, showMap }: SunBearingPlannerProps) {
  const resultsId = useId();
  const [bearing, setBearing] = useState(defaultBearingDeg == null ? '' : String(Math.round(defaultBearingDeg)));
  const [bearingEdited, setBearingEdited] = useState(false);
  const [phase, setPhase] = useState<SunBearingPhase>('both');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setBearingEdited(false);
    setBearing(defaultBearingDeg == null ? '' : String(Math.round(defaultBearingDeg)));
    setExpanded(false);
  }, [lat, lng]);

  useEffect(() => {
    if (!bearingEdited) {
      setBearing(defaultBearingDeg == null ? '' : String(Math.round(defaultBearingDeg)));
      setExpanded(false);
    }
  }, [bearingEdited, defaultBearingDeg]);

  // Deferred so typing stays responsive while the year-long search catches up.
  const bearingNum = Number(useDeferredValue(bearing));
  const today = ymd(new Date());
  const results = useMemo(() => {
    if (!Number.isFinite(bearingNum)) return [];
    return planSunBearing({
      lat,
      lng,
      bearingDeg: bearingNum,
      phase,
      startDate: sunBearingSearchStart(new Date()),
      days: SUN_BEARING_SEARCH_DAYS,
      ...SUN_BEARING_DEFAULT_WINDOWS,
    }).sort((a, b) => a.absoluteErrorDeg - b.absoluteErrorDeg).slice(0, SUN_BEARING_RESULT_LIMIT);
  }, [lat, lng, bearingNum, phase, today]);
  const visibleResults = displayedSunBearingHits(results, expanded);
  const canToggleResults = results.length > SUN_BEARING_RESULT_PREVIEW_COUNT;

  return (
    <section className="sunplan" aria-label={label}>
      <h4>{label}</h4>
      <div className={showMap ? 'sunplan__split' : undefined}>
      {showMap && (
        <div>
          <BearingMiniMap
            lat={lat}
            lng={lng}
            bearingDeg={Number.isFinite(bearingNum) ? bearingNum : null}
            bestHit={results[0] ? { time: results[0].time, azimuthDeg: results[0].azimuthDeg } : undefined}
            onChange={(deg) => {
              setBearingEdited(true);
              setExpanded(false);
              setBearing(String(deg));
            }}
          />
          <p className="hint">Pink = your bearing · shaded wedges = where the sun rises/sets over the next year · dot = closest match. Drag on the map or use arrow keys.</p>
        </div>
      )}
      <div>
      <div className="sunplan__grid">
        <label>Bearing
          <input type="number" inputMode="decimal" min={0} max={359.999} step={0.1} value={bearing}
            onChange={(e) => { setBearingEdited(true); setExpanded(false); setBearing(e.target.value); }} aria-label="Exact sun bearing in degrees" />
        </label>
        <label>Phase
          <select value={phase} onChange={(e) => { setExpanded(false); setPhase(e.target.value as SunBearingPhase); }} aria-label="Sunrise, sunset, or both">
            <option value="both">Both</option>
            <option value="sunrise">Sunrise</option>
            <option value="sunset">Sunset</option>
          </select>
        </label>
      </div>
      <p className="hint">Choose an exact compass bearing. Results search the next 365 days from today and are ordered by closest angular match.</p>
      {!Number.isFinite(bearingNum) ? <p className="hint">Enter a compass bearing.</p> : results.length === 0 ? <p className="hint">No sunrise or sunset window in the next 365 days.</p> : (
        <>
          <p className="hint"><strong>Closest alignment:</strong> {dayLabel(results[0].time)} {hhmm(results[0].time)} · {fmtDeg(results[0].absoluteErrorDeg)} error<Grade errDeg={results[0].absoluteErrorDeg} /></p>
          {results[0].absoluteErrorDeg > 5 && <p className="hint">The sun never rises or sets within 5° of this bearing in the next year; these are just the nearest it gets.</p>}
          <ol id={resultsId} className="plainlist sunplan__results">
          {visibleResults.map((hit) => <ResultRow key={`${hit.phase}-${hit.time.getTime()}`} hit={hit} onApplyTime={onApplyTime} />)}
          </ol>
          {canToggleResults && (
            <button
              type="button"
              className="sunplan__toggle"
              aria-expanded={expanded}
              aria-controls={resultsId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show less' : `Show more (${results.length - SUN_BEARING_RESULT_PREVIEW_COUNT})`}
            </button>
          )}
        </>
      )}
      </div>
      </div>
    </section>
  );
}
