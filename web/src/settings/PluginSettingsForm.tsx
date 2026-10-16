import { FormEvent, ReactNode, useEffect, useId, useState } from 'react';
import { pluginsApi, type PluginSettingField, type PluginSettings, type PluginStatus } from './pluginsApi.js';
import { changedSettings, draftFor, type DraftValue, type SettingsEdits } from './pluginsFormat.js';

/**
 * A plugin's settings, drawn from the fields it declares. Ordinary values are
 * shown as stored; a secret is never shown back, so it is typed fresh, left
 * blank to keep, or removed. Only the fields that changed are sent.
 */
export default function PluginSettingsForm({ plugin }: { plugin: PluginStatus }) {
  const fields = plugin.settingsSchema;
  const [loaded, setLoaded] = useState<PluginSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [values, setValues] = useState<Record<string, DraftValue>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  /** Start again from what the server holds: the inputs, the typed secrets and the removals all reset. */
  const reset = (next: PluginSettings) => {
    setLoaded(next);
    setValues(Object.fromEntries(fields.map((f) => [f.key, draftFor(f, next.values[f.key])])));
    setTyped({});
    setRemoved({});
  };

  useEffect(() => {
    let live = true;
    pluginsApi
      .settings(plugin.id)
      .then((next) => {
        if (live) reset(next);
      })
      .catch((err: unknown) => {
        if (live) setLoadError((err as Error).message);
      });
    return () => {
      live = false;
    };
    // The form belongs to one plugin; a change of plugin mounts a new one.
  }, [plugin.id]);

  if (loadError) return <p className="status-line error" role="alert">{loadError}</p>;
  if (!loaded) return <p className="hint">Loading settings…</p>;

  const edits: SettingsEdits = { values, secretTyped: typed, secretRemoved: removed, current: loaded.values };
  const { payload, errors } = changedSettings(fields, edits);
  const dirty = Object.keys(payload).length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || errors.length > 0) return;
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      reset(await pluginsApi.saveSettings(plugin.id, payload));
      setSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="plugins__fields" onSubmit={(e) => void save(e)} aria-label={`${plugin.name} settings`}>
      {fields.map((field) => (
        <SettingField
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          setValue={(v) => {
            setSaved(false);
            setValues((cur) => ({ ...cur, [field.key]: v }));
          }}
          secretSet={loaded.secretsSet[field.key] === true}
          typed={typed[field.key] ?? ''}
          setTyped={(v) => {
            setSaved(false);
            setTyped((cur) => ({ ...cur, [field.key]: v }));
          }}
          removed={removed[field.key] === true}
          setRemoved={(on) => {
            setSaved(false);
            setRemoved((cur) => ({ ...cur, [field.key]: on }));
            if (on) setTyped((cur) => ({ ...cur, [field.key]: '' }));
          }}
        />
      ))}
      {errors.map((message) => (
        <p key={message} className="status-line error">{message}</p>
      ))}
      <div className="savebar">
        <button type="submit" className="primary" disabled={!dirty || saving || errors.length > 0}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <span className="note">
          {saveError ? <span className="status-line error" role="alert">{saveError}</span> : saved ? '✓ Saved' : dirty ? 'Unsaved changes.' : ''}
        </span>
      </div>
    </form>
  );
}

function SettingField({ field, value, setValue, secretSet, typed, setTyped, removed, setRemoved }: {
  field: PluginSettingField;
  value: DraftValue;
  setValue: (v: DraftValue) => void;
  secretSet: boolean;
  typed: string;
  setTyped: (v: string) => void;
  removed: boolean;
  setRemoved: (on: boolean) => void;
}) {
  const uid = useId();
  const inputId = `${uid}-${field.key}`;
  const text = typeof value === 'string' ? value : '';
  const required = field.required ? ' *' : '';

  if (field.type === 'boolean') {
    return (
      <div className="plugins__field">
        <label className="plugins__check" htmlFor={inputId}>
          <input id={inputId} type="checkbox" checked={value === true} onChange={(e) => setValue(e.target.checked)} />
          {field.label}{required}
        </label>
        {field.help && <span className="hint">{field.help}</span>}
      </div>
    );
  }

  let control: ReactNode;
  switch (field.type) {
    case 'select':
      control = (
        <select id={inputId} value={text} onChange={(e) => setValue(e.target.value)}>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'secret':
      control = (
        <div className="plugins__field-row">
          <input
            id={inputId}
            type="password"
            autoComplete="new-password"
            value={typed}
            disabled={removed}
            placeholder={removed ? 'Will be removed' : secretSet ? 'Saved — leave blank to keep' : 'Not set'}
            onChange={(e) => setTyped(e.target.value)}
          />
          {secretSet && !removed && <button type="button" className="danger" onClick={() => setRemoved(true)}>Remove</button>}
          {removed && <button type="button" onClick={() => setRemoved(false)}>Keep it</button>}
        </div>
      );
      break;
    case 'number':
      control = (
        <input
          id={inputId}
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          value={text}
          onChange={(e) => setValue(e.target.value)}
        />
      );
      break;
    case 'url':
      control = <input id={inputId} type="url" value={text} onChange={(e) => setValue(e.target.value)} />;
      break;
    default:
      control = <input id={inputId} type="text" value={text} onChange={(e) => setValue(e.target.value)} />;
  }

  return (
    <div className="plugins__field">
      <label htmlFor={inputId}>{field.label}{required}</label>
      {control}
      {field.help && <span className="hint">{field.help}</span>}
    </div>
  );
}
