import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Invite } from '../api.js';
import { decodeEntities } from '../events.js';
import Modal from './Modal.js';

/** Where an invite's event lives in this app. */
export function invitePath(inv: Pick<Invite, 'kind' | 'ref'>): string {
  return inv.kind === 'community' ? `/events/c/${encodeURIComponent(inv.ref)}` : `/events/${encodeURIComponent(inv.ref)}`;
}

/** When the invited event starts, as the viewer's own clock reads it; empty if the server sent no usable date. */
export function inviteWhen(startsAt: string | null | undefined): string {
  const at = new Date(startsAt ?? '');
  if (Number.isNaN(at.getTime())) return '';
  return `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * The "Invites" button for the Events header, with a badge of how many are waiting, and the list it opens.
 * Accepting marks you as going and opens the event; dismissing just clears it.
 */
export default function InvitesButton({ onChanged }: { onChanged?: () => void }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => api.invites()
    .then((r) => { setInvites(r.invites); setPending(r.pendingCount); setError(''); })
    .catch((err) => setError((err as Error).message))
    .finally(() => setLoading(false)), []);

  useEffect(() => {
    void load();
    // Somebody may invite you while the page is open; a slow poll is enough to show the badge.
    const id = setInterval(() => void load(), 90_000);
    return () => clearInterval(id);
  }, [load]);

  async function accept(inv: Invite) {
    setBusy(inv.id);
    setError('');
    try {
      await api.acceptInvite(inv.id);
      setInvites((l) => l.filter((i) => i.id !== inv.id));
      setPending((n) => Math.max(0, n - 1));
      setOpen(false);
      onChanged?.();
      navigate(invitePath(inv), { state: { modal: true } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(inv: Invite) {
    setBusy(inv.id);
    setError('');
    try {
      await api.dismissInvite(inv.id);
      setInvites((l) => l.filter((i) => i.id !== inv.id));
      setPending((n) => Math.max(0, n - 1));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        type="button"
        className="invitesbtn"
        onClick={() => { setOpen(true); void load(); }}
        aria-haspopup="dialog"
        aria-label={pending > 0 ? `Invites, ${pending} waiting` : 'Invites'}
      >
        <span aria-hidden="true">✉</span> Invites
        {pending > 0 && <span className="invitesbtn__badge" aria-hidden="true">{pending > 99 ? '99+' : pending}</span>}
      </button>
      {open && (
        <Modal label="Invites" size="small" onClose={() => setOpen(false)}>
          <div className="inbox">
            <h2>Invites</h2>
            {error && <p className="status-line error" role="alert">{error}</p>}
            {loading && invites.length === 0 && <div className="skel skel--row" aria-label="Loading invites" />}
            {!loading && invites.length === 0 && !error && (
              <p className="hint">No invites waiting. When somebody asks you to an event, it shows up here.</p>
            )}
            <ul className="inbox__list">
              {invites.map((inv) => {
                const when = inviteWhen(inv.event?.startsAt);
                return (
                  <li key={inv.id} className="inbox__item">
                    {inv.event?.imageUrl
                      ? <img className="inbox__img" src={inv.event.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      : <span className="inbox__img inbox__img--none" aria-hidden="true">📷</span>}
                    <div className="inbox__body">
                      <p className="inbox__from"><strong>{inv.from.username}</strong> invited you</p>
                      <p className="inbox__title">{inv.event ? decodeEntities(inv.event.title) : 'An event that is no longer listed'}</p>
                      {(when || inv.event?.venue) && (
                        <p className="hint">{[when, inv.event?.venue && decodeEntities(inv.event.venue)].filter(Boolean).join(' · ')}</p>
                      )}
                      <div className="inbox__actions">
                        <button type="button" className="primary" disabled={busy === inv.id || !inv.event} onClick={() => void accept(inv)}>Accept</button>
                        <button type="button" disabled={busy === inv.id} onClick={() => void dismiss(inv)}>Dismiss</button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </Modal>
      )}
    </>
  );
}
