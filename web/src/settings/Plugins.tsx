import { FormEvent, useEffect, useRef, useState } from 'react';
import { pluginsApi, type PluginList, type PluginLogEntry, type PluginStatus } from './pluginsApi.js';
import {
  categoryLabel,
  iconUrl,
  newestFirst,
  originTag,
  permissionLines,
  RESTART_MESSAGE,
  rollbackLabel,
  SAFE_MODE_MESSAGE,
  servicesLine,
  statusBadge,
} from './pluginsFormat.js';
import PluginBrowse from './PluginBrowse.js';
import './plugins.css';

type View = 'installed' | 'browse' | 'manual';

/** Settings → Admin → Plugins: the installed plugins (switch on or off, update, roll back, configure, read the log, remove), browsing registries, and installing a .zip by hand. */
export default function Plugins() {
  const [list, setList] = useState<PluginList | null>(null);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('installed');

  const load = () =>
    pluginsApi
      .list()
      .then((next) => {
        setList(next);
        setLoadError('');
      })
      .catch((err: unknown) => setLoadError((err as Error).message));

  useEffect(() => {
    void load();
  }, []);

  /** A card changed one plugin: show its new state at once, then refresh the page-wide flags (restart, safe mode). */
  const changed = (status: PluginStatus) => {
    setList((cur) => (cur ? { ...cur, plugins: cur.plugins.map((p) => (p.id === status.id ? status : p)) } : cur));
    void load();
  };

  if (!list) {
    return (
      <section>
        <h2>🧩 Plugins</h2>
        {loadError ? <p className="status-line error" role="alert">{loadError}</p> : <p className="hint">Loading…</p>}
      </section>
    );
  }

  return (
    <section className="plugins">
      <h2>🧩 Plugins</h2>
      <p className="hint">
        Plugins add map layers, feeds and tools. A plugin has full access to PhotoScout, so install only the ones you trust.
      </p>
      {list.safeMode && <div className="banner plugins__banner" role="status">{SAFE_MODE_MESSAGE}</div>}
      {list.restartRecommended && <div className="banner plugins__banner" role="status">{RESTART_MESSAGE}</div>}
      {loadError && <p className="status-line error" role="alert">{loadError}</p>}

      <div className="seg plugins__views" role="group" aria-label="Which plugins to show">
        <button type="button" aria-pressed={view === 'installed'} onClick={() => setView('installed')}>
          Installed ({list.plugins.length})
        </button>
        <button type="button" aria-pressed={view === 'browse'} onClick={() => setView('browse')}>Browse</button>
        <button type="button" aria-pressed={view === 'manual'} onClick={() => setView('manual')}>Install manually</button>
      </div>

      {view === 'installed' &&
        (list.plugins.length === 0 ? (
          <p className="hint">No plugins installed yet.</p>
        ) : (
          <ul className="plugins__list">
            {list.plugins.map((plugin) => (
              <li key={plugin.id}>
                <PluginCard plugin={plugin} onChange={changed} onRemoved={() => void load()} />
              </li>
            ))}
          </ul>
        ))}

      {view === 'browse' && <PluginBrowse installed={list.plugins} onInstalled={() => void load()} />}

      {view === 'manual' && <ManualUpload onInstalled={() => void load()} />}
    </section>
  );
}

