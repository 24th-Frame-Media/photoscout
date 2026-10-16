/**
 * The Settings sections, grouped as the side menu shows them. Kept apart from
 * the page so the mapping from an address-bar hash to a tab can be tested.
 *
 * The core tabs are listed here. Plugin tabs (web/src/plugins) are merged in at
 * render time with `groupsWith`; their ids are `<pluginId>:<tabId>`.
 */

export type CoreTab = 'areas' | 'account' | 'instance' | 'events' | 'sources' | 'crawler' | 'density' | 'venues' | 'busy' | 'conditions' | 'model' | 'notify' | 'feeds' | 'waze' | 'tasks' | 'users' | 'signin' | 'plugins';
/** A core tab id, or a plugin's `<pluginId>:<tabId>`. */
export type Tab = string;
export interface TabDef { id: Tab; label: string; admin?: boolean }
export interface TabGroup { label: string; tabs: TabDef[] }

export const GROUPS: TabGroup[] = [
  { label: 'You', tabs: [{ id: 'account', label: 'Account' }] },
  { label: 'Map', tabs: [{ id: 'areas', label: 'Areas' }, { id: 'feeds', label: 'Trains' }, { id: 'waze', label: 'Police & hazards' }] },
  { label: 'Events', tabs: [
    { id: 'events', label: 'Events', admin: true }, { id: 'sources', label: 'Sources', admin: true }, { id: 'crawler', label: 'Crawler', admin: true },
    { id: 'notify', label: 'Notifications', admin: true }, { id: 'model', label: 'AI models', admin: true },
  ] },
  { label: 'Busy places', tabs: [
    { id: 'density', label: 'Density', admin: true }, { id: 'venues', label: 'Venues', admin: true },
    { id: 'busy', label: 'Busy map', admin: true }, { id: 'conditions', label: 'Conditions', admin: true },
  ] },
  { label: 'Admin', tabs: [
    { id: 'instance', label: 'Instance', admin: true }, { id: 'signin', label: 'Sign-in', admin: true }, { id: 'plugins', label: 'Plugins', admin: true },
    { id: 'tasks', label: 'Tasks', admin: true }, { id: 'users', label: 'Users', admin: true },
  ] },
];
const TABS = GROUPS.flatMap((g) => g.tabs);
/** Ids the tabs had before they were grouped, so old links still land. */
const ALIASES: Record<string, Tab> = { home: 'areas', places: 'venues' };

/** What a plugin tab needs to appear in the menu. */
export interface PluginTabRef { id: Tab; label: string; group: 'Map' | 'Events' | 'Plugins'; admin: boolean }

/**
 * The core groups with plugin tabs added: a 'Map' or 'Events' tab joins that
 * group (after the core tabs); 'Plugins' tabs get a group of their own just above Admin.
 */
export function groupsWith(pluginTabs: readonly PluginTabRef[]): TabGroup[] {
  if (pluginTabs.length === 0) return GROUPS;
  const defs = (group: PluginTabRef['group']): TabDef[] => pluginTabs.filter((t) => t.group === group).map((t) => ({ id: t.id, label: t.label, admin: t.admin }));
  const merged = GROUPS.map((g) => (g.label === 'Map' || g.label === 'Events' ? { ...g, tabs: [...g.tabs, ...defs(g.label)] } : g));
  const own = defs('Plugins');
  if (own.length === 0) return merged;
  const at = merged.findIndex((g) => g.label === 'Admin');
  return [...merged.slice(0, at), { label: 'Plugins', tabs: own }, ...merged.slice(at)];
}

/** A hash that names a plugin tab (`#<pluginId>:<tabId>`), whether or not that plugin has loaded yet. */
export function isPluginTabHash(hash: string): boolean {
  return /^#?[a-z0-9]+(\.[a-z0-9-]+)+:[a-z0-9][a-z0-9-]*$/.test(hash);
}

/** `pluginTabIds`: the ids of the plugin tabs that exist right now. */
export function tabFromHash(hash: string, pluginTabIds: readonly string[] = []): Tab {
  const h = hash.replace(/^#/, '');
  const id = ALIASES[h] ?? h;
  return TABS.some((t) => t.id === id) || pluginTabIds.includes(id) ? id : 'areas';
}
