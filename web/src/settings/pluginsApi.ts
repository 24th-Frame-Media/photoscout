import { activityFetch as fetch } from '../activity.js';

/** Typed calls to the plugin admin API (/api/admin/plugins), as the server answers them. */

const BASE = '/api/admin/plugins';

export type PermissionKind = 'network' | 'secrets' | 'realtime' | 'llm' | 'tasks' | 'storage';
export type PluginState = 'active' | 'inactive' | 'error' | 'disabled';
export type PluginSource = 'upload' | 'dev' | 'bundled';

export interface PluginPermission {
  kind: PermissionKind;
  detail?: string;
}

export interface PluginService {
  name: string;
  image: string;
  port: number;
}

export type PluginSettingField =
  | { key: string; type: 'string' | 'secret' | 'url'; label: string; help?: string; default?: string; required?: boolean }
  | { key: string; type: 'number'; label: string; help?: string; default?: number; min?: number; max?: number; required?: boolean }
  | { key: string; type: 'boolean'; label: string; help?: string; default?: boolean; required?: boolean }
  | { key: string; type: 'select'; label: string; help?: string; default?: string; options: { value: string; label: string }[]; required?: boolean };

export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  previousVersion: string | null;
  description: string;
  author: string;
  /** A path inside the package, e.g. "icon.png", or null. */
  icon: string | null;
  category: string | null;
  enabled: boolean;
  status: PluginState;
  lastError: string;
  permissions: PluginPermission[];
  services: PluginService[];
  settingsSchema: PluginSettingField[];
  source: PluginSource;
}

export interface PluginList {
  safeMode: boolean;
  restartRecommended: boolean;
  hostApiVersion: string;
  plugins: PluginStatus[];
}

/** The stored values as the admin page may see them: secrets blank, with whether each is set. */
export interface PluginSettings {
  values: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
}

export type PluginLogLevel = 'info' | 'warn' | 'error';

export interface PluginLogEntry {
  at: string;
  level: PluginLogLevel;
  message: string;
}

export interface UploadResult {
  ok: boolean;
  id: string;
  version: string;
  status: PluginStatus;
}

/** The server's reason, as a plain Error. A refusal carries { error } in its body. */
async function read<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Something went wrong (HTTP ${res.status})`);
  }
  return res.json() as Promise<T>;
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const idPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export const pluginsApi = {
  list: () => fetch(BASE).then((r) => read<PluginList>(r)),

  /** Send a .zip package. The server checks it and starts the plugin, or says why not. */
  upload: (file: File) => {
    const form = new FormData();
    form.append('package', file, file.name);
    return fetch(`${BASE}/upload`, { method: 'POST', body: form }).then((r) => read<UploadResult>(r));
  },

  setEnabled: (id: string, enabled: boolean) =>
    fetch(`${idPath(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }).then((r) => read<PluginStatus>(r)),

  reload: (id: string) => fetch(`${idPath(id)}/reload`, { method: 'POST' }).then((r) => read<PluginStatus>(r)),

  rollback: (id: string) => fetch(`${idPath(id)}/rollback`, { method: 'POST' }).then((r) => read<PluginStatus>(r)),

  uninstall: (id: string, keepData: boolean) =>
    fetch(`${idPath(id)}${keepData ? '?keepData=1' : ''}`, { method: 'DELETE' }).then((r) => read<{ ok: boolean }>(r)),

  settings: (id: string) => fetch(`${idPath(id)}/settings`).then((r) => read<PluginSettings>(r)),

  /** Only the keys in `values` change. A secret left out keeps its stored value; null clears it. */
  saveSettings: (id: string, values: Record<string, unknown>) =>
    fetch(`${idPath(id)}/settings`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(values) }).then((r) => read<PluginSettings>(r)),

  logs: (id: string) => fetch(`${idPath(id)}/logs`).then((r) => read<{ logs: PluginLogEntry[] }>(r)),
};
