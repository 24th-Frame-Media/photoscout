import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LngLatBounds, Map as MlMap, Marker, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, type User } from '../api.js';
import { STYLE_URL } from '../map/layers.js';
import { routeStops, routingWaypoints } from '../map/routeGeometry.js';
// Importing MapPage also hands MapLibre its worker (setWorkerUrl, at the top of that module).
import { MAP_CENTRE_KEY } from './MapPage.js';
import { FOLLOW_PITCH, kmh, motionOf, smoothBearing, zoomForSpeed, accuracyLevel, type Fix } from '../drive/camera.js';
import { DriveMapContext } from '../drive/context.js';
import { formatDistance, formatEta, formatRemaining } from '../drive/format.js';
import { advance, newSession, type DriveSession, type Progress } from '../drive/guidance.js';
import { useGeolocation, useSpeech, useTick, useWakeLock, type GpsError } from '../drive/hooks.js';
import { fetchNavRoute, parseTo, stopsAhead, stopsForSavedRoute, type NavRoute } from '../drive/route.js';
import type { LngLat } from '../drive/geometry.js';
import { ManeuverBanner } from '../components/ManeuverBanner.js';
import DriveSearch from '../components/DriveSearch.js';

/** Where the drive is going: a place, or a saved route to follow through its stops. */
type Target =
  | { kind: 'point'; lat: number; lng: number; name: string }
  | { kind: 'saved'; id: string; name: string; stops: LngLat[] };

type Phase = 'idle' | 'routing' | 'preview' | 'driving' | 'arrived';

const ROUTE_SOURCE = 'drive-route';
const STALE_MS = 10_000;

const GPS_MESSAGES: Record<GpsError, string> = {
  unsupported: 'This browser cannot share its location, so Drive cannot follow you. Try Chrome or Safari on your phone.',
  insecure: 'Drive needs a secure (https) connection to read your location.',
  denied: 'Location is blocked for PhotoScout. Allow it in your browser or phone settings for this site, then reload.',
  unavailable: 'Your device cannot find its location right now. Check that location services are on.',
  timeout: 'Waiting for a GPS signal…',
};

/**
 * In-car navigation: a full-screen, heading-up map that follows the car and
 * guides it to a destination, by voice and by sign.
 *
 * Anything passed as children is drawn inside the screen and can reach the
 * map and the driver's position with `useDriveMap()` (see drive/context.ts).
 */
export default function Drive({ user, children }: { user: User | null; children?: ReactNode }) {
  if (!user) return <div className="page"><p className="hint"><Link to="/login">Sign in</Link> to use Drive.</p></div>;
  return <DriveScreen>{children}</DriveScreen>;
}

