import { useState } from 'react';
import { api, type GeocodeResult } from '../api.js';

/** Where to? A search box over the geocoder; picking a result hands it up. */
export default function DriveSearch({ onPick, onClose }: { onPick: (r: GeocodeResult) => void; onClose?: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function search() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    try { setResults(await api.geocode(q)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="drivesearch" onSubmit={(e) => { e.preventDefault(); void search(); }}>
      <div className="drivesearch__row">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Where to? Address or place" autoFocus enterKeyHint="search" aria-label="Destination" />
        <button type="submit" className="primary" disabled={busy || !query.trim()}>{busy ? '…' : 'Search'}</button>
        {onClose && <button type="button" className="iconbtn iconbtn--ghost" onClick={onClose} aria-label="Close search">✕</button>}
      </div>
      {error && <p className="status-line error">{error}</p>}
      {results && (
        <ul className="drivesearch__results">
          {results.length === 0 && <li className="hint">No matches. Try a suburb or a street and town.</li>}
          {results.map((r) => (
            <li key={`${r.lat},${r.lng}`}><button type="button" onClick={() => onPick(r)}>{r.displayName}</button></li>
          ))}
        </ul>
      )}
      {!results && <p className="hint">Or tap the map to choose a place.</p>}
    </form>
  );
}
