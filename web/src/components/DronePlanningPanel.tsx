import React, { useState } from 'react';
import type {
  AerodromesContextResponse,
  DroneContextResponse,
  DroneEvidence,
  DroneSeverity,
  User,
} from '../api.js';

export interface DronePlanningPanelProps {
  user: User | null;
  data: DroneContextResponse | null;
  aerodromesData?: AerodromesContextResponse | null;
  loading: boolean;
  aerodromesLoading?: boolean;
  error: string;
  aerodromesError?: string;
  planningPoint: { lat: number; lng: number } | null;
  centre?: { lat: number; lng: number };
  radiusKm?: number;
  onChangeRadius?: (radiusKm: number) => void;
  onSetPlanningPoint: (coord: { lat: number; lng: number } | null) => void;
  onClose: () => void;
  onRefresh?: () => void;
}

const SEVERITY_LABELS: Record<DroneSeverity, { label: string; badgeClass: string }> = {
  restriction: { label: 'Restriction', badgeClass: 'drone-badge--restriction' },
  caution: { label: 'Caution', badgeClass: 'drone-badge--caution' },
  not_checked: { label: 'Not checked', badgeClass: 'drone-badge--not-checked' },
  pilot_responsibility: { label: 'Pilot responsibility', badgeClass: 'drone-badge--responsibility' },
  info: { label: 'Advisory context', badgeClass: 'drone-badge--info' },
};

const AUTHORITY_LABELS: Record<string, string> = {
  legislation: 'Legislation (CASR)',
  regulator_guidance: 'Regulator guidance (CASA)',
  provider_context: 'Provider context (openAIP / ADS-B)',
  product_policy: 'Product policy heuristic',
  unknown: 'Unverified / external source',
};