function DriveScreen({ children }: { children?: ReactNode }) {
  const [params] = useSearchParams();
  const mapEl = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  const { fix, error: gpsError } = useGeolocation();
  const wake = useWakeLock(true);
  const speech = useSpeech();
  const now = useTick(2000);

  const [target, setTarget] = useState<Target | null>(null);
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [message, setMessage] = useState('');
  const [following, setFollowing] = useState(true);
  const [searchOpen, setSearchOpen] = useState(true);
  const [speedMps, setSpeedMps] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  // The newest of everything, for the map's and the GPS's callbacks, which outlive a render.
  const live = useRef({ phase, target, route, fix, following, speak: speech.speak });
  live.current = { phase, target, route, fix, following, speak: speech.speak };
  const session = useRef<DriveSession>(newSession());
  const lastFix = useRef<Fix | null>(null);
  const heading = useRef<number | null>(null);
  const car = useRef<Marker | null>(null);
  const pin = useRef<Marker | null>(null);
  const asking = useRef<AbortController | null>(null);

  // --- the map ---
  useEffect(() => {
    let centre: [number, number] = [149.577, -33.419];
    try {
      const saved = JSON.parse(localStorage.getItem(MAP_CENTRE_KEY) ?? 'null') as { lat: number; lng: number } | null;
      if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) centre = [saved.lng, saved.lat];
    } catch { /* private mode, or nothing saved */ }
    const m = new MlMap({ container: mapEl.current!, style: STYLE_URL, center: centre, zoom: 14, maxPitch: 70, attributionControl: { compact: true } });
    m.once('style.load', () => {
      m.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'drive-route-casing', type: 'line', source: ROUTE_SOURCE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0e1014', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 17, 18] } });
      m.addLayer({ id: 'drive-route-line', type: 'line', source: ROUTE_SOURCE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#4cc3ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 17, 12] } });
      setMap(m);
    });
    m.once('load', () => m.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
    // Anything the driver does to the camera themselves pauses following; Recentre resumes it.
    const pause = (e: { originalEvent?: unknown }) => { if (e.originalEvent) setFollowing(false); };
    for (const type of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'] as const) m.on(type, pause);
    // A tap picks a destination, but never while driving: a thumb on the way past is not a new trip.
    m.on('click', (e) => {
      if (live.current.phase === 'driving' || live.current.phase === 'routing') return;
      void choose({ kind: 'point', lat: e.lngLat.lat, lng: e.lngLat.lng, name: 'Dropped pin' });
    });
    return () => { m.remove(); car.current = null; pin.current = null; };
  }, []);

  // The map's credit line sits above the readouts, whatever height they are.
  useEffect(() => {
    const el = bar.current, host = root.current;
    if (!el || !host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => host.style.setProperty('--drive-bar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- the car, and the camera behind it ---
  useEffect(() => {
    if (!map || !fix) return;
    // The map arriving after a fix re-runs this for the same fix; that is not a standstill.
    const motion = lastFix.current === fix ? { speedMps, heading: heading.current } : motionOf(lastFix.current, fix);
    if (lastFix.current !== fix) {
      lastFix.current = fix;
      setSpeedMps(motion.speedMps);
      if (motion.heading !== null) heading.current = smoothBearing(heading.current ?? motion.heading, motion.heading, 0.5);
    }

    if (!car.current) {
      const el = document.createElement('div');
      el.className = 'drivecar';
      el.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 33 35 20 28 7 35Z" /></svg>';
      car.current = new Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([fix.lng, fix.lat]).addTo(map);
    }
    car.current.setLngLat([fix.lng, fix.lat]).setRotation(heading.current ?? 0);

    if (live.current.following && live.current.phase !== 'preview') {
      map.easeTo({
        center: [fix.lng, fix.lat],
        bearing: heading.current ?? map.getBearing(),
        pitch: FOLLOW_PITCH,
        zoom: zoomForSpeed(kmh(motion.speedMps)),
        // The car sits low on the screen, with the road ahead above it.
        padding: { top: Math.round(map.getContainer().clientHeight * 0.4), bottom: 0, left: 0, right: 0 },
        duration: 900,
        easing: (t) => t,
      });
    }

    const { phase: ph, route: r } = live.current;
    if (ph !== 'driving' || !r) return;
    const u = advance(r, session.current, { pos: [fix.lng, fix.lat], accuracyM: fix.accuracy, speedMps: motion.speedMps }, Date.now());
    session.current = u.session;
    setProgress(u.progress);
    if (u.say) live.current.speak(u.say);
    if (u.arrived) { setPhase('arrived'); setFollowing(true); }
    else if (u.reroute) void replan();
  }, [fix, map]);

  // --- the route, the destination pin ---
  useEffect(() => {
    if (!map) return;
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(route
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } }
      : { type: 'FeatureCollection', features: [] });
  }, [map, route]);

  useEffect(() => {
    if (!map) return;
    pin.current?.remove();
    pin.current = null;
    const end = route?.coords.at(-1) ?? (target?.kind === 'point' ? ([target.lng, target.lat] as LngLat) : null);
    if (!end) return;
    const el = document.createElement('div');
    el.className = 'drivepin';
    el.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2a10 10 0 0 0-10 10c0 7.5 10 18 10 18s10-10.5 10-18A10 10 0 0 0 16 2z"/><circle cx="16" cy="12" r="4"/></svg>';
    pin.current = new Marker({ element: el, anchor: 'bottom' }).setLngLat(end).addTo(map);
  }, [map, route, target]);

  // Show the whole trip while the driver decides.
  useEffect(() => {
    if (!map || !route || phase !== 'preview') return;
    const b = route.coords.reduce((acc, p) => acc.extend(p), new LngLatBounds(route.coords[0], route.coords[0]));
    map.fitBounds(b, { padding: { top: 120, bottom: 240, left: 40, right: 40 }, pitch: 0, bearing: 0, maxZoom: 16, duration: 800 });
  }, [map, route, phase]);

  // --- choosing, routing, driving ---
  /** Ask for a route to `t` from where the car is; `reroute` keeps going from the current one instead of previewing. */
  const plan = useCallback(async (t: Target, reroute: boolean) => {
    const here: LngLat | null = live.current.fix ? [live.current.fix.lng, live.current.fix.lat] : null;
    let stops: LngLat[];
    if (t.kind === 'point') {
      if (!here) { setMessage('Waiting for your location…'); return false; }
      stops = [here, [t.lng, t.lat]];
    } else if (reroute && here && live.current.route) {
      stops = [here, ...stopsAhead(live.current.route, t.stops, session.current.along)];
    } else stops = stopsForSavedRoute(t.stops, here);
    if (stops.length < 2) { setMessage('That route has nowhere to go.'); return false; }
    asking.current?.abort();
    const ac = asking.current = new AbortController();
    setMessage('');
    try {
      const r = await fetchNavRoute(stops, ac.signal);
      setRoute(r);
      session.current = newSession();
      setProgress(null);
      return true;
    } catch (err) {
      if (!ac.signal.aborted) setMessage((err as Error).message);
      return false;
    }
  }, []);

  async function choose(t: Target) {
    setTarget(t);
    setSearchOpen(false);
    setPhase('routing');
    setFollowing(false);
    const ok = await plan(t, false);
    setPhase(ok ? 'preview' : 'idle');
    if (!ok) { setRoute(null); setFollowing(true); }
  }

  async function replan() {
    const t = live.current.target;
    if (!t) return;
    live.current.speak('Rerouting');
    setRerouting(true);
    await plan(t, true); // on failure the old route stays, and the next off-route check tries again
    setRerouting(false);
  }

  function start() {
    speech.unlock();
    session.current = newSession();
    setProgress(null);
    setPhase('driving');
    setFollowing(true);
  }

  function stop() {
    asking.current?.abort();
    speech.cancel();
    setPhase('idle');
    setRoute(null);
    setTarget(null);
    setProgress(null);
    setRerouting(false);
    setMessage('');
    setFollowing(true);
    setSearchOpen(true);
  }

  // Where the address bar asked to go: ?to=lat,lng or ?route=<saved route id>.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !map) return;
    const to = parseTo(params.get('to'));
    const routeId = params.get('route');
    if (to) {
      if (!fix) return; // a place needs a start, so wait for the first fix
      handled.current = true;
      void choose({ kind: 'point', ...to, name: 'Destination' });
    } else if (routeId) {
      handled.current = true;
      api.route(routeId).then((r) => {
        const stops = routingWaypoints(routeStops(r), r.type);
        return choose({ kind: 'saved', id: r.id, name: r.name, stops });
      }, (err: Error) => setMessage(`Could not open that route: ${err.message}`));
    }
  }, [map, fix, params]);

  // --- what to show ---
  const stale = !!fix && now - fix.t > STALE_MS;
  const noSignal = !fix || stale;
  const level = fix ? accuracyLevel(fix.accuracy) : 'poor';
  const eta = progress && route ? Date.now() + progress.remainingS * 1000 : route ? Date.now() + route.durationS * 1000 : 0;

  return (
    <DriveMapContext.Provider value={{ map, fix }}>
      <div className="drive" data-phase={phase} ref={root}>
        <div className="drive__map" ref={mapEl} />

        <div className="drive__top">
          {gpsError && gpsError !== 'timeout' && !fix && <div className="drive__alert" role="alert">{GPS_MESSAGES[gpsError]}</div>}
          {searchOpen && phase !== 'arrived' && (
            <DriveSearch onPick={(r) => void choose({ kind: 'point', lat: r.lat, lng: r.lng, name: r.displayName.split(',')[0] })} onClose={() => setSearchOpen(false)} />
          )}
          {phase === 'driving' && route && progress && !searchOpen && <ManeuverBanner route={route} progress={progress} rerouting={rerouting} />}
          {phase === 'arrived' && <div className="drive__arrived" role="status">You have arrived{target ? ` at ${target.name}` : ''}</div>}
        </div>

        <div className="drive__tools">
          {!following && phase !== 'preview' && <button type="button" className="primary" onClick={() => setFollowing(true)}>Recentre</button>}
          <Link className="drivebtn" to="/" aria-label="Leave Drive">Exit</Link>
          {speech.supported && (
            <button type="button" className={`drivebtn${speech.muted ? ' is-off' : ''}`} aria-pressed={speech.muted} onClick={() => speech.setMuted(!speech.muted)}>
              {speech.muted ? 'Voice off' : 'Voice on'}
            </button>
          )}
          {phase !== 'arrived' && <button type="button" className="drivebtn" aria-pressed={searchOpen} onClick={() => setSearchOpen(!searchOpen)}>Search</button>}
        </div>

        <div className="drive__bar" ref={bar}>
          <div className="drive__speed" aria-label="Speed">
            <span className="drive__kmh">{fix && !noSignal ? kmh(speedMps) : '–'}</span>
            <span className="drive__unit">km/h</span>
          </div>
          <div className={`drive__gps drive__gps--${noSignal ? 'none' : level}`} role="status">
            <span className="drive__dot" aria-hidden />
            {!fix ? (gpsError === 'denied' ? 'Location blocked' : 'Finding GPS…') : stale ? 'GPS lost' : `GPS ±${Math.round(fix.accuracy)} m`}
            {wake === 'unsupported' && <span className="drive__sub"> · screen may sleep</span>}
          </div>

          <div className="drive__trip">
            {message && <p className="drive__msg" role="alert">{message}</p>}
            {phase === 'idle' && !message && <p className="drive__hint">Search for a place, or tap the map.</p>}
            {phase === 'routing' && <p className="drive__hint">Finding the way…</p>}
            {phase === 'preview' && route && (
              <>
                <p className="drive__summary"><strong>{formatDistance(route.distanceM)}</strong> · {formatRemaining(route.durationS)} · arrive {formatEta(eta)}</p>
                <div className="drive__actions">
                  <button type="button" className="primary" onClick={start}>Start</button>
                  <button type="button" onClick={stop}>Cancel</button>
                </div>
              </>
            )}
            {phase === 'driving' && route && (
              <>
                <p className="drive__summary">
                  <strong>{formatDistance(progress?.remainingM ?? route.distanceM)}</strong> · {formatRemaining(progress?.remainingS ?? route.durationS)} · {formatEta(eta)}
                </p>
                <div className="drive__actions"><button type="button" onClick={stop}>End trip</button></div>
              </>
            )}
            {phase === 'arrived' && <div className="drive__actions"><button type="button" className="primary" onClick={stop}>Done</button></div>}
          </div>
        </div>

        {children}
      </div>
    </DriveMapContext.Provider>
  );
}
