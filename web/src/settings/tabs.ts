/**
 * The Settings sections, grouped as the side menu shows them. Kept apart from
 * the page so the mapping from an address-bar hash to a tab can be tested.
 */

export type Tab = 'areas' | 'account' | 'instance' | 'events' | 'sources' | 'crawler' | 'density' | 'venues' | 'busy' | 'conditions' | 'model' | 'notify' | 'feeds' | 'tasks' | 'users' | 'signin';
interface TabDef { id: Tab; label: string; admin?: boolean }
export const GROUPS: { label: string; tabs: TabDef[] }[] = [
  { label: 'You', tabs: [{ id: 'account', label: 'Account' }] },
  { label: 'Map', tabs: [{ id: 'areas', label: 'Areas' }, { id: 'feeds', label: 'Trains' }] },
  { label: 'Events', tabs: [
    { id: 'events', label: 'Events', admin: true }, { id: 'sources', label: 'Sources', admin: true }, { id: 'crawler', label: 'Crawler', admin: true },
    { id: 'notify', label: 'Notifications', admin: true }, { id: 'model', label: 'Local model', admin: true },
  ] },
  { label: 'Busy places', tabs: [
    { id: 'density', label: 'Density', admin: true }, { id: 'venues', label: 'Venues', admin: true },
    { id: 'busy', label: 'Busy map', admin: true }, { id: 'conditions', label: 'Conditions', admin: true },
  ] },
  { label: 'Admin', tabs: [{ id: 'instance', label: 'Instance', admin: true }, { id: 'signin', label: 'Sign-in', admin: true }, { id: 'tasks', label: 'Tasks', admin: true }, { id: 'users', label: 'Users', admin: true }] },
];
const TABS = GROUPS.flatMap((g) => g.tabs);
/** Ids the tabs had before they were grouped, so old links still land. */
const ALIASES: Record<string, Tab> = { home: 'areas', places: 'venues' };

export function tabFromHash(hash: string): Tab {
  const h = hash.replace(/^#/, '');
  const id = ALIASES[h] ?? h;
  return TABS.some((t) => t.id === id) ? (id as Tab) : 'areas';
}
