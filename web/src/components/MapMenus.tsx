import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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

function useIsMobile(breakpoint = 820): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= breakpoint;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    } else {
      mq.addListener(update);
      return () => mq.removeListener(update);
    }
  }, [breakpoint]);

  return isMobile;
}

/** Category pills for the map toolbar; each opens one dropdown of layer toggles or actions. */
export function MapMenus({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pills = useRef(new Map<string, HTMLButtonElement>());
  const isMobile = useIsMobile(820);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (isMobile) return;
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      pills.current.get(open)?.focus();
      setOpen(null);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, isMobile]);

  useEffect(() => {
    if (isMobile && open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isMobile, open]);

  const currentMenu = menus.find((m) => m.label === open);

  return (
    <div className="mapmenus" ref={root}>
      {menus.map((m) => {
        const count = m.items.filter((i) => i.on).length;
        const isOpen = open === m.label;
        return (
          <div className="mapmenu" key={m.label}>
            <button
              type="button"
              className={`chip${count ? ' active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              ref={(el) => {
                if (el) pills.current.set(m.label, el);
              }}
              onClick={() => setOpen(isOpen ? null : m.label)}
            >
              <span className="mapmenu__label">{m.label}</span>
              {count > 0 && <span className="mapmenu__count">{count}</span>}
              <svg className="mapmenu__chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true" focusable="false">
                <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
            {!isMobile && isOpen && (
              <div className="mapmenu__list" role="menu" aria-label={m.label}>
                {m.items.map((i) => {
                  const toggle = i.on !== undefined;
                  return (
                    <button
                      type="button"
                      key={i.key}
                      className={`mapmenu__item${i.on ? ' mapmenu__item--on' : ''}`}
                      title={i.title}
                      aria-label={i.label}
                      role={toggle ? 'menuitemcheckbox' : 'menuitem'}
                      aria-checked={toggle ? i.on : undefined}
                      onClick={() => {
                        i.onSelect();
                        if (!toggle) setOpen(null);
                      }}
                    >
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

      {isMobile && open && currentMenu && typeof document !== 'undefined' && createPortal(
        <div className="mapmenu-portal">
          <div
            className="mapmenu-sheet__scrim"
            onClick={() => setOpen(null)}
            aria-hidden="true"
          />
          <div
            className="mapmenu-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={currentMenu.label}
          >
            <div className="mapmenu-sheet__handle-wrap" onClick={() => setOpen(null)}>
              <div className="mapmenu-sheet__handle" />
            </div>

            <div className="mapmenu-sheet__header">
              <div className="mapmenu-sheet__tabs" role="tablist">
                {menus.map((m) => {
                  const count = m.items.filter((i) => i.on).length;
                  const isTabActive = m.label === open;
                  return (
                    <button
                      type="button"
                      key={m.label}
                      role="tab"
                      aria-selected={isTabActive}
                      className={`mapmenu-sheet__tab${isTabActive ? ' is-active' : ''}`}
                      onClick={() => setOpen(m.label)}
                    >
                      <span>{m.label}</span>
                      {count > 0 && <span className="mapmenu__count">{count}</span>}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="mapmenu-sheet__close"
                onClick={() => setOpen(null)}
                aria-label="Close"
              >
                <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="mapmenu-sheet__list" role="menu">
              {currentMenu.items.map((i) => {
                const toggle = i.on !== undefined;
                return (
                  <button
                    type="button"
                    key={i.key}
                    className={`mapmenu-sheet__item${i.on ? ' is-on' : ''}`}
                    role={toggle ? 'menuitemcheckbox' : 'menuitem'}
                    aria-checked={toggle ? i.on : undefined}
                    onClick={() => {
                      i.onSelect();
                      if (!toggle) setOpen(null);
                    }}
                  >
                    <div className="mapmenu-sheet__item-leading">
                      {i.swatch ? (
                        <span className="mapmenu__sw">{i.swatch}</span>
                      ) : (
                        <span className="mapmenu-sheet__action-glyph" aria-hidden="true">
                          {i.key === 'route' ? '↗' : i.key === 'place' ? '⬡' : '+'}
                        </span>
                      )}
                    </div>
                    <div className="mapmenu-sheet__item-body">
                      <div className="mapmenu-sheet__item-label">{i.label}</div>
                      {i.title && (
                        <div className="mapmenu-sheet__item-desc">{i.title}</div>
                      )}
                    </div>
                    <div className="mapmenu-sheet__item-trailing">
                      {toggle ? (
                        <div className={`mapmenu-sheet__toggle${i.on ? ' is-on' : ''}`} aria-hidden="true">
                          <span className="mapmenu-sheet__toggle-knob" />
                        </div>
                      ) : (
                        <svg className="mapmenu-sheet__item-chevron" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
                          <path d="M1 1L7 7L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                        </svg>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
