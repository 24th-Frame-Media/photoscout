import { useCallback, useEffect, useState } from 'react';
import { api, LlmQueueItem, LlmStatus, Settings as SettingsType } from './api.js';
import { ConfirmButton, SaveBar, SetUpNotice, useEventSettings } from './shared.js';
import { safeHref } from './text.js';

/** The Local model tab: the text model, its queue, and the flyer reader. */
export default function Model() {
  const s = useEventSettings();
  if (s.notSetUp) return <SetUpNotice />;
  if (!s.draft) return s.error ? <p className="status-line error">{s.error}</p> : <p className="hint">Loading…</p>;
  return (
    <>
      <LocalModelSection draft={s.draft} set={s.set} />
      <SaveBar save={s.save} dirty={s.dirty} saved={s.saved} busy={s.busy} error={s.error} canRefresh={s.draft.lat != null} />
    </>
  );
}

function LocalModelSection({
  draft,
  set,
}: {
  draft: SettingsType;
  set: (patch: Partial<SettingsType>) => void;
}) {
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [msg, setMsg] = useState('');

  const reload = () => api.llmStatus().then(setLlm).catch(() => setLlm(null));
  useEffect(() => {
    void reload();
  }, []);

  const jobs = llm?.availableJobs ?? [];

  return (
    <>
      <section>
      <h2>
        🧠 Local model
        <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={draft.llmEnabled === true}
            onChange={(e) => set({ llmEnabled: e.target.checked })}
          />{' '}
          enabled
        </label>
      </h2>
      <p className="hint">
        Reads scraped listings with a local{' '}
        <a href="https://ollama.com" target="_blank" rel="noreferrer">
          Ollama
        </a>{' '}
        and stores what it makes of them <em>beside</em> the scraped values, never
        over them — so turning this off puts everything back exactly as it was.
        It runs as its own task, not inside a refresh, because a pass is minutes
        of local inference.
      </p>

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
        <p className="hint" style={{ color: 'var(--red)' }}>
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
              <strong>{job.label}</strong> — <span className="hint" style={{ margin: 0 }}>{job.hint}</span>
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
          style={{ maxWidth: 90 }}
          value={draft.llmIntervalMinutes}
          onChange={(e) => set({ llmIntervalMinutes: Number(e.target.value) })}
        />
        <span className="hint" style={{ margin: 0 }}>minutes,</span>
        <input
          type="number"
          min={1}
          max={500}
          style={{ maxWidth: 90 }}
          value={draft.llmMaxPerRun}
          onChange={(e) => set({ llmMaxPerRun: Number(e.target.value) })}
        />
        <span className="hint" style={{ margin: 0 }}>events per pass</span>
      </div>

      {llm && (
        <p className="hint" style={{ marginBottom: 6 }}>
          {llm.reachable ? `Reachable — ${llm.models.length} models installed. ` : ''}
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
        {runMsg && <span className="hint" style={{ margin: 0 }}>{runMsg}</span>}
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
  return (
    <section>
      <h2>
        🖼 Flyer reading
        <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
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

      <div className="formrow">
        <label>Every</label>
        <input
          type="number"
          min={5}
          max={1440}
          style={{ maxWidth: 90 }}
          value={draft.visionIntervalMinutes}
          onChange={(e) => set({ visionIntervalMinutes: Number(e.target.value) })}
        />
        <span className="hint" style={{ margin: 0 }}>minutes,</span>
        <input
          type="number"
          min={1}
          max={200}
          style={{ maxWidth: 90 }}
          value={draft.visionMaxPerRun}
          onChange={(e) => set({ visionMaxPerRun: Number(e.target.value) })}
        />
        <span className="hint" style={{ margin: 0 }}>flyers per pass</span>
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
