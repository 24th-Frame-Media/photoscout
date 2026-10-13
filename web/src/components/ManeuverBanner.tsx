import { arrowFor, type NavRoute } from '../drive/route.js';
import type { Progress } from '../drive/guidance.js';
import { formatDistance } from '../drive/format.js';

/** The turn arrow, drawn in a 48-unit box and rotated for the direction of the turn. */
export function ManeuverArrow({ maneuver }: { maneuver: Parameters<typeof arrowFor>[0] }) {
  const { shape, angle } = arrowFor(maneuver);
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg className="maneuver__arrow" viewBox="0 0 48 48" aria-hidden>
      {shape === 'arrow' && <path d="M24 5 38 21H29V43H19V21H10Z" fill="currentColor" transform={`rotate(${angle} 24 24)`} />}
      {shape === 'uturn' && <g {...line}><path d="M13 43V20a10 10 0 0 1 20 0v11" /><path d="m26 25 7 8 7-8" /></g>}
      {shape === 'roundabout' && (
        <g {...line}>
          <circle cx="24" cy="29" r="9" />
          <path d="M24 46v-8" />
          <g transform={`rotate(${angle} 24 29)`}><path d="M24 20V6M17 13l7-8 7 8" /></g>
        </g>
      )}
      {shape === 'arrive' && (
        <g>
          <path d="M24 3a14 14 0 0 0-14 14c0 10.5 14 27 14 27s14-16.5 14-27A14 14 0 0 0 24 3z" fill="currentColor" />
          <circle cx="24" cy="17" r="5.5" fill="var(--bg)" />
        </g>
      )}
    </svg>
  );
}

/**
 * The next turn at arm's length: how far, what to do, and the one after.
 * `rerouting` replaces it while a new route is being found.
 */
export function ManeuverBanner({ route, progress, rerouting }: { route: NavRoute; progress: Progress; rerouting: boolean }) {
  const next = progress.nextIndex >= 0 ? route.steps[progress.nextIndex] : null;
  const then = progress.nextIndex >= 0 ? route.steps[progress.nextIndex + 1] : undefined;
  if (rerouting) return <div className="maneuver maneuver--busy" role="status"><span className="maneuver__text">Rerouting…</span></div>;
  if (!next) return null;
  return (
    <div className="maneuver" role="status" aria-live="off">
      <div className="maneuver__main">
        <ManeuverArrow maneuver={next.maneuver} />
        <div className="maneuver__words">
          <span className="maneuver__dist">{formatDistance(progress.toNextM)}</span>
          <span className="maneuver__text">{next.text}</span>
        </div>
      </div>
      {then && next.maneuver.type !== 'arrive' && (
        <div className="maneuver__then">
          Then <ManeuverArrow maneuver={then.maneuver} /> <span>{then.text}</span>
          {next.distanceM > 0 && <span className="maneuver__thenDist"> in {formatDistance(next.distanceM)}</span>}
        </div>
      )}
    </div>
  );
}
