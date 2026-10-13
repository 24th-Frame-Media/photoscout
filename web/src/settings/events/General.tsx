import { useEffect, useState } from 'react';
import { api, EventTopic } from './api.js';
import { ListArea, LINE_BREAK, SaveBar, SetUpNotice, useEventSettings } from './shared.js';

/** Events: where to look, what to look for, and what to keep out of sight. */
export default function General() {
  const s = useEventSettings();
  const { draft, set } = s;
  const [topics, setTopics] = useState<EventTopic[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    api.topics().then((r) => { setTopics(r.topics); setCategories(r.categories ?? []); }).catch(() => setTopics([]));
  }, []);

  if (s.notSetUp) return <SetUpNotice />;
  if (!draft) return s.error ? <p className="status-line error">{s.error}</p> : <p className="hint">Loading…</p>;

  const picked = draft.eventTopics ?? [];
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
          Each topic expands to a set of search phrases, run against every area. Pick a
          few rather than all: they rotate across refreshes, so everything gets covered
          either way, and fewer at once means faster passes. Your own terms under Sources
          still apply on top.
        </p>
        <div className="chiprow">
          {topics.map((t) => {
            const on = picked.includes(t.key);
            return (
              <button key={t.key} className={`chip ${on ? 'active' : ''}`} title={t.terms.join(' · ')}
                onClick={() => set({ eventTopics: on ? picked.filter((k) => k !== t.key) : [...picked, t.key] })}>
                {t.label}
              </button>
            );
          })}
        </div>
        {picked.length > 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            {picked.reduce((n, k) => n + (topics.find((t) => t.key === k)?.terms.length ?? 0), 0)}{' '}
            phrases across {Math.max(1, (draft.eventAreas ?? []).length + (draft.lat != null ? 1 : 0))} area(s)
          </p>
        )}

        {categories.length > 0 && (
          <>
            <h4 style={{ margin: '16px 0 4px', fontSize: 13 }}>Categories to hide</h4>
            <p className="hint" style={{ margin: '0 0 8px' }}>
              Events filed under these are kept out of sight, wherever they are. Undone by
              switching the category back on; a category you set on an event by hand is left alone.
            </p>
            <div className="chiprow">
              {categories.map((c) => {
                const off = (draft.excludedCategories ?? []).includes(c);
                return (
                  <button key={c} className={`chip ${off ? 'evs-chip-off' : ''}`}
                    title={off ? `Hidden. Click to show ${c} again.` : `Click to hide ${c}`}
                    onClick={() => set({ excludedCategories: off ? (draft.excludedCategories ?? []).filter((k) => k !== c) : [...(draft.excludedCategories ?? []), c] })}>
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
      <SaveBar save={s.save} dirty={s.dirty} saved={s.saved} busy={s.busy} error={s.error} canRefresh={draft.lat != null} />
    </>
  );
}
