import { useEffect, useState } from 'react';
import { api } from './events/api.js';
import type { EventTopic } from './events/types.js';
import type { Area } from '../api.js';

/** One area's own topics and hidden categories, behind a "Categories…" toggle. */
export default function AreaCategories({ area, onChange }: { area: Area; onChange: (patch: Partial<Area>) => void }) {
  const [open, setOpen] = useState(false);
  const [topics, setTopics] = useState<EventTopic[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    if (!open || topics.length > 0) return;
    api.topics().then((r) => { setTopics(r.topics); setCategories(r.categories ?? []); }).catch(() => undefined);
  }, [open, topics.length]);

  const picked = area.topics ?? [];
  const hidden = area.hiddenCategories ?? [];
  const count = picked.length + hidden.length;
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  return (
    <div className="arealist__cats">
      <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
        Categories…{count > 0 ? ` (${count})` : ''}
      </button>
      {open && (
        <>
          <h4>What to look for here</h4>
          <div className="chiprow">
            {topics.map((t) => (
              <button key={t.key} type="button" className={`chip ${picked.includes(t.key) ? 'active' : ''}`} title={t.terms.join(' · ')}
                onClick={() => onChange({ topics: toggle(picked, t.key) })}>{t.label}</button>
            ))}
          </div>
          <p className="hint">None picked means this area uses the topics chosen under Events.</p>
          {categories.length > 0 && (
            <>
              <h4>Categories to hide here</h4>
              <div className="chiprow">
                {categories.map((c) => {
                  const off = hidden.includes(c);
                  return (
                    <button key={c} type="button" className={`chip ${off ? 'evs-chip-off' : ''}`}
                      title={off ? `Hidden here. Click to show ${c} again.` : `Click to hide ${c} here`}
                      onClick={() => onChange({ hiddenCategories: toggle(hidden, c) })}>{off ? '⊘ ' : ''}{c}</button>
                  );
                })}
              </div>
              <p className="hint">On top of the categories hidden everywhere under Events.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