export function DronePlanningPanel({
  user,
  data,
  aerodromesData,
  loading,
  aerodromesLoading,
  error,
  aerodromesError,
  planningPoint,
  centre,
  radiusKm,
  onChangeRadius,
  onSetPlanningPoint,
  onClose,
  onRefresh,
}: DronePlanningPanelProps) {
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});

  const toggleCheck = (id: string) => {
    setCheckedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const assessment = data?.assessment;
  const overallSeverity = assessment?.overallSeverity ?? (user ? 'not_checked' : 'info');
  const summaryText = assessment?.summary ?? (loading || aerodromesLoading ? 'Loading planning context…' : 'Advisory drone planning guidance');
  const activeRadiusKm = radiusKm ?? (data?.radiusM ? Math.round(data.radiusM / 1000) : 5);

  return (
    <aside className="panel drone-panel" role="region" aria-label="Drone Planning Assessment">
      <div className="drone-panel__header">
        <div className="drone-panel__header-title">
          <span className="drone-panel__icon">🛸</span>
          <div>
            <h2>Drone Planning</h2>
            <span className="hint">Australian CASR Part 101 Advisory Guidance</span>
          </div>
        </div>
        <button
          type="button"
          className="drone-panel__close"
          onClick={onClose}
          aria-label="Close drone planning panel"
        >
          ✕
        </button>
      </div>

      <div className="drone-panel__body">
        {/* 1. SEVERITY SUMMARY BANNER */}
        <section className={`drone-summary drone-summary--${overallSeverity}`}>
          <div className="drone-summary__badge">
            <span className={`drone-badge ${SEVERITY_LABELS[overallSeverity]?.badgeClass ?? ''}`}>
              {SEVERITY_LABELS[overallSeverity]?.label ?? overallSeverity}
            </span>
            {assessment?.stale && (
              <span className="drone-badge drone-badge--stale">Stale data</span>
            )}
          </div>
          <p className="drone-summary__text"><strong>{summaryText}</strong></p>

          <div className="drone-summary__coords">
            <span>
              📍 Point: {planningPoint ? `${planningPoint.lat.toFixed(4)}, ${planningPoint.lng.toFixed(4)}` : 'Map centre'}
            </span>
            {planningPoint ? (
              <button
                type="button"
                className="drone-btn-small"
                onClick={() => onSetPlanningPoint(null)}
              >
                Reset to centre
              </button>
            ) : centre ? (
              <button
                type="button"
                className="drone-btn-small"
                onClick={() => onSetPlanningPoint(centre)}
              >
                Drop pin here
              </button>
            ) : null}
            {onRefresh && (
              <button
                type="button"
                className="drone-btn-small"
                onClick={onRefresh}
                disabled={loading || aerodromesLoading}
              >
                {loading || aerodromesLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>

          {/* Planned flight radius slider */}
          <div className="drone-radius-control">
            <div className="drone-radius-control__header">
              <label htmlFor="drone-flight-radius-slider" className="drone-radius-control__label">
                Planned flight radius: <strong>{activeRadiusKm} km</strong>
              </label>
            </div>
            <input
              id="drone-flight-radius-slider"
              type="range"
              min={1}
              max={50}
              step={1}
              value={activeRadiusKm}
              onChange={(e) => onChangeRadius?.(Number(e.target.value))}
              aria-label="Planned flight radius"
              aria-valuemin={1}
              aria-valuemax={50}
              aria-valuenow={activeRadiusKm}
              aria-valuetext={`${activeRadiusKm} km`}
              className="drone-radius-control__slider"
            />
          </div>

          {assessment?.evaluatedAt && (
            <div className="drone-summary__meta">
              Evaluated: {new Date(assessment.evaluatedAt).toLocaleTimeString()}
            </div>
          )}
        </section>

        {/* Local aerodrome dataset status banner */}
        {aerodromesData?.available && aerodromesData.status === 'ok' && (
          <div className="drone-alert drone-alert--success">
            <p>
              <strong>Local aerodrome data active:</strong> {aerodromesData.source?.name || 'Local aerodrome registry'}
              {aerodromesData.source?.effectiveDate ? ` (effective ${aerodromesData.source.effectiveDate})` : ''}
              {' · '}{(aerodromesData.aerodromes?.length ?? aerodromesData.airports?.length ?? 0)} aerodromes mapped locally.
              {aerodromesData.source?.authority ? ` Authority: ${aerodromesData.source.authority}.` : ''}
            </p>
          </div>
        )}

        {aerodromesData && (!aerodromesData.available || aerodromesData.status === 'unavailable' || aerodromesData.status === 'empty') && (
          <div className="drone-alert drone-alert--info">
            <p>
              <strong>Local aerodrome dataset absent/unavailable.</strong>{' '}
              {aerodromesData.message || 'No local Australian aerodrome registry installed. Aerodrome points and runway threshold geometry require an installed authoritative dataset.'}
            </p>
          </div>
        )}

        {/* Dynamic provider user state banners */}
        {!user && (
          <div className="drone-alert drone-alert--info">
            <p>
              <strong>Sign in required for dynamic airspace context.</strong>{' '}
              <a href="/settings#account">Sign in</a> and add your user-owned openAIP API key in{' '}
              <a href="/settings#apikeys">Settings → API Keys</a> to display dynamic airspace polygons. Static local aerodrome overlay operates independently.
            </p>
          </div>
        )}

        {user && data && !data.configured && (
          <div className="drone-alert drone-alert--warning">
            <p>
              <strong>OpenAIP API key not configured.</strong>{' '}
              To load dynamic Australian airspace polygons, configure your personal openAIP key in{' '}
              <a href="/settings#apikeys">Settings → API Keys</a>. Local aerodrome markings remain active independently.
            </p>
          </div>
        )}

        {(error || aerodromesError) && (
          <div className="drone-alert drone-alert--error" role="alert">
            {error && <p><strong>Dynamic airspace error:</strong> {error}. Local aerodrome markings remain active.</p>}
            {aerodromesError && <p><strong>Aerodrome data error:</strong> {aerodromesError}</p>}
          </div>
        )}

        {/* Operational Context Cards: Weather & Aircraft */}
        {data && (data.weather || data.aircraft) && (
          <section className="drone-section">
            <h3 className="drone-section__title">Live Awareness Context</h3>
            <div className="drone-context-grid">
              {data.weather && (
                <div className="drone-context-chip">
                  <span className="drone-context-chip__label">Weather</span>
                  <span className="drone-context-chip__value">
                    {data.weather.tempC != null ? `${Math.round(data.weather.tempC)}°C · ` : ''}
                    💨 {data.weather.windKmh != null ? `${Math.round(data.weather.windKmh)} km/h` : '–'}
                    {data.weather.gustKmh != null ? ` (gusts ${Math.round(data.weather.gustKmh)} km/h)` : ''}
                    {data.weather.visibilityM != null ? ` · 👁 ${Math.round(data.weather.visibilityM / 1000)} km vis` : ''}
                  </span>
                </div>
              )}
              {data.aircraft && (
                <div className="drone-context-chip">
                  <span className="drone-context-chip__label">ADS-B Traffic</span>
                  <span className="drone-context-chip__value">
                    {data.aircraft.count === 0 ? (
                      'No broadcast ADS-B aircraft detected in provider coverage'
                    ) : data.aircraft.closest ? (
                      <>
                        ✈ Closest: <strong>{data.aircraft.closest.flight ? data.aircraft.closest.flight.trim() : data.aircraft.closest.hex}</strong>
                        {data.aircraft.closest.distanceM != null ? ` · ${(data.aircraft.closest.distanceM / 1000).toFixed(1)} km away` : ''}
                        {data.aircraft.closest.alt_baro != null ? ` (${data.aircraft.closest.alt_baro} ft)` : ''}
                        {data.aircraft.count > 1 ? ` · ${data.aircraft.count} nearby` : ''}
                      </>
                    ) : (
                      `✈ ${data.aircraft.count} aircraft nearby`
                    )}
                  </span>
                </div>
              )}
            </div>
            <p className="hint">
              Awareness context only. Incomplete ADS-B coverage; remote pilot must maintain continuous visual and listening scan. Non-broadcast aircraft or aircraft below receiver line-of-sight are not detected.
            </p>
          </section>
        )}

        {/* 2. MAPPED RESTRICTIONS & CAUTIONS */}
        {assessment?.evidence && assessment.evidence.length > 0 && (
          <section className="drone-section">
            <h3 className="drone-section__title">Mapped Evidence & Cautions ({assessment.evidence.length})</h3>
            <div className="drone-evidence-list">
              {assessment.evidence.map((item: DroneEvidence) => {
                const isOutsideRadius =
                  item.title.toLowerCase().includes('outside planned radius') ||
                  item.explanation.toLowerCase().includes('outside planned');

                return (
                  <div key={item.id} className={`drone-evidence-card drone-evidence-card--${item.severity}`}>
                    <div className="drone-evidence-card__header">
                      <span className={`drone-badge ${SEVERITY_LABELS[item.severity]?.badgeClass ?? ''}`}>
                        {SEVERITY_LABELS[item.severity]?.label ?? item.severity}
                      </span>
                      {isOutsideRadius && (
                        <span className="drone-badge drone-badge--outside-radius">Outside planned radius</span>
                      )}
                      {item.ruleId && (
                        <span className="drone-badge drone-badge--rule">{item.ruleId.toUpperCase()}</span>
                      )}
                      <span className="drone-badge drone-badge--authority">
                        {AUTHORITY_LABELS[item.authority] ?? item.authority}
                      </span>
                    </div>
                    <h4 className="drone-evidence-card__title">{item.title}</h4>
                    <p className="drone-evidence-card__desc">{item.explanation}</p>
                    <div className="drone-evidence-card__action">
                      <strong>Action required:</strong> {item.userAction}
                    </div>
                    {item.source && (
                      <div className="drone-evidence-card__source">
                        Source: {item.source.name}
                        {item.source.fetchedAt && ` · ${new Date(item.source.fetchedAt).toLocaleTimeString()}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 3. NOT CHECKED GATES */}
        {assessment?.notChecked && assessment.notChecked.length > 0 && (
          <section className="drone-section">
            <h3 className="drone-section__title">
              Not Checked Gates ({assessment.notChecked.length})
            </h3>
            <p className="hint">
              These factors cannot be automated in Phase 1 and are not verified by PhotoScout. Remote pilot verification is mandatory before flight.
            </p>
            <div className="drone-gates-list">
              {assessment.notChecked.map((gate: DroneEvidence) => (
                <div key={gate.id} className="drone-gate-card">
                  <div className="drone-gate-card__header">
                    <span className="drone-badge drone-badge--not-checked">Not checked</span>
                    <span className="drone-badge drone-badge--provider-status">
                      {gate.source?.name || 'No authoritative provider configured'}
                    </span>
                  </div>
                  <h4 className="drone-gate-card__title">{gate.title}</h4>
                  <p className="drone-gate-card__desc">{gate.explanation}</p>
                  <div className="drone-gate-card__action">
                    <strong>Pilot requirement:</strong> {gate.userAction}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 4. PILOT RESPONSIBILITY CHECKLIST */}
        {assessment?.pilotChecklist && assessment.pilotChecklist.length > 0 && (
          <section className="drone-section">
            <h3 className="drone-section__title">Pilot Responsibility Checklist</h3>
            <p className="hint">
              Statutory requirements under CASR Part 101. Confirm each condition on-site:
            </p>
            <div className="drone-checklist">
              {assessment.pilotChecklist.map((item: DroneEvidence) => (
                <label key={item.id} className="drone-checklist-item">
                  <input
                    type="checkbox"
                    checked={Boolean(checkedItems[item.id])}
                    onChange={() => toggleCheck(item.id)}
                  />
                  <div className="drone-checklist-item__text">
                    <div className="drone-checklist-item__title">
                      <strong>{item.title}</strong>
                      {item.ruleId && <span className="drone-rule-tag">{item.ruleId.toUpperCase()}</span>}
                    </div>
                    <p className="drone-checklist-item__desc">{item.explanation}</p>
                    <span className="drone-checklist-item__action">{item.userAction}</span>
                  </div>
                </label>
              ))}
            </div>
          </section>
        )}

        {/* 5. SOURCES & FRESHNESS */}
        <section className="drone-section">
          <h3 className="drone-section__title">Sources, Authority & Freshness</h3>
          <ul className="drone-sources-list">
            <li>
              <strong>Civil Aviation Safety Regulations 1998 (CASR) Part 101</strong>: Statutory authority baseline.
            </li>
            {aerodromesData?.source && (
              <li>
                <strong>Local Aerodrome Registry</strong>: {aerodromesData.source.name} ({aerodromesData.source.authority}, {aerodromesData.source.licence}). Effective: {aerodromesData.source.effectiveDate || 'N/A'}. Loaded locally from disk, no upstream API dependency.
              </li>
            )}
            {data?.sources?.openaip && (
              <li>
                <strong>openAIP Core API</strong>: Airspace boundaries & aerodromes. Fetched: {new Date(data.sources.openaip.fetchedAt).toLocaleString()}. {data.sources.openaip.attribution}
              </li>
            )}
            {data?.sources?.rfs && (
              <li>
                <strong>NSW Rural Fire Service</strong>: Bush fire major incidents feed. {data.sources.rfs.attribution}
              </li>
            )}
            {data?.sources?.weather && (
              <li>
                <strong>Open-Meteo</strong>: Hourly weather forecast. {data.sources.weather.attribution}
              </li>
            )}
            {data?.sources?.aircraft && (
              <li>
                <strong>ADS-B Feeds</strong>: Live aircraft activity context (incomplete coverage).
              </li>
            )}
            <li>
              <strong>PhotoScout Population Heuristic</strong>: Local building footprint and event exposure indicator (not an official determination).
            </li>
          </ul>
          <p className="hint">
            OpenAIP API keys are stored only on the server with your account. Keys are never logged, sent to the browser, or included in errors.
          </p>
        </section>

        {/* 6. STATUTORY DISCLAIMER */}
        <section className="drone-disclaimer">
          <p>
            <strong>Planning guidance only.</strong> PhotoScout does not confirm that a flight is legal, authorised, or safe. The remote pilot is responsible for checking current airspace, NOTAMs, emergency operations, approvals, operating conditions, and all applicable laws.
          </p>
        </section>
      </div>
    </aside>
  );
}
export default DronePlanningPanel;
