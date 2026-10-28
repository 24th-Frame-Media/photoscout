import { useCallback, useEffect, useState } from 'react';
import {
  api,
  LlmQueueItem,
  LlmRole,
  LlmService,
  LlmServiceStatus,
  LlmStatus,
  LlmStrategy,
  ProviderId,
  Settings as SettingsType,
} from './api.js';
import { ConfirmButton, SaveBar, SetUpNotice, useEventSettings } from './shared.js';
import { safeHref } from './text.js';

/** The AI models tab: the services that answer, the text model, its queue, and the flyer reader. */
export default function Model() {
  const s = useEventSettings();
  if (s.notSetUp) return <SetUpNotice />;
  if (!s.draft) return s.error ? <p className="status-line error">{s.error}</p> : <p className="hint">Loading…</p>;
  return (
    <>
      <LocalModelSection draft={s.draft} set={s.set} saved={s.saved} />
      <SaveBar save={s.save} dirty={s.dirty} saved={s.saved} busy={s.busy} error={s.error} canRefresh={s.draft.lat != null} />
    </>
  );
}

const PROVIDER_NAME: Record<ProviderId, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  ollama: 'Ollama (this network)',
  openai: 'OpenAI or compatible',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
};

const ROLE_LABEL: [LlmRole, string][] = [
  ['text', 'Listings'],
  ['vision', 'Flyers'],
  ['chat', 'Chat'],
];

const newId = (): string => Math.random().toString(36).slice(2, 10);

function blankService(): LlmService {
  return { id: newId(), label: '', provider: 'ollama', baseUrl: '', apiKey: '', model: '', roles: [], enabled: true, thinking: true };
}

/** The services an install with only the old Ollama fields had, written out so they can be edited. */
function seedFromLegacy(draft: SettingsType): LlmService[] {
  const out: LlmService[] = [
    {
      id: newId(),
      label: 'Ollama',
      provider: 'ollama',
      baseUrl: draft.llmUrl,
      apiKey: '',
      model: draft.llmModel,
      roles: ['text', 'chat'],
      enabled: true,
      thinking: true,
    },
  ];
  if (draft.visionModel) {
    out.push({
      id: newId(),
      label: 'Ollama (vision)',
      provider: 'ollama',
      baseUrl: draft.llmUrl,
      apiKey: '',
      model: draft.visionModel,
      roles: ['vision'],
      enabled: true,
      thinking: true,
    });
  }
  return out;
}