/** Install a plugin from a .zip the admin already has. Registry plugins are on the Browse tab. */
function ManualUpload({ onInstalled }: { onInstalled: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadNote, setUploadNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    setUploadError('');
    setUploadNote('');
    if (!file) {
      setUploadError('Choose a plugin .zip file first.');
      return;
    }
    setUploading(true);
    try {
      const done = await pluginsApi.upload(file);
      const running = done.status.status === 'active';
      setUploadNote(`${done.status.name} ${done.version} is installed${running ? ' and running' : ''}.`);
      if (fileInput.current) fileInput.current.value = '';
      onInstalled();
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <p className="hint">Have a plugin as a .zip file? Install it here. Plugins from a registry are on the Browse tab.</p>
      <form className="plugins__upload" onSubmit={(e) => void upload(e)}>
        <label className="plugins__file">
          <span>Plugin package (.zip)</span>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            disabled={uploading}
            onChange={() => {
              setUploadError('');
              setUploadNote('');
            }}
          />
        </label>
        <button type="submit" className="primary" disabled={uploading}>
          {uploading ? 'Installing…' : 'Upload plugin'}
        </button>
      </form>
      {uploadNote && <p className="status-line ok" role="status">{uploadNote}</p>}
      {uploadError && <p className="status-line error" role="alert">{uploadError}</p>}
    </>
  );
}

function PluginCard({ plugin, onChange, onRemoved }: {
  plugin: PluginStatus;
  onChange: (next: PluginStatus) => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [keepData, setKeepData] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const badge = statusBadge(plugin);
  const tag = originTag(plugin.source);
  const permissions = permissionLines(plugin.permissions);
  const services = servicesLine(plugin.services);
  const rollback = rollbackLabel(plugin.previousVersion);
  const icon = iconUrl(plugin);
  const meta = [plugin.author, categoryLabel(plugin.category)].filter((part) => part !== '').join(' · ');

  async function run(kind: string, action: () => Promise<PluginStatus>) {
    setBusy(kind);
    setError('');
    try {
      onChange(await action());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    setBusy('remove');
    setError('');
    try {
      await pluginsApi.uninstall(plugin.id, keepData);
      onRemoved(); // the card goes away with the list; nothing is set after this
    } catch (err) {
      setError((err as Error).message);
      setBusy('');
    }
  }

  const idle = busy === '';

  return (
    <article className="plugins__card card" aria-label={plugin.name}>
      <div className="plugins__head">
        <div className="plugins__icon" aria-hidden="true">
          {icon ? <img src={icon} alt="" /> : '🧩'}
        </div>
        <div className="plugins__head-text">
          <div className="plugins__title">
            <span className="plugins__name">{plugin.name}</span>
            <span className="plugins__version">v{plugin.version}</span>
          </div>
          {meta && <p className="plugins__meta">{meta}</p>}
        </div>
        <div className="plugins__badges">
          <span className={`plugins__badge plugins__badge--${badge.tone}`}>{badge.label}</span>
          {tag && <span className="plugins__badge plugins__badge--tag" title={tag.title}>{tag.label}</span>}
        </div>
      </div>

      {plugin.description && <p className="plugins__desc">{plugin.description}</p>}

      <div>
        <span className="plugins__label">Permissions</span>
        {permissions.length > 0 ? (
          <ul className="plugins__perms">
            {permissions.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : (
          <p className="plugins__note">No special access.</p>
        )}
      </div>
      {services && <p className="plugins__note">{services}</p>}

      {plugin.status === 'error' && plugin.lastError && <p className="status-line error" role="alert">{plugin.lastError}</p>}
      {error && <p className="status-line error" role="alert">{error}</p>}

      {confirming ? (
        <div className="plugins__confirm" role="group" aria-label={`Remove ${plugin.name}`}>
          <span>Remove {plugin.name}? Its files go with it.</span>
          <label className="plugins__check">
            <input type="checkbox" checked={keepData} onChange={(e) => setKeepData(e.target.checked)} /> Keep its data
          </label>
          <button type="button" className="danger" disabled={!idle} onClick={() => void remove()}>
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
          <button type="button" disabled={!idle} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <div className="plugins__actions">
          <label className="plugins__switch">
            <input
              type="checkbox"
              role="switch"
              aria-label={`${plugin.name} is ${plugin.enabled ? 'on' : 'off'}`}
              checked={plugin.enabled}
              disabled={!idle}
              onChange={(e) => void run('toggle', () => pluginsApi.setEnabled(plugin.id, e.target.checked))}
            />
            <span className="plugins__switch-track" aria-hidden="true" />
            <span className="plugins__switch-text">{busy === 'toggle' ? 'Working…' : plugin.enabled ? 'On' : 'Off'}</span>
          </label>
          <button type="button" disabled={!idle} onClick={() => void run('reload', () => pluginsApi.reload(plugin.id))}>
            {busy === 'reload' ? 'Reloading…' : 'Reload'}
          </button>
          {rollback && (
            <button type="button" disabled={!idle} onClick={() => void run('rollback', () => pluginsApi.rollback(plugin.id))}>
              {busy === 'rollback' ? 'Rolling back…' : rollback}
            </button>
          )}
          <button type="button" disabled={!idle} onClick={() => setConfirming(true)}>Uninstall</button>
        </div>
      )}

      {plugin.settingsSchema.length > 0 && (
        <p className="plugins__note">Settings for this plugin are under <strong>{plugin.name}</strong> in the Settings menu.</p>
      )}
      <details className="plugins__details" onToggle={(e) => setLogsOpen(e.currentTarget.open)}>
        <summary>Logs</summary>
        {logsOpen && <PluginLogs id={plugin.id} name={plugin.name} />}
      </details>
    </article>
  );
}

function PluginLogs({ id, name }: { id: string; name: string }) {
  const [logs, setLogs] = useState<PluginLogEntry[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    pluginsApi
      .logs(id)
      .then((r) => {
        setLogs(r.logs);
        setError('');
      })
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [id]);

  return (
    <div>
      <div className="plugins__actions mt-2">
        <button type="button" disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <p className="status-line error" role="alert">{error}</p>}
      {logs && logs.length === 0 && <p className="hint">Nothing logged yet.</p>}
      {logs && logs.length > 0 && (
        <ul className="plugins__log-list" aria-label={`${name} log, newest first`}>
          {newestFirst(logs).map((entry, i) => (
            <li key={`${entry.at}-${i}`} className={`plugins__log plugins__log--${entry.level}`}>
              <span className="plugins__log-time">{new Date(entry.at).toLocaleString()}</span>
              <span className="plugins__log-msg">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
