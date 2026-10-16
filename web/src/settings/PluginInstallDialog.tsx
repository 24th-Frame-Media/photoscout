import { useState, type ReactNode } from 'react';
import Modal from '../components/Modal.js';
import { pluginsApi, type PluginStatus, type RemotePreview } from './pluginsApi.js';
import { categoryLabel, localNetworkLines, permissionLines, safeHttpUrl, sizeLabel } from './pluginsFormat.js';
import './plugins.css';

/**
 * The step between Install and the install itself: what the plugin asks for, what it runs, and a plain warning.
 * Confirm installs it; Cancel (or Escape, or the close button, while nothing is running) leaves everything as it was.
 */
export default function PluginInstallDialog({ registryUrl, preview, installed, onCancel, onInstalled }: {
  registryUrl: string;
  preview: RemotePreview;
  /** The copy already installed, if any: this then updates it. */
  installed: PluginStatus | undefined;
  onCancel: () => void;
  onInstalled: (status: PluginStatus, updated: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const updating = installed !== undefined;
  const title = updating ? `Update ${preview.name} to v${preview.version}` : `Install ${preview.name}`;
  const permissions = permissionLines(preview.permissions);
  const localNetwork = localNetworkLines(preview.permissions);
  const homepage = safeHttpUrl(preview.homepage);
  const meta = [preview.author, categoryLabel(preview.category)].filter((part) => part !== '').join(' · ');

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const done = await pluginsApi.installRemote(registryUrl, preview.id, preview.version);
      onInstalled(done.status, updating); // the parent closes this dialog
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal label={title} size="small" onClose={() => { if (!busy) onCancel(); }}>
      <div className="plugins__dialog">
        <h3>{title}</h3>
        {meta && <p className="plugins__meta">{meta}</p>}
        {preview.description && <p className="plugins__desc">{preview.description}</p>}
        {installed && <p className="hint">You have v{installed.version} now. Installing this replaces it.</p>}

        <div className="banner plugins__warn" role="note">
          <p><strong>A plugin runs with full access to this app in your browser.</strong> Only install plugins you trust.</p>
        </div>

        <Section label="Permissions">
          {permissions.length > 0 ? (
            <ul className="plugins__perms">{permissions.map((line) => <li key={line}>{line}</li>)}</ul>
          ) : (
            <p className="plugins__note">No special access.</p>
          )}
          {localNetwork.map((line) => (
            <div key={line} className="banner plugins__warn" role="note">
              <p><strong>Local network access.</strong> {line}</p>
            </div>
          ))}
        </Section>

        {preview.services.length > 0 && (
          <Section label="Companion services">
            <ul className="plugins__perms">
              {preview.services.map((s) => <li key={s.name}>{s.name} ({s.image}, port {s.port})</li>)}
            </ul>
            <p className="plugins__note">These start containers on this server when the plugin runs.</p>
          </Section>
        )}

        <Section label="Code">
          <ul className="plugins__perms">
            {preview.hasServer && <li>Server code: runs on this PhotoScout server</li>}
            {preview.hasWeb && <li>Browser code: runs in your browser</li>}
            {!preview.hasServer && !preview.hasWeb && <li>No code, only files</li>}
          </ul>
        </Section>

        {preview.publicRoutes.length > 0 && (
          <Section label="Public routes">
            <ul className="plugins__perms">
              {preview.publicRoutes.map((route) => <li key={route}><code>{route}</code></li>)}
            </ul>
            <p className="plugins__note">Open without signing in, even on a private instance.</p>
          </Section>
        )}

        <Section label="Package">
          <p className="plugins__note">
            {sizeLabel(preview.size)}, checksum <code>{preview.sha256.slice(0, 12)}…</code> matches the registry.
          </p>
          {homepage && (
            <p className="plugins__note">
              Homepage: <a href={homepage} target="_blank" rel="noreferrer noopener">{homepage}</a>
            </p>
          )}
        </Section>

        {error && <p className="status-line error" role="alert">{error}</p>}
        <div className="plugins__actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? (updating ? 'Updating…' : 'Installing…') : updating ? 'Update' : 'Install'}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="plugins__dialog-section">
      <span className="plugins__label">{label}</span>
      {children}
    </div>
  );
}