function LocalModelSection({
  draft,
  set,
  saved,
}: {
  draft: SettingsType;
  set: (patch: Partial<SettingsType>) => void;
  saved: boolean;
}) {
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [msg, setMsg] = useState('');

  const reload = () => api.llmStatus().then(setLlm).catch(() => setLlm(null));
  useEffect(() => {
    void reload();
  }, []);
  // A save can add, change or remove a service, so what they can reach is asked again.
  useEffect(() => {
    if (saved) void reload();
  }, [saved]);

  const jobs = llm?.availableJobs ?? [];
  const services = draft.llmServices ?? [];
  const configured = services.length > 0;
  const statusOf = (id: string): LlmServiceStatus | undefined => llm?.services?.find((x) => x.id === id);

  return (
    <>
      <section>
      <h2>
        🧠 AI models
        <label className="toggle toggle--end">
          <input
            type="checkbox"
            checked={draft.llmEnabled === true}
            onChange={(e) => set({ llmEnabled: e.target.checked })}
          />{' '}
          enabled
        </label>
      </h2>
      {configured ? (
        <p className="hint">
          Reads scraped listings with the AI models below — a local Ollama, or a hosted service with your own key — and
          stores what it makes of them <em>beside</em> the scraped values, never over them — so turning this off puts
          everything back exactly as it was. It runs as its own task, not inside a refresh, because a pass is minutes of
          inference.
        </p>
      ) : (
        <p className="hint">
          Reads scraped listings with a local{' '}
          <a href="https://ollama.com" target="_blank" rel="noreferrer">
            Ollama
          </a>{' '}
          and stores what it makes of them <em>beside</em> the scraped values, never over them — so turning this off puts
          everything back exactly as it was. It runs as its own task, not inside a refresh, because a pass is minutes of
          local inference.
        </p>
      )}

      <ServicesBlock
        draft={draft}
        set={set}
        statusOf={statusOf}
        onCheck={() => void reload()}
      />

      {!configured && (
        <>
          <div className="formrow">
            <label>Ollama URL</label>
            <input
              value={draft.llmUrl}
              placeholder="http://localhost:11434"
              onChange={(e) => set({ llmUrl: e.target.value })}
            />
            <button onClick={() => void reload()}>Check</button>
          </div>

          {llm && !llm.reachable && (
            <p className="hint hint--error">
              {llm.problem}. In Docker the host&apos;s Ollama is{' '}
              <code>http://host.docker.internal:11434</code>, not localhost.
            </p>
          )}

          <div className="formrow">
            <label>Model</label>
            {llm?.reachable && llm.models.length > 0 ? (
              <select value={draft.llmModel} onChange={(e) => set({ llmModel: e.target.value })}>
                <option value="">Choose a model…</option>
                {llm.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({Math.round(m.size / 1e9)} GB)
                  </option>
                ))}
              </select>
            ) : (
              <input value={draft.llmModel} onChange={(e) => set({ llmModel: e.target.value })} />
            )}
          </div>
          <p className="hint" style={{ marginTop: -4 }}>
            A small instruct model is plenty — the answers are short and the schema is
            enforced. Bigger models are slower per event, not obviously better at this.
          </p>
        </>
      )}

      <div className="formrow">
        <label>Jobs</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {jobs.map((job) => (
            <label className="toggle" key={job.key} style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={draft.llmJobs.includes(job.key)}
                onChange={(e) =>
                  set({
                    llmJobs: e.target.checked
                      ? [...draft.llmJobs, job.key]
                      : draft.llmJobs.filter((j) => j !== job.key),
                  })
                }
              />{' '}
              <strong>{job.label}</strong> — <span className="hint hint--flush">{job.hint}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="formrow">
        <label>Every</label>
        <input
          type="number"
          min={5}
          max={1440}
          className="input--narrow"
          value={draft.llmIntervalMinutes}
          onChange={(e) => set({ llmIntervalMinutes: Number(e.target.value) })}
        />
        <span className="hint hint--flush">minutes,</span>
        <input
          type="number"
          min={1}
          max={500}
          className="input--narrow"
          value={draft.llmMaxPerRun}
          onChange={(e) => set({ llmMaxPerRun: Number(e.target.value) })}
        />
        <span className="hint hint--flush">events per pass</span>
      </div>

      {llm && (
        <p className="hint" style={{ marginBottom: 6 }}>
          {!configured && llm.reachable ? `Reachable — ${llm.models.length} models installed. ` : ''}
          {llm.backlog > 0
            ? `${llm.backlog} event${llm.backlog === 1 ? '' : 's'} waiting to be read.`
            : 'Nothing waiting.'}{' '}
          Run it from the Tasks page.
        </p>
      )}

      <ConfirmButton
        label="Forget what it decided"
        question={
          llm?.read
            ? `Forget what the model made of ${llm.read} event${llm.read === 1 ? '' : 's'}? Nothing scraped is lost, but reading them again takes about ${Math.max(1, Math.round((llm.read * 12) / 60))} min.`
            : 'Forget every verdict? Nothing scraped is lost.'
        }
        confirmLabel="Forget them"
        onConfirm={() =>
          void api.llmReset().then((r) => {
            setMsg(`Forgot ${r.cleared} verdict${r.cleared === 1 ? '' : 's'}; the next pass reconsiders everything.`);
            void reload();
          })
        }
      />
      {msg && <p className="hint" style={{ marginBottom: 0 }}>{msg}</p>}
      </section>

      <VisionSection draft={draft} set={set} llm={llm} reload={() => void reload()} />

      <LlmQueueSection />
    </>
  );
}

/**
 * The services that answer, and how they are picked between.
 *
 * Each card is one place a model is asked. A service is used for whichever of
 * the three jobs it is ticked for; the strategy says which of several takes the
 * next request, and a failing one hands over to the rest.
 */
function ServicesBlock({
  draft,
  set,
  statusOf,
  onCheck,
}: {
  draft: SettingsType;
  set: (patch: Partial<SettingsType>) => void;
  statusOf: (id: string) => LlmServiceStatus | undefined;
  onCheck: () => void;
}) {
  const services = draft.llmServices ?? [];
  const put = (next: LlmService[]) => set({ llmServices: next });
  const addService = () => {
    // The first one added to an install that only had the old fields starts from them.
    const base = services.length === 0 ? seedFromLegacy(draft) : services;
    put([...base, blankService()]);
  };

  return (
    <>
      {services.length > 0 && (
        <>
          <div className="formrow">
            <label>Strategy</label>
            <select
              value={draft.llmStrategy ?? 'least_busy'}
              onChange={(e) => set({ llmStrategy: e.target.value as LlmStrategy })}
            >
              <option value="least_busy">Least busy</option>
              <option value="round_robin">Take turns</option>
              <option value="random">Random</option>
            </select>
          </div>
          <p className="hint" style={{ marginTop: -4 }}>
            Which service takes the next request when several can do the same job. If one fails, the others are tried.
          </p>
          {services.map((svc) => (
            <ServiceCard
              key={svc.id}
              svc={svc}
              status={statusOf(svc.id)}
              update={(next) => put(services.map((x) => (x.id === svc.id ? next : x)))}
              remove={() => put(services.filter((x) => x.id !== svc.id))}
            />
          ))}
        </>
      )}
      <div className="notify__actions">
        <button onClick={addService}>+ Add service</button>
        {services.length > 0 && <button onClick={onCheck}>Check services</button>}
      </div>
    </>
  );
}

function ServiceCard({
  svc,
  status,
  update,
  remove,
}: {
  svc: LlmService;
  status: LlmServiceStatus | undefined;
  update: (next: LlmService) => void;
  remove: () => void;
}) {
  const set = (patch: Partial<LlmService>) => update({ ...svc, ...patch });
  const keyed = svc.provider !== 'ollama';
  const addressed = svc.provider === 'ollama' || svc.provider === 'openai';
  const listId = `llm-models-${svc.id}`;
  const toggleRole = (role: LlmRole, on: boolean) =>
    set({ roles: ROLE_LABEL.map(([r]) => r).filter((r) => (r === role ? on : svc.roles.includes(r))) });

  return (
    <details className="notify__target" open={!svc.model}>
      <summary>
        <span className={`notify__dot ${status ? (status.reachable ? 'is-ok' : 'is-bad') : ''}`} />
        <strong>{svc.label || PROVIDER_NAME[svc.provider]}</strong>
        {svc.model && <span>· {svc.model}</span>}
        {!svc.enabled && <span className="hint">(off)</span>}
      </summary>

      <div className="formrow">
        <label>Name</label>
        <input
          value={svc.label}
          placeholder={PROVIDER_NAME[svc.provider]}
          onChange={(e) => set({ label: e.target.value })}
        />
        <label className="toggle">
          <input type="checkbox" checked={svc.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
        </label>
        {svc.provider === 'openai' && (
          <label className="toggle">
            <input type="checkbox" checked={svc.thinking} onChange={(e) => set({ thinking: e.target.checked })} /> Thinking
          </label>
        )}
      </div>
      {svc.provider === 'openai' && (
        <p className="hint" style={{ marginTop: -4 }}>
          Thinking off asks the model to answer without reasoning first (OpenAI-compatible servers such as Strata, vLLM, llama.cpp).
        </p>
      )}

      <div className="formrow">
        <label>Provider</label>
        <select value={svc.provider} onChange={(e) => set({ provider: e.target.value as ProviderId })}>
          {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      {addressed && (
        <div className="formrow">
          <label>Address</label>
          <input
            value={svc.baseUrl}
            placeholder={svc.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </div>
      )}
      {svc.provider === 'openai' && (
        <p className="hint" style={{ marginTop: -4 }}>
          Blank is OpenAI itself; change it for OpenRouter, LM Studio, vLLM…
        </p>
      )}

      {keyed && (
        <div className="formrow">
          <label>API key</label>
          <input
            type="password"
            autoComplete="off"
            value={svc.apiKey ?? ''}
            placeholder={
              svc.apiKey === null
                ? 'will be removed on save'
                : svc.apiKeySet
                  ? 'Key saved — leave blank to keep'
                  : 'Paste the key'
            }
            onChange={(e) => set({ apiKey: e.target.value })}
          />
          {svc.apiKey === null ? (
            <button onClick={() => set({ apiKey: '' })}>Keep</button>
          ) : svc.apiKeySet ? (
            <button className="danger" onClick={() => set({ apiKey: null })}>Remove key</button>
          ) : null}
        </div>
      )}

      <div className="formrow">
        <label>Model</label>
        <input
          value={svc.model}
          list={listId}
          placeholder={svc.provider === 'ollama' ? 'e.g. qwen3:8b' : 'model name'}
          onChange={(e) => set({ model: e.target.value })}
        />
        <datalist id={listId}>
          {(status?.models ?? []).map((m) => (
            <option key={m.name} value={m.name}>
              {m.size ? `${Math.round(m.size / 1e9)} GB` : ''}
            </option>
          ))}
        </datalist>
      </div>

      <div className="formrow">
        <label>Used for</label>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {ROLE_LABEL.map(([role, label]) => (
            <label className="toggle" key={role} style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={svc.roles.includes(role)}
                onChange={(e) => toggleRole(role, e.target.checked)}
              />{' '}
              {label}
            </label>
          ))}
        </div>
      </div>

      {svc.enabled && (
        <ServiceStatusLine svc={svc} status={status} />
      )}

      <div className="notify__actions">
        <button className="notify__remove" onClick={remove}>
          Remove service
        </button>
      </div>
    </details>
  );
}

/** What the server found when it asked the service: reachable, its model, or why not. */
function ServiceStatusLine({ svc, status }: { svc: LlmService; status: LlmServiceStatus | undefined }) {
  if (!status) {
    return svc.provider !== 'ollama' && !svc.apiKeySet && !svc.apiKey ? (
      <p className="hint hint--error">Needs an API key.</p>
    ) : (
      <p className="hint">Save to check this service.</p>
    );
  }
  if (!status.reachable) {
    return (
      <p className="hint hint--error">
        {status.problem}.
        {svc.provider === 'ollama' && (
          <>
            {' '}In Docker the host&apos;s Ollama is <code>http://host.docker.internal:11434</code>, not localhost.
          </>
        )}
      </p>
    );
  }
  if (svc.provider === 'ollama' && svc.model && !status.modelAvailable) {
    return (
      <p className="hint hint--error">
        {svc.model} is not installed — try: ollama pull {svc.model}
      </p>
    );
  }
  return (
    <p className="hint">
      Reachable — {status.models.length} model{status.models.length === 1 ? '' : 's'}
      {svc.model && status.modelAvailable ? ', and this one is among them' : ''}.
    </p>
  );
}

/**
 * The flyer reader.
 *
 * Its own model rather than a fifth job on the text pass. The models that read
 * an image are not the ones that write well, a flyer costs four times what a
 * description does, and the two fail in unrelated ways — so they are switched
 * on, scheduled and reset separately.
 */
function VisionSection({
  draft,
  set,
  llm,
  reload,
}: {
  draft: SettingsType;
  set: (patch: Partial<SettingsType>) => void;
  llm: LlmStatus | null;
  reload: () => void;
}) {
  const [msg, setMsg] = useState('');
  const configured = (draft.llmServices ?? []).length > 0;
  return (
    <section>
      <h2>
        🖼 Flyer reading
        <label className="toggle toggle--end">
          <input
            type="checkbox"
            checked={draft.visionEnabled === true}
            onChange={(e) => set({ visionEnabled: e.target.checked })}
          />{' '}
          enabled
        </label>
      </h2>
      <p className="hint">
        Most listings arrive with a flyer, and for the ones scraped from organiser
        posts the venue, street and price are printed on it rather than written
        anywhere a parser can reach. This reads them, and fills only the fields
        the listing left blank.
      </p>

      {configured ? (
        <p className="hint" style={{ marginTop: 0 }}>
          Flyers go to the services above that are ticked for <em>Flyers</em>. Each has to be a model that can see — a
          text model will answer nothing, or nonsense.
        </p>
      ) : (
        <>
          <div className="formrow">
            <label>Vision model</label>
            {llm?.reachable && llm.models.length > 0 ? (
              <select value={draft.visionModel} onChange={(e) => set({ visionModel: e.target.value })}>
                <option value="">Choose a model…</option>
                {llm.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({Math.round(m.size / 1e9)} GB)
                  </option>
                ))}
              </select>
            ) : (
              <input value={draft.visionModel} onChange={(e) => set({ visionModel: e.target.value })} />
            )}
          </div>
          <p className="hint" style={{ marginTop: -4 }}>
            It has to be a model that can see — a text model will answer nothing, or
            nonsense. Uses the same Ollama as above.
          </p>
        </>
      )}

      <div className="formrow">
        <label>Every</label>
        <input
          type="number"
          min={5}
          max={1440}
          className="input--narrow"
          value={draft.visionIntervalMinutes}
          onChange={(e) => set({ visionIntervalMinutes: Number(e.target.value) })}
        />
        <span className="hint hint--flush">minutes,</span>
        <input
          type="number"
          min={1}
          max={200}
          className="input--narrow"
          value={draft.visionMaxPerRun}
          onChange={(e) => set({ visionMaxPerRun: Number(e.target.value) })}
        />
        <span className="hint hint--flush">flyers per pass</span>
      </div>

      {llm?.vision && (
        <p className="hint" style={{ marginBottom: 6 }}>
          {llm.vision.backlog > 0
            ? `${llm.vision.backlog} flyer${llm.vision.backlog === 1 ? '' : 's'} worth reading — that is only the events still missing a venue, address or price.`
            : 'No flyers worth reading: nothing is missing a venue, address or price.'}{' '}
          Around 15–25 seconds each. Run it from the Tasks tab.
        </p>
      )}

      <ConfirmButton
        label="Forget what it read"
        question={
          llm?.vision.read
            ? `Forget ${llm.vision.read} flyer reading${llm.vision.read === 1 ? '' : 's'}? Nothing scraped is lost, but reading them again takes about ${Math.max(1, Math.round((llm.vision.read * 10) / 60))} min.`
            : 'Forget every flyer reading? Nothing scraped is lost.'
        }
        confirmLabel="Forget them"
        onConfirm={() =>
          void api.visionReset().then((r) => {
            setMsg(`Forgot ${r.cleared} flyer reading${r.cleared === 1 ? '' : 's'}.`);
            reload();
          })
        }
      />
      {msg && <p className="hint" style={{ marginBottom: 0 }}>{msg}</p>}
    </section>
  );
}

/**
 * Events currently waiting for or recently checked by the local model.
 *
 * Shows the raw queued events in the database so the user can verify
 * that crawled and scraped events are actually being put in, and inspect
 * their vetting verdicts.
 */
function LlmQueueSection() {
  const [queue, setQueue] = useState<LlmQueueItem[]>([]);
  const [totalWaiting, setTotalWaiting] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'pending' | 'vetted'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.llmQueue(filter, 300);
      setQueue(res.queue);
      setTotalWaiting(res.totalWaiting);
    } catch {
      // Ignored if failed
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const runCheck = async () => {
    setRunning(true);
    setRunMsg('');
    try {
      const res = await api.runTask('enrich');
      setRunMsg(res.message || (res.ok ? 'Started model check.' : 'Could not run.'));
      setTimeout(() => void loadQueue(), 2000);
    } catch (err) {
      setRunMsg((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const filtered = queue.filter((item) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      (item.venueName && item.venueName.toLowerCase().includes(q)) ||
      (item.address && item.address.toLowerCase().includes(q)) ||
      item.source.toLowerCase().includes(q)
    );
  });

  const PAGE_SIZE = 25;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const displayed = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section>
      <h2>
        📋 Events queued to be checked
        {totalWaiting > 0 && (
          <span className="badge" style={{ marginLeft: 8, fontSize: '0.8rem', verticalAlign: 'middle' }}>
            {totalWaiting} waiting
          </span>
        )}
      </h2>
      <p className="hint">
        Raw events stored in the database waiting for or processed by the local model.
        Use this to verify that events from the crawler and other sources are being ingested.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Filter by title, venue, source…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          style={{ maxWidth: 280 }}
        />
        <select value={filter} onChange={(e) => { setFilter(e.target.value as 'all' | 'pending' | 'vetted'); setPage(0); }}>
          <option value="all">All ({queue.length})</option>
          <option value="pending">Waiting to be checked</option>
          <option value="vetted">Already checked / enriched</option>
        </select>
        <button onClick={() => void loadQueue()} disabled={loading}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
        <button className="primary" onClick={() => void runCheck()} disabled={running}>
          {running ? 'Starting…' : '▶ Run check now'}
        </button>
        {runMsg && <span className="hint hint--flush">{runMsg}</span>}
      </div>

      {displayed.length === 0 ? (
        <p className="hint">{loading ? 'Loading queue…' : 'No queued events match.'}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="crawltable crawltable--wide" style={{ width: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Source</th>
                <th>When</th>
                <th>Title</th>
                <th>Where</th>
                <th style={{ width: 140 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="badge" style={{ fontSize: '0.75rem', padding: '2px 6px' }}>
                      {item.source}
                    </span>
                  </td>
                  <td className="crawltable__when" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                    {new Date(item.startTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </td>
                  <td>
                    {item.url ? (
                      <a href={safeHref(item.url)} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
                        {item.title}
                      </a>
                    ) : (
                      <span style={{ fontWeight: 500 }}>{item.title}</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                    {[item.venueName, item.address].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td>
                    {item.status === 'waiting' && (
                      <span style={{ color: 'var(--accent, #38bdf8)' }}>⏳ Waiting</span>
                    )}
                    {item.status === 'accepted' && (
                      <span style={{ color: 'var(--green, #4ade80)' }}>✓ Event</span>
                    )}
                    {item.status === 'rejected' && (
                      <span style={{ color: 'var(--red, #f87171)' }} title={item.vetNote}>
                        ✕ Not event
                      </span>
                    )}
                    {item.status === 'enriched' && (
                      <span style={{ color: 'var(--green, #4ade80)' }}>✓ Enriched</span>
                    )}
                    {item.status === 'failed' && (
                      <span style={{ color: 'var(--muted)' }}>⚠ Failed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {pages > 1 && (
            <div className="pager" style={{ marginTop: 8 }}>
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ‹ Prev
              </button>
              <span className="hint">
                {page + 1} of {pages} ({filtered.length} events)
              </span>
              <button disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                Next ›
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
