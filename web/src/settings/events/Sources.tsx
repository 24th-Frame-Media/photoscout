import { SaveBar, SecretField, SetUpNotice, StatusLine, useEventSettings } from './shared.js';

/** The states the car-meet feed covers, in the order its own sitemap lists them. */
const MIDNIGHTSPEC_STATES = ['nsw', 'vic', 'qld', 'wa', 'sa', 'nt'];

/** Where events come from: keys, switches and lists for each source. */
export default function Sources() {
  const s = useEventSettings();
  const { draft, set, statusFor } = s;
  if (s.notSetUp) return <SetUpNotice />;
  if (!draft) return s.error ? <p className="status-line error">{s.error}</p> : <p className="hint">Loading…</p>;

  const listEditor = (label: string, values: string[], onChange: (next: string[]) => void, placeholder: string) => (
    <>
      {values.map((v, i) => (
        <div className="feedrow" key={i}>
          <input value={v} placeholder={placeholder} onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))} />
          <button onClick={() => onChange(values.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...values, ''])}>+ Add {label}</button>
    </>
  );

  return (
    <>
      <section>
        <h2>
          🎫 Ticketmaster
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.ticketmaster !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, ticketmaster: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Concerts, sports, theater. Free key (5,000 calls/day) from{' '}
          <a href="https://developer.ticketmaster.com/" target="_blank" rel="noreferrer">
            developer.ticketmaster.com
          </a>
          .
        </p>
        <SecretField
          label="API key"
          value={draft.ticketmasterKey}
          isSet={Boolean(draft.secretsSet?.ticketmasterKey)}
          onChange={(v) => set({ ticketmasterKey: v })}
        />
        <StatusLine status={statusFor('ticketmaster')} />
      </section>

      <section>
        <h2>
          🪑 SeatGeek
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.seatgeek !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, seatgeek: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Concerts and sports, often complements Ticketmaster. Free client ID from{' '}
          <a href="https://seatgeek.com/account/develop" target="_blank" rel="noreferrer">
            seatgeek.com/account/develop
          </a>
          .
        </p>
        <SecretField
          label="Client ID"
          value={draft.seatgeekClientId}
          isSet={Boolean(draft.secretsSet?.seatgeekClientId)}
          onChange={(v) => set({ seatgeekClientId: v })}
        />
        <StatusLine status={statusFor('seatgeek')} />
      </section>

      <section>
        <h2>
          🎟 Eventbrite
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.eventbrite !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, eventbrite: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Eventbrite removed public search, so this follows specific organizers. Get a private token at{' '}
          <a href="https://www.eventbrite.com/platform/api-keys" target="_blank" rel="noreferrer">
            eventbrite.com/platform/api-keys
          </a>
          . Organizer IDs are the number in an organizer page URL (eventbrite.com/o/name-<strong>1234567890</strong>).
        </p>
        <SecretField
          label="Private token"
          value={draft.eventbriteToken}
          isSet={Boolean(draft.secretsSet?.eventbriteToken)}
          onChange={(v) => set({ eventbriteToken: v })}
        />
        <label className="hint">Organizer IDs</label>
        {listEditor('organizer', draft.eventbriteOrganizerIds, (v) => set({ eventbriteOrganizerIds: v }), '1234567890')}
        <StatusLine status={statusFor('eventbrite')} />
      </section>

      <section>
        <h2>
          📘 Facebook <span className="badge unofficial">unofficial</span>
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.facebook !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, facebook: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Scrapes public Facebook event pages — this violates Meta's terms of service and can break at any time. Works
          far better with a logged-in cookie: open facebook.com → DevTools (F12) → Application → Cookies → copy the{' '}
          <code>c_user</code> and <code>xs</code> values as <code>c_user=…; xs=…</code>. Consider a throwaway account.
        </p>
        <SecretField
          label="Cookie"
          value={draft.fbCookie}
          isSet={Boolean(draft.secretsSet?.fbCookie)}
          placeholder="c_user=100000000000000; xs=abc123…"
          onChange={(v) => set({ fbCookie: v })}
        />
        <label className="hint">Search terms (defaults to your city if empty)</label>
        {listEditor('search term', draft.fbSearchTerms, (v) => set({ fbSearchTerms: v }), 'e.g. Portland events')}
        <label className="hint" style={{ display: 'block', marginTop: 10 }}>
          Pages / venues to follow (name or URL)
        </label>
        {listEditor('page', draft.fbPages, (v) => set({ fbPages: v }), 'e.g. crystalballroompdx')}
        <StatusLine status={statusFor('facebook')} />
      </section>

      <section>
        <h2>
          🔎 Web search <span className="badge unofficial">unofficial</span>
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.websearch !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, websearch: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Searches DuckDuckGo, Bing and Mojeek, follows the top results, and reads
          structured <code>schema.org/Event</code> data out of the pages it lands on.
          No key needed. This is the source that finds the things nobody lists on a
          ticketing site — car club runs, council calendars, showground programmes,
          pub gig listings.
        </p>
        <p className="hint">
          Queries come from the <b>topics</b> you picked under Location, run against
          every area. Search engines quietly return empty pages rather than errors when
          pushed too hard, so a refresh spends a fixed budget spread across areas and
          rotates through the rest next time. Large aggregators that block scraping are
          skipped automatically.
        </p>
        <label className="hint">Extra search terms — added to whatever the topics produce</label>
        {listEditor(
          'search term',
          draft.webSearchTerms,
          (v) => set({ webSearchTerms: v }),
          'e.g. Bathurst 1000 support events'
        )}
        <label className="hint">Search engines to use, tried in this order</label>
        <div className="formrow">
          {['duckduckgo', 'mojeek', 'bing'].map((name) => {
            const off = draft.webSearchDisabledEngines ?? [];
            return (
              <label key={name} style={{ marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={!off.includes(name)}
                  onChange={(e) =>
                    set({
                      webSearchDisabledEngines: e.target.checked ? off.filter((n) => n !== name) : [...off, name],
                    })
                  }
                />{' '}
                {name}
              </label>
            );
          })}
        </div>
        <StatusLine status={statusFor('websearch')} />
      </section>

      <section>
        <h2>
          📅 Calendar feeds (iCal)
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.ical !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, ical: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Many city tourism sites, parks departments, and venues publish .ics calendar feeds — great for festivals and
          free public events. Paste feed URLs here.
        </p>
        {draft.icalFeeds.map((f, i) => (
          <div className="feedrow" key={i}>
            <input
              style={{ maxWidth: 200 }}
              value={f.name}
              placeholder="Name"
              onChange={(e) =>
                set({ icalFeeds: draft.icalFeeds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
              }
            />
            <input
              value={f.url}
              placeholder="https://…/events.ics"
              onChange={(e) =>
                set({ icalFeeds: draft.icalFeeds.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })
              }
            />
            <button onClick={() => set({ icalFeeds: draft.icalFeeds.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button onClick={() => set({ icalFeeds: [...draft.icalFeeds, { name: '', url: '' }] })}>+ Add feed</button>
        <StatusLine status={statusFor('ical')} />
      </section>

      <section>
        <h2>
          🕷 Web crawler
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.crawler !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, crawler: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          A separate program that runs beside this one, following venue and council
          sites outwards from a search and reading the <code>schema.org</code> data
          most of them publish. It keeps its own database and is <em>asked</em> for
          what it has found — it never writes here, so switching it off above stops
          this app looking and changes nothing else. It obeys <code>robots.txt</code>
          and waits between requests to the same site.
        </p>
        <div className="formrow">
          <label>Crawler URL</label>
          <input
            value={draft.crawlerUrl}
            placeholder="http://crawler:3002"
            onChange={(e) => set({ crawlerUrl: e.target.value })}
          />
        </div>
        <p className="hint">
          Blank uses <code>CRAWLER_URL</code>, which docker-compose sets for you.
          It searches for your topics and extra search terms in each of your
          areas, and is told about any change the moment you save.
        </p>
        <label className="hint">
          Sites to crawl — read every six hours, along with the pages they link to
        </label>
        {listEditor(
          'address',
          draft.crawlerUrls ?? [],
          (v) => set({ crawlerUrls: v }),
          'e.g. https://www.bathurst.nsw.gov.au/whats-on'
        )}
        <StatusLine status={statusFor('crawler')} />
      </section>

      <section>
        <h2>
          🏁 MIDNIGHT_SPEC car meets
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.midnightspec !== false}
              onChange={(e) =>
                set({ enabledSources: { ...draft.enabledSources, midnightspec: e.target.checked } })
              }
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Australian car meets, track days, drift nights and Cars &amp; Coffee, from{' '}
          <a href="https://meets.midnightspec.com" target="_blank" rel="noreferrer">
            meets.midnightspec.com
          </a>
          . Needs no key. It is a national feed, so listings are kept only where the
          town matches one of your areas — leave the states below unticked unless
          you want to skip fetching some of them.
        </p>
        <div className="formrow">
          <label>States</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {MIDNIGHTSPEC_STATES.map((state) => (
              <label className="toggle" key={state} style={{ fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={draft.midnightspecStates.includes(state)}
                  onChange={(e) =>
                    set({
                      midnightspecStates: e.target.checked
                        ? [...draft.midnightspecStates, state]
                        : draft.midnightspecStates.filter((s) => s !== state),
                    })
                  }
                />{' '}
                {state.toUpperCase()}
              </label>
            ))}
          </div>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          {draft.midnightspecStates.length === 0
            ? 'None ticked — all six states are read.'
            : `Reading ${draft.midnightspecStates.length} of 6 states.`}
        </p>
        <StatusLine status={statusFor('midnightspec')} />
      </section>
      <SaveBar save={s.save} dirty={s.dirty} saved={s.saved} busy={s.busy} error={s.error} canRefresh={draft.lat != null} />
    </>
  );
}
