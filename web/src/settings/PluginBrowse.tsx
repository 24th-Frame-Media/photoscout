import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { pluginsApi, type PluginStatus, type RegistryEntry, type RegistryPlugin, type RemotePreview } from './pluginsApi.js';
import { categoryLabel, registryStatus } from './pluginsFormat.js';
import PluginInstallDialog from './PluginInstallDialog.js';

/**
 * Settings → Plugins → Browse: the registries this instance reads, the plugins each one lists, and the install.
 * Install first fetches the package and shows what it asks for (PluginInstallDialog); only its Confirm installs.
 */

/** The catalog of one registry: still loading, failed, or its plugins. `url` says which registry it is for. */
type Catalog =
  | { url: string; state: 'loading' }
  | { url: string; state: 'error'; error: string }
  | { url: string; state: 'ready'; plugins: RegistryPlugin[] };

export default function PluginBrowse({ installed, onInstalled }: {
  installed: PluginStatus[];
  /** Called after an install, so the Installed list reloads. */
  onInstalled: () => void;
}) {
  const [registries, setRegistries] = useState<RegistryEntry[] | null>(null);
  const [registryError, setRegistryError] = useState('');
  const [selected, setSelected] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState('');
  const [opening, setOpening] = useState<{ registryUrl: string; preview: RemotePreview } | null>(null);
  const [actionError, setActionError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    let live = true;
    pluginsApi
      .listRegistries()
      .then(({ registries: next }) => {
        if (!live) return;
        setRegistries(next);
        setSelected(defaultUrl(next));
      })
      .catch((err: unknown) => {
        if (live) setRegistryError((err as Error).message);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (selected === '') return;
    let live = true;
    setCatalog({ url: selected, state: 'loading' });
    pluginsApi
      .browseRegistry(selected)
      .then((r) => {
        if (live) setCatalog({ url: selected, state: 'ready', plugins: r.plugins });
      })
      .catch((err: unknown) => {
        if (live) setCatalog({ url: selected, state: 'error', error: (err as Error).message });
      });
    return () => {
      live = false;
    };
  }, [selected, attempt]);

  const shown = catalog !== null && catalog.url === selected ? catalog : null;
  const busy = checking !== '';
  const installedCopy = (id: string) => installed.find((p) => p.id === id);

  async function startInstall(plugin: RegistryPlugin) {
    setChecking(plugin.id);
    setActionError('');
    setNote('');
    try {
      const preview = await pluginsApi.previewRemote(selected, plugin.id, plugin.latest);
      setOpening({ registryUrl: selected, preview });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setChecking('');
    }
  }

  function finished(status: PluginStatus, updated: boolean) {
    setOpening(null);
    if (status.status === 'error') {
      setActionError(`${status.name} ${status.version} was installed but did not start: ${status.lastError || 'unknown error'}`);
    } else {
      setNote(`${status.name} ${status.version} is ${updated ? 'updated' : 'installed'}${status.status === 'active' ? ' and running' : ''}.`);
    }
    onInstalled();
  }

  let body: ReactNode = null;
  if (selected === '') {
    body = registries === null ? null : <p className="hint">Add a registry above to browse its plugins.</p>;
  } else if (shown === null || shown.state === 'loading') {
    body = <p className="hint">Loading plugins…</p>;
  } else if (shown.state === 'error') {
    body = (
      <div className="plugins__retry">
        <p className="status-line error" role="alert">{shown.error}</p>
        <button type="button" className="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </div>
    );
  } else if (shown.plugins.length === 0) {
    body = <p className="hint">This registry lists no plugins.</p>;
  } else {
    body = (
      <ul className="plugins__list">
        {shown.plugins.map((plugin) => (
          <li key={plugin.id}>
            <BrowseCard
              plugin={plugin}
              installed={installedCopy(plugin.id)}
              checking={checking === plugin.id}
              disabled={busy}
              onInstall={() => void startInstall(plugin)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="plugins__browse">
      {registries === null ? (
        registryError ? <p className="status-line error" role="alert">{registryError}</p> : <p className="hint">Loading registries…</p>
      ) : (
        <RegistryList
          registries={registries}
          selected={selected}
          onSelect={setSelected}
          onChanged={(next, show) => {
            setRegistries(next);
            setSelected(show);
          }}
        />
      )}
      {note && <p className="status-line ok" role="status">{note}</p>}
      {actionError && <p className="status-line error" role="alert">{actionError}</p>}
      {body}
      {opening && (
        <PluginInstallDialog
          registryUrl={opening.registryUrl}
          preview={opening.preview}
          installed={installedCopy(opening.preview.id)}
          onCancel={() => setOpening(null)}
          onInstalled={finished}
        />
      )}
    </div>
  );
}

/** The registry the page starts on: the default one, else the first listed, else none. */
function defaultUrl(list: RegistryEntry[]): string {
  const first = list.find((r) => r.isDefault) ?? list[0];
  return first ? first.url : '';
}

/** The registries, the one being browsed, and the form that adds another. Errors from the server show inline. */
function RegistryList({ registries, selected, onSelect, onChanged }: {
  registries: RegistryEntry[];
  selected: string;
  onSelect: (url: string) => void;
  /** The new list, and the registry to show now. */
  onChanged: (next: RegistryEntry[], show: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = draft.trim();
    if (url === '') return;
    setBusy(true);
    setError('');
    try {
      const { registries: next } = await pluginsApi.addRegistry(url);
      const added = next.find((r) => !registries.some((old) => old.url === r.url));
      setDraft('');
      onChanged(next, added ? added.url : selected);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(url: string) {
    setBusy(true);
    setError('');
    try {
      const { registries: next } = await pluginsApi.removeRegistry(url);
      onChanged(next, url === selected ? defaultUrl(next) : selected);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="plugins__registries" aria-label="Plugin registries">
      <h3>Registries</h3>
      <p className="hint">A registry is a list of plugins. The default one comes with PhotoScout. Add others only from sources you trust.</p>
      <ul className="plugins__reg-list">
        {registries.map((r) => (
          <li key={r.url} className="plugins__reg">
            <button
              type="button"
              className="plugins__reg-pick"
              aria-pressed={r.url === selected}
              onClick={() => onSelect(r.url)}
            >
              {r.url}
            </button>
            {r.isDefault ? (
              <span className="badge">Default</span>
            ) : (
              <button type="button" className="sm" disabled={busy} aria-label={`Remove ${r.url}`} onClick={() => void remove(r.url)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="plugins__reg-add" onSubmit={(e) => void add(e)}>
        <label className="plugins__file">
          <span>Add a registry (https address)</span>
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            value={draft}
            placeholder="https://example.com/plugins/registry.json"
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setError('');
            }}
          />
        </label>
        <button type="submit" className="sm" disabled={busy || draft.trim() === ''}>
          {busy ? 'Adding…' : 'Add registry'}
        </button>
      </form>
      {error && <p className="status-line error" role="alert">{error}</p>}
    </section>
  );
}

/** One plugin a registry lists: what it is, and whether this instance has it, and what the button should do. */
function BrowseCard({ plugin, installed, checking, disabled, onInstall }: {
  plugin: RegistryPlugin;
  installed: PluginStatus | undefined;
  checking: boolean;
  /** Another plugin is being checked or installed: none of the buttons work until it is done. */
  disabled: boolean;
  onInstall: () => void;
}) {
  const status = registryStatus(plugin.latest, installed ? installed.version : null);
  const category = plugin.category ? categoryLabel(plugin.category) : null;

  return (
    <article className="plugins__card card" aria-label={plugin.name}>
      <div className="plugins__head">
        <div className="plugins__icon" aria-hidden="true">🧩</div>
        <div className="plugins__head-text">
          <div className="plugins__title">
            <span className="plugins__name">{plugin.name}</span>
            <span className="plugins__version">v{plugin.latest}</span>
          </div>
          {plugin.author && <p className="plugins__meta">{plugin.author}</p>}
        </div>
        {category && (
          <div className="plugins__badges">
            <span className="badge">{category}</span>
          </div>
        )}
      </div>

      {plugin.description && <p className="plugins__desc">{plugin.description}</p>}

      <div className="plugins__actions">
        {status === 'current' && <span className="badge badge--live">Up to date</span>}
        {status === 'install' && (
          <button type="button" className="primary sm" disabled={disabled} onClick={onInstall}>
            {checking ? 'Checking…' : 'Install'}
          </button>
        )}
        {status === 'update' && (
          <>
            <button type="button" className="primary sm" disabled={disabled} onClick={onInstall}>
              {checking ? 'Checking…' : `Update to v${plugin.latest}`}
            </button>
            <span className="plugins__note">Installed: v{installed ? installed.version : ''}</span>
          </>
        )}
      </div>
    </article>
  );
}
