import { useEffect, useRef, type ReactNode } from 'react';

/** Everything a Tab can land on. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open modals, newest last: Escape and the focus trap belong to the top one only. */
const stack: symbol[] = [];
let lockCount = 0;
let savedOverflow = '';
let savedPadding = '';

/** Stop the page behind scrolling, without the layout jumping by the width of the scrollbar that goes. */
function lockScroll(): void {
  if (lockCount++ > 0) return;
  const body = document.body;
  savedOverflow = body.style.overflow;
  savedPadding = body.style.paddingRight;
  const bar = window.innerWidth - document.documentElement.clientWidth;
  if (bar > 0) body.style.paddingRight = `${bar}px`;
  body.style.overflow = 'hidden';
}

function unlockScroll(): void {
  if (--lockCount > 0) return;
  document.body.style.overflow = savedOverflow;
  document.body.style.paddingRight = savedPadding;
}

/**
 * A dialog over the page: a centred panel on a desktop, the whole screen on a phone (see .modal in styles.css).
 *
 * Escape, the close button and a click on the backdrop all call `onClose`. Focus moves into the panel, Tab
 * stays inside it, the page behind does not scroll, and on close focus goes back to what opened it (or to
 * `returnFocusTo`, for when that element has since been replaced).
 */
export default function Modal({ label, onClose, size = 'large', className = '', returnFocusTo, children }: {
  label: string;
  onClose: () => void;
  size?: 'large' | 'small';
  className?: string;
  returnFocusTo?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnRef = useRef(returnFocusTo);
  returnRef.current = returnFocusTo;
  // A press that starts inside the panel (selecting text) and ends on the backdrop is not a click on the backdrop.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const id = Symbol('modal');
    stack.push(id);
    lockScroll();
    panel.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) {
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current || !panel.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      unlockScroll();
      const back = opener.current instanceof HTMLElement && opener.current.isConnected && opener.current !== document.body
        ? opener.current
        : returnRef.current?.() ?? null;
      back?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className={`modal modal--${size}`}
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}
      role="presentation"
    >
      <div ref={panel} className={`modal__panel ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className="modal__bar">
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
