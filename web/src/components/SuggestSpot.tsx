import { FormEvent, useState } from 'react';
import { api } from '../api.js';

/**
 * Suggest a place for the public map. It goes to the moderators, who add it as a public spot or turn it down;
 * nothing shows on the map until then, and the form says so.
 */
export default function SuggestSpot({ at, onClose }: { at: { lat: number; lng: number }; onClose: () => void }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.suggestSpot({ name: name.trim(), notes: notes.trim(), lat: at.lat, lng: at.lng });
      setSent(true);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="suggestcard" onSubmit={(e) => void submit(e)}>
      <h3>Suggest a spot</h3>
      {sent ? (
        <>
          <p className="hint">Thank you. A moderator will look at it, and it will appear on the map if they approve it.</p>
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <p className="hint">{at.lat.toFixed(5)}, {at.lng.toFixed(5)}. Moderators check suggestions before anything is shown.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of the spot" maxLength={120} required autoFocus />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why it's worth a visit, access, best light (optional)" maxLength={1000} rows={3} />
          {error && <p className="status-line error">{error}</p>}
          <div className="eventcard__actions">
            <button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? 'Sending…' : 'Send for review'}</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </form>
  );
}
