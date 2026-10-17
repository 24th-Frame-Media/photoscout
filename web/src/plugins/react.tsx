import { Component, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import { logActivity } from '../activity.js';
import type { Category } from '../map/legend.js';
import type { SidePanelProps, ViewSpec } from './api.js';
import { pluginRegistry, type LegendItem, type PluginRegistry, type RegistrySnapshot } from './registry.js';

/** The registry's snapshot, re-rendering when a plugin contributes or a toggle flips. */
export function usePluginRegistry(registry: PluginRegistry = pluginRegistry): RegistrySnapshot {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

/** A plugin legend entry as the core `Category` shape, so the Legend and the toolbar draw it like any other row. */
export function legendCategory(item: LegendItem): Category {
  return {
    key: item.globalKey,
    label: item.label,
    group: 'Overlays',
    swatch: item.swatch.kind,
    glyph: item.swatch.glyph,
    color: item.swatch.color,
    defaultOn: item.defaultOn,
    // Plugin layers are tied to the toggle by the ids in LegendEntryDef.layers, not by the style-wide matcher.
    match: () => false,
  };
}

function report(pluginId: string, what: string, err: unknown): void {
  console.error(`[plugin:${pluginId}] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  logActivity('Plugins', 'A plugin panel failed to draw; it has been hidden', 'error');
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The previous object while the new one has the same fields, so a view re-renders only when its props really changed. */
function useStableProps<P extends object>(props: P): P {
  const last = useRef(props);
  if (!shallowEqual(last.current, props)) last.current = props;
  return last.current;
}

/** A thrown render must take down the plugin's slot, not the page. */
class Boundary extends Component<{ pluginId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: Error, _info: ErrorInfo) { report(this.props.pluginId, 'render', err); }
  render() { return this.state.failed ? <p className="hint">This plugin panel failed to load.</p> : this.props.children; }
}

function RenderView<P extends object>({ pluginId, render, props, className }: { pluginId: string; render: (el: HTMLElement, props: P) => void | (() => void); props: P; className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const stable = useStableProps(props);
  useEffect(() => {
    const host = el.current;
    if (!host) return;
    let cleanup: void | (() => void);
    try {
      cleanup = render(host, stable);
    } catch (err) {
      report(pluginId, 'render', err);
      host.textContent = 'This plugin panel failed to load.';
    }
    return () => {
      try { if (typeof cleanup === 'function') cleanup(); } catch (err) { report(pluginId, 'render cleanup', err); }
    };
  }, [pluginId, render, stable]);
  return <div ref={el} className={className} />;
}

/** Fills one slot with a plugin's view: a render function into a div, or a component under an error boundary. */
export function PluginView<P extends object>({ pluginId, view, props, className }: { pluginId: string; view: ViewSpec<P>; props: P; className?: string }) {
  if (view.render) return <RenderView pluginId={pluginId} render={view.render} props={props} className={className} />;
  const Comp = view.component;
  return <Boundary pluginId={pluginId}><div className={className}><Comp {...props} /></div></Boundary>;
}

/** Plugin widgets for the map's bottom-right corner, each shown while its legend entry is on. */
export function PluginCornerPanels() {
  const snap = usePluginRegistry();
  const on = useMemo(() => new Set(snap.legend.filter((l) => l.on).map((l) => l.globalKey)), [snap.legend]);
  const none = useMemo<Record<string, never>>(() => ({}), []);
  return (
    <>
      {snap.cornerPanels.filter((c) => c.whileOn === null || on.has(c.whileOn)).map((c) => (
        <PluginView key={c.id} pluginId={c.pluginId} view={c.view} props={none} className="plugincorner" />
      ))}
    </>
  );
}

/** The open plugin side panel inside the host's frame (grab handle, close button), or nothing. */
export function PluginSidePanel({ sheetSize, onToggleSheet }: { sheetSize: 'peek' | 'half'; onToggleSheet: () => void }) {
  const open = usePluginRegistry().openSidePanel;
  // The page passes a new callback every render; the view gets a stable one.
  const toggleRef = useRef(onToggleSheet);
  toggleRef.current = onToggleSheet;
  const toggleSize = useCallback(() => toggleRef.current(), []);
  const close = useCallback(() => pluginRegistry.closeSidePanels(), []);
  const props = useMemo<SidePanelProps<unknown> | null>(
    () => (open ? { data: open.data, close, size: sheetSize, toggleSize } : null),
    [open?.data, open?.id, close, sheetSize, toggleSize], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!open || !props) return null;
  return (
    <aside className={`panel panel--${sheetSize} pluginpanel`} role="region" aria-label={open.label}>
      <button type="button" className="panel__handle" aria-label={sheetSize === 'half' ? 'Collapse panel' : 'Expand panel'} aria-expanded={sheetSize === 'half'} onClick={onToggleSheet}>
        <span className="panel__grab" aria-hidden="true" />
      </button>
      <button type="button" className="panel__close" onClick={close} title="Close" aria-label="Close">✕</button>
      <PluginView key={open.id} pluginId={open.pluginId} view={open.view} props={props} />
    </aside>
  );
}
