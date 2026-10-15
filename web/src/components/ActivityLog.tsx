import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { activitySnapshot, clearActivity, logActivity, subscribeActivity } from '../activity.js';
import { api as engine } from '../settings/events/api.js';

/** Recent activity from the map's services. Bottom-right on the map, and floating on Settings. Pass `open` and `onOpenChange` to control the panel from outside. */
export default function ActivityLog({ admin = false, floating = false, open: openProp, onOpenChange }: {
  admin?: boolean; floating?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const entries = useSyncExternalStore(subscribeActivity, activitySnapshot, activitySnapshot);
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = (value: boolean) => { if (openProp === undefined) setOpenLocal(value); onOpenChange?.(value); };
  const [seen, setSeen] = useState(0);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const unread = entries.filter(entry => entry.id > seen).length;
  const unreadErrors = entries.some(entry => entry.id > seen && entry.level === 'error');
  useEffect(() => { if (open) setSeen(entries[0]?.id ?? 0); }, [open, entries]);
  useEffect(() => {
    if (!open || !admin) return;
    let stopped = false;
    let active: AbortController | null = null;
    const update = () => {
      if (document.hidden || active) return;
      const controller = active = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const jobs: Promise<void>[] = [];
      jobs.push(engine.crawlerStatus(controller.signal).then(status => {
        if (!stopped) logActivity('Crawler', !status.reachable ? 'Unavailable right now' : status.enabled === false ? 'Disabled in Settings' : status.running ? `Reading web pages for events; ${status.current?.fetched ?? 0} pages so far this run` : 'Idle; next run is scheduled', !status.reachable ? 'error' : 'info');
      }).catch(() => { if (!stopped) logActivity('Crawler', 'Status unavailable', 'error'); }));
      jobs.push(engine.densityStatus(controller.signal).then(status => {
        if (!stopped) logActivity('Busy places', !status.enabled ? 'Disabled in Settings' : status.running ? 'Checking how busy places are…' : 'Idle; next check is scheduled');
      }).catch(() => { if (!stopped) logActivity('Busy places', 'Status unavailable', 'error'); }));
      jobs.push(engine.status(controller.signal).then(status => {
        if (stopped) return;
        logActivity('Events', status.refreshing ? `Refreshing event sources; ${status.progress?.found ?? 0} events found so far` : 'Not refreshing right now');
        for (const source of status.sources) logActivity(source.label,
          { ok: `${source.count} events available`, disabled: 'Disabled in Settings', missing_config: 'Needs setup in Settings', error: 'Source unavailable', never_run: 'Waiting for its first refresh' }[source.state],
          source.state === 'error' ? 'error' : source.state === 'missing_config' ? 'warning' : source.state === 'ok' ? 'success' : 'info');
      }).catch(() => { if (!stopped) logActivity('Events', 'Status unavailable', 'error'); }));
      jobs.push(engine.tasks(0, controller.signal).then(({ tasks }) => {
        if (stopped) return;
        for (const task of tasks) logActivity(task.label,
          !task.enabled ? 'Disabled in Settings' : task.running ? 'Running…' : task.blockedBy ? 'Waiting for another job to finish' : task.lastOk === false ? 'Last run failed; see Tasks in Settings' : task.manualOnly ? 'Idle; runs when requested' : 'Idle; waiting for its next scheduled run',
          task.enabled && task.lastOk === false && !task.running ? 'error' : 'info');
      }).catch(() => { if (!stopped) logActivity('Scheduled tasks', 'Status unavailable', 'error'); }));
      void Promise.allSettled(jobs).finally(() => { clearTimeout(timeout); if (active === controller) active = null; });
    };
    update();
    const interval = setInterval(update, 30000);
    return () => { stopped = true; active?.abort(); clearInterval(interval); };
  }, [open, admin]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const visible = issuesOnly ? entries.filter(entry => entry.level === 'error' || entry.level === 'warning') : entries;
  return <div className={`activitylog${open ? ' activitylog--open' : ''}${floating ? ' activitylog--floating' : ''}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    {open && <section id={id} className="activitylog__panel" aria-label="Activity">
      <header><strong>Activity</strong><button className="activitylog__close" onClick={close} aria-label="Close activity">×</button></header>
      <div className="activitylog__tools">
        <label><input type="checkbox" checked={issuesOnly} onChange={event => setIssuesOnly(event.target.checked)} /> Issues only</label>
        <button onClick={clearActivity} disabled={!entries.length}>Clear list</button>
      </div>
      <ol>{visible.map(entry => <li key={entry.id} className={`activitylog__entry activitylog__entry--${entry.level}`}>
        <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        <div><strong>{entry.service}</strong><p>{entry.message}{entry.repeats > 1 && <span className="activitylog__repeat"> · {entry.repeats} updates</span>}</p></div>
      </li>)}</ol>
      {!visible.length && <p className="activitylog__empty">{issuesOnly ? 'No warnings or errors so far.' : 'Nothing yet. Problems, first loads and slow requests appear here.'}</p>}
    </section>}
    <button ref={button} className={`chip activitylog__toggle${open ? ' active' : ''}${unreadErrors && !open ? ' activitylog__toggle--issues' : ''}`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      {unreadErrors && !open && <span className="activitylog__warn" aria-hidden="true">⚠</span>}
      <span>Activity</span>
      {unread > 0 && !open && <>
        <span className="mapmenu__count" aria-hidden="true">{unread}</span>
        <span className="activitylog__sr">{unread} new {unread === 1 ? 'update' : 'updates'}{unreadErrors ? ', including errors' : ''}</span>
      </>}
      {!open && entries[0] && <span className="activitylog__preview">{entries[0].service}: {entries[0].message}</span>}
    </button>
    <span className="activitylog__announcement" role="status">{entries[0] ? `${entries[0].service}: ${entries[0].message}` : ''}</span>
  </div>;
}
