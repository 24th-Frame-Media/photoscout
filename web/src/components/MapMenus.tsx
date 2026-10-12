import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  swatch?: ReactNode;
  /** Toggle state; omit for a plain action item. */
  on?: boolean;
  title?: string;
  onSelect: () => void;
}
export interface Menu { label: string; items: MenuItem[] }

/** Category pills for the map toolbar; each opens one dropdown of layer toggles or actions. */
export function MapMenus({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pills = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      pills.current.get(open)?.focus();
      setOpen(null);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="mapmenus" ref={root}>
      {menus.map((m) => {
        const count = m.items.filter((i) => i.on).length;
        const isOpen = open === m.label;
        return (
          <div className="mapmenu" key={m.label}>
            <button type="button" className={`chip${count ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={isOpen}
              ref={(el) => { if (el) pills.current.set(m.label, el); }} onClick={() => setOpen(isOpen ? null : m.label)}>
              {m.label}{count > 0 && <span className="mapmenu__count">{count}</span>}<span className="mapmenu__caret" aria-hidden>▾</span>
            </button>
            {isOpen && (
              <div className="mapmenu__list" role="menu" aria-label={m.label}>
                {m.items.map((i) => {
                  const toggle = i.on !== undefined;
                  return (
                    <button type="button" key={i.key} className={`mapmenu__item${i.on ? ' mapmenu__item--on' : ''}`} title={i.title}
                      aria-label={i.label}
                      role={toggle ? 'menuitemcheckbox' : 'menuitem'} aria-checked={toggle ? i.on : undefined}
                      onClick={() => { i.onSelect(); if (!toggle) setOpen(null); }}>
                      <span className="mapmenu__sw">{i.swatch}</span>
                      <span className="grow">{i.label}</span>
                      {toggle && <span className="mapmenu__check" aria-hidden>{i.on ? '✓' : ''}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
