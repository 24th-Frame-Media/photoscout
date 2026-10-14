import { useEffect, useState } from 'react';
import { api, EventTopic } from './api.js';
import { api as appApi, Area, Settings as AppSettings } from '../../api.js';
import { ListArea, LINE_BREAK, SaveBar, SetUpNotice, useEventSettings } from './shared.js';

/** Events: where to look, what to look for, and what to keep out of sight. */
export default function General() {
  const s = useEventSettings();
  const { draft, set } = s;
  const [topics, setTopics] = useState<EventTopic[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [app, setApp] = useState<Pick<AppSettings, 'home' | 'areas'> | null>(null);
  const [appDirty, setAppDirty] = useState(false);
  const [appError, setAppError] = useState('');
  const [scope, setScope] = useState('');

  useEffect(() => {
    api.topics().then((r) => { setTopics(r.topics); setCategories(r.categories ?? []); }).catch(() => setTopics([]));
  }, []);
  useEffect(() => { appApi.settings().then((a) => setApp({ home: a.home, areas: a.areas })).catch(() => undefined); }, []);

  if (s.notSetUp) return <SetUpNotice />;
  if (!draft) return s.error ? <p className="status-line error">{s.error}</p> : <p className="hint">Loading…</p>;

  // Areas with events on, in the app's order: home first.
  const here = app ? [app.home, ...app.areas].filter((a) => a.events) : [];
  const area = here.find((a) => a.name === scope) ?? null;
  const picked = area ? area.topics ?? [] : draft.eventTopics ?? [];
  const hidden = area ? area.hiddenCategories ?? [] : draft.excludedCategories ?? [];
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const setArea = (patch: Partial<Area>) => {
    if (!app || !area) return;
    const edit = (a: Area) => (a === area ? { ...a, ...patch } : a);
    setApp({ home: edit(app.home), areas: app.areas.map(edit) });
    setAppDirty(true);
  };
  const setPicked = (list: string[]) => (area ? setArea({ topics: list }) : set({ eventTopics: list }));
  const setHidden = (list: string[]) => (area ? setArea({ hiddenCategories: list }) : set({ excludedCategories: list }));
  // Area choices are app settings: saved first, so the engine settings saved after pick them up.
  const save = async (refreshAfter = false) => {
    if (app && appDirty) {
      try { await appApi.saveSettings({ home: app.home, areas: app.areas }); setAppDirty(false); }
      catch (err) { setAppError((err as Error).message); return; }
    }
    setAppError('');
    await s.save(refreshAfter);
  };
  return (
    <>
      <section>
        <h2>📍 Where</h2>
        <p className="hint">
          Events are searched in every area with Events switched on. Areas are set once, for the whole
          app, under <a href="#areas">Settings → Areas</a>.
        </p>
        {draft.lat != null
          ? (
            <ul className="hint" style={{ margin: '0 0 6px' }}>
              <li>{draft.city}, {draft.radiusKm} km</li>
              {(draft.eventAreas ?? []).map((a) => <li key={a.name}>{a.name}{a.radiusKm ? `, ${a.radiusKm} km` : ''}</li>)}
            </ul>
          )
          : <p className="status-line error">No area has Events switched on, so nothing is searched.</p>}

        <label className="toggle" style={{ display: 'flex', marginTop: 12 }}>
          <input type="checkbox" checked={draft.cullOutsideAreas === true} onChange={(e) => set({ cullOutsideAreas: e.target.checked })} />{' '}
          Hide events outside these areas automatically
        </label>
        <p className="hint" style={{ margin: '4px 0 0' }}>
          Anything more than half as far again as an area's radius from every area is kept out of
          sight — including what an area you have since removed brought in. Nothing is deleted:
          add the area back and its events return. An event nothing can place is hidden too,
          unless its title names an area, it came from one of your calendar feeds, or its site
          lists almost nothing but local events. Starred events and ones you added from a link
          are never hidden this way.
        </p>

        <h4 style={{ margin: '16px 0 4px', fontSize: 13 }}>What to look for</h4>
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Pick topics and categories for everywhere, or for one area. An area with no topics of its
          own searches for everywhere's. Each topic expands to search phrases that rotate across
          refreshes, so a few is plenty. Your own terms under Sources still apply on top.
        </p>
        {here.length > 0 && (
          <div className="chiprow" role="tablist" aria-label="Which area" style={{ marginBottom: 10 }}>
            <button role="tab" aria-selected={scope === ''} className={`chip ${scope === '' ? 'active' : ''}`} onClick={() => setScope('')}>Everywhere</button>
            {here.map((a) => (
              <button key={a.name} role="tab" aria-selected={scope === a.name} className={`chip ${scope === a.name ? 'active' : ''}`} onClick={() => setScope(a.name)}>
                {a.name}{(a.topics?.length || a.hiddenCategories?.length) ? ' •' : ''}
              </button>
            ))}
          </div>
        )}
        <div className="chiprow">
          {topics.map((t) => {
            const on = picked.includes(t.key);
            return (
              <button key={t.key} className={`chip ${on ? 'active' : ''}`} title={t.terms.join(' · ')}
                onClick={() => setPicked(toggle(picked, t.key))}>
                {t.label}
              </button>
            );
          })}
        </div>
        {area && !area.topics?.length && <p className="hint" style={{ marginTop: 8 }}>None picked: {area.name} searches for everywhere's topics.</p>}
        {categories.length > 0 && (
          <>
            <h4 style={{ margin: '16px 0 4px', fontSize: 13 }}>Categories to hide{area ? ` in ${area.name}` : ''}</h4>
            <p className="hint" style={{ margin: '0 0 8px' }}>
              {area
                ? <>Events found in {area.name} under these are kept out of sight, on top of what is hidden everywhere.</>
                : <>Events filed under these are kept out of sight, wherever they are.</>}
              {' '}Undone by switching the category back on; a category you set on an event by hand is left alone.
            </p>
            <div className="chiprow">
              {categories.map((c) => {
                const everywhere = area != null && (draft.excludedCategories ?? []).includes(c);
                const off = everywhere || hidden.includes(c);
                return (
                  <button key={c} className={`chip ${off ? 'evs-chip-off' : ''}`} disabled={everywhere}
                    title={everywhere ? `${c} is hidden everywhere` : off ? `Hidden. Click to show ${c} again.` : `Click to hide ${c}`}
                    onClick={() => setHidden(toggle(hidden, c))}>
                    {off ? '⊘ ' : ''}{c}
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div className="formrow" style={{ marginTop: 10 }}>
          <label>Refresh events every</label>
          <input type="number" min={60} max={10080} step={60} style={{ maxWidth: 90 }}
            value={draft.eventRefreshIntervalMinutes ?? 360}
            onChange={(e) => set({ eventRefreshIntervalMinutes: Math.max(60, Number(e.target.value) || 360) })} />
          <span className="hint" style={{ margin: 0 }}>minutes</span>
        </div>
      </section>
      <SaveBar save={save} dirty={s.dirty || appDirty} saved={s.saved && !appDirty} busy={s.busy} error={appError || s.error} canRefresh={draft.lat != null} />
    </>
  );
}
