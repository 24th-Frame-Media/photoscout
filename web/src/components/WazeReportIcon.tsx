import { reportEmoji, reportIconType } from '../map/waze.js';
export function WazeReportIcon({ type, subType }: { type: string; subType?: string }) {
  return reportIconType({ type, subType }) === 'CAMERA'
    ? <svg className="drive__report-icon" viewBox="0 0 64 64" width="32" height="32" aria-hidden="true">
      <rect x="15" y="10" width="34" height="30" rx="5" fill="#fbbf24" stroke="white" strokeWidth="4" />
      <circle cx="32" cy="25" r="8" fill="#172b49" /><circle cx="32" cy="25" r="4" fill="#7dd3fc" />
      <path d="M32 42v14M22 56h20" stroke="white" strokeWidth="4" />
    </svg>
    : <span className="drive__report-icon" aria-hidden="true">{reportEmoji({ type })}</span>;
}
