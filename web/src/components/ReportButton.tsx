import { useState } from 'react';
import { api, type ReportKind, type User } from '../api.js';

/** A small "Report" link for a signed-in visitor: asks for a reason, files it, and says what happened. */
export default function ReportButton({ user, kind, id }: { user?: User | null; kind: ReportKind; id: string }) {
  const [note, setNote] = useState('');
  if (!user) return null;
  async function send() {
    const reason = window.prompt('Why are you reporting this? (optional, 300 characters at most)');
    if (reason === null) return;
    try {
      await api.report(kind, id, reason.trim().slice(0, 300));
      setNote('Reported. Thank you.');
    } catch (err) { setNote((err as Error).message); }
  }
  return note ? <span className="hint">{note}</span> : <button type="button" className="linkbtn" onClick={() => void send()}>Report</button>;
}
