/** Distances, times and spoken numbers for a driver. Pure. */

/** "350 m", "1.2 km", "14 km": rounded the way a sign would be. */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 100) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  const km = m / 1000;
  return km < 10 ? `${(Math.round(km * 10) / 10).toFixed(1)} km` : `${Math.round(km)} km`;
}

/** "12 min", "1 h 05 min". */
export function formatRemaining(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
}

/** The clock time to arrive, in the device's own style. */
export const formatEta = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A distance as it is said: "500 metres", "1 kilometre", "1.5 kilometres". */
export function spokenDistance(m: number): string {
  if (m < 1000) {
    const rounded = Math.max(50, Math.round(m / 50) * 50);
    return rounded >= 1000 ? '1 kilometre' : `${rounded} metres`;
  }
  const km = Math.round(m / 100) / 10;
  return km === 1 ? '1 kilometre' : `${km} kilometres`;
}
