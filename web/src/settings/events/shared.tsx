import { useCallback, useEffect, useRef, useState } from 'react';
import { api, NotSetUp, Settings as SettingsType, SourceStatus } from './api.js';

/** Newline, as a constant so the textarea handlers stay readable. */
export const LINE_BREAK = String.fromCharCode(10);

export const isNotSetUp = (err: unknown): boolean => err instanceof NotSetUp;

/** The one line shown when the proxy has nowhere to send things. */
export function SetUpNotice() {
  return <section><p className="hint">Set the events service URL under Instance first.</p></section>;
}

/**
 * The events service's settings for one tab: loaded when the tab opens, edited
 * as a draft, saved with the Save bar. Each tab owns its copy, so opening a tab
 * always starts from what the service has now.
 */
export function useEventSettings() {
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [notSetUp, setNotSetUp] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.settings()
      .then((s) => { if (alive) setDraft(s); })
      .catch((err) => { if (!alive) return; if (isNotSetUp(err)) setNotSetUp(true); else setError((err as Error).message); });
    api.status().then((s) => { if (alive) setSources(s.sources); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const set = useCallback((patch: Partial<SettingsType>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaved(false);
    setDirty(true);
  }, []);

  const save = useCallback(async (refreshAfter = false) => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      setDraft(await api.saveSettings(draft));
      setSaved(true);
      setDirty(false);
      if (refreshAfter) {
        const res = await api.refresh();
        setSources(res.sources);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  return { draft, set, save, dirty, saved, busy, error, notSetUp, sources, statusFor: (name: string) => sources.find((s) => s.name === name) };
}

export function SaveBar({ save, dirty, saved, busy, error, canRefresh = true }: {
  save: (refreshAfter?: boolean) => Promise<void>; dirty: boolean; saved: boolean; busy: boolean; error: string; canRefresh?: boolean;
}) {
  return (
    <div className="savebar">
      <button className="primary" onClick={() => void save()} disabled={busy || !dirty}>Save settings</button>
      {canRefresh && <button onClick={() => void save(true)} disabled={busy}>{busy ? 'Working…' : 'Save & refresh now'}</button>}
      <span className="note">{error ? <span className="status-line error">{error}</span> : saved ? '✓ Saved' : dirty ? 'Unsaved changes.' : ''}</span>
    </div>
  );
}

export function StatusLine({ status }: { status: SourceStatus | undefined }) {
  if (!status) return null;
  const icon =
    status.state === 'ok' ? '●' : status.state === 'error' ? '✕' : status.state === 'missing_config' ? '!' : '○';
  return (
    <div className={`status-line ${status.state}`}>
      {icon} {status.message}
      {status.lastFetch && ` (${new Date(status.lastFetch).toLocaleString()})`}
    </div>
  );
}

/**
 * An input for a credential the server will not read back.
 *
 * The box is always empty on arrival, whatever is stored, so there is nothing
 * to show and nothing to leak. What it can say is whether one exists, and a
 * blank box means "leave it alone", so it has its own way to say "remove it".
 */
export function SecretField({
  label, value, isSet, placeholder, onChange,
}: {
  label: string; value: string | null; isSet: boolean; placeholder?: string; onChange: (next: string | null) => void;
}) {
  const cleared = value === null;
  return (
    <>
      <div className="formrow">
        <label>{label}</label>
        <input
          value={value ?? ''}
          placeholder={isSet && !cleared ? 'stored — type to replace' : placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {(isSet || cleared) && (
        <p className="hint" style={{ marginTop: -4 }}>
          {cleared ? (
            <>Will be removed when you save.{' '}<button className="linkbtn linkbtn--blue" onClick={() => onChange('')}>Keep it</button></>
          ) : (
            <>One is stored. Leave the box empty to keep it.{' '}<button className="linkbtn linkbtn--blue" onClick={() => onChange(null)}>Remove</button></>
          )}
        </p>
      )}
    </>
  );
}

/**
 * A textarea for the fields that hold a list.
 *
 * The text is the edit state and the parsed value is derived from it, so
 * parsing on every keystroke can't eat what is being typed. An outside change
 * is adopted only while the field is not focused.
 */
export function ListArea({
  text, onText, rows = 3, placeholder,
}: {
  text: string; onText: (raw: string) => void; rows?: number; placeholder?: string;
}) {
  const [draft, setDraft] = useState(text);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(text); }, [text]);
  return (
    <textarea
      rows={rows}
      placeholder={placeholder}
      value={draft}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setDraft(text); }}
      onChange={(e) => { setDraft(e.target.value); onText(e.target.value); }}
    />
  );
}

/** A destructive button that asks first. */
export function ConfirmButton({
  label, question, confirmLabel, onConfirm,
}: {
  label: string; question: string; confirmLabel: string; onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className="ghost" onClick={() => setAsking(true)}>{label}</button>;
  return (
    <div className="evs-confirm">
      <span>{question}</span>
      <button className="danger" onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button onClick={() => setAsking(false)}>Cancel</button>
    </div>
  );
}
