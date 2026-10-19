import { Marker, type Map as MlMap } from 'maplibre-gl';
import type { Destination, Member } from './types.js';
import { ConvoyMotion } from './motion.js';

/**
 * Draw a convoy on any MapLibre map: a pin per member who is sharing, an
 * arrow turned to their heading, and a flag at the destination.
 *
 * ```ts
 * const convoy = attachConvoyLayer(map, view.members, { me, leader });
 * convoy.update(newMembers, { destination });   // as often as positions come in
 * convoy.remove();                              // when the map or the page goes
 * ```
 *
 * The pins are DOM markers, not a style layer: they survive a basemap style
 * change, need no glyphs or sprites, and a convoy is thirty pins at most.
 * Their look is the `.convoy-pin` rules at the end of styles.css.
 */

/** A pin gone quiet this long is drawn faded: the phone has stopped reporting, though it has not dropped off. */
export const STALE_MS = 30_000;

export interface ConvoyPin { id: string; username: string; lat: number; lng: number; heading: number | null; leader: boolean; me: boolean; stale: boolean; predicted?: boolean }

export interface ConvoyOptions { me?: string | null; leader?: string | null; destination?: Destination | null; now?: () => number }

/** The pins a set of members should have: those online with a position. Pure, so it can be tested without a map. */
export function pinsFor(members: Member[], opts: ConvoyOptions = {}, now = Date.now()): ConvoyPin[] {
  const pins: ConvoyPin[] = [];
  for (const m of members) {
    if (!m.online || !m.position) continue;
    pins.push({
      id: m.id, username: m.username, lat: m.position.lat, lng: m.position.lng, heading: m.position.heading,
      leader: m.id === opts.leader, me: m.id === opts.me, stale: now - m.position.ts > STALE_MS,
    });
  }
  return pins;
}

export interface ConvoyLayer {
  update(members: Member[], opts?: ConvoyOptions): void;
  /** Move the map to show everyone and the destination. */
  fit(): void;
  remove(): void;
}

function pinElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'convoy-pin';
  const arrow = document.createElement('span');
  arrow.className = 'convoy-pin__arrow';
  const label = document.createElement('span');
  label.className = 'convoy-pin__label';
  el.append(arrow, label);
  return el;
}

function paint(el: HTMLElement, pin: ConvoyPin): void {
  el.classList.toggle('is-me', pin.me);
  el.classList.toggle('is-leader', pin.leader);
  el.classList.toggle('is-stale', pin.stale);
  el.classList.toggle('is-predicted', !!pin.predicted);
  const arrow = el.querySelector<HTMLElement>('.convoy-pin__arrow')!;
  arrow.hidden = pin.heading === null;
  if (pin.heading !== null) arrow.style.transform = `rotate(${pin.heading}deg)`;
  // textContent, never innerHTML: the name is somebody else's.
  const label = el.querySelector<HTMLElement>('.convoy-pin__label')!;
  const text = `${pin.me ? 'You' : pin.username}${pin.predicted ? ' ~' : ''}`;
  if (label.textContent !== text) label.textContent = text;
  el.title = `${pin.username}${pin.predicted ? ' · estimated position; waiting for GPS' : ''}${pin.stale ? ' · location is stale' : ''}`;
}

export function attachConvoyLayer(map: MlMap, members: Member[] = [], opts: ConvoyOptions = {}): ConvoyLayer {
  const markers = new Map<string, Marker>();
  const motion = new ConvoyMotion();
  let latestMembers: Member[] = members;
  let frame: number | null = null;
  let lastPaint = 0;
  let settledTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let flag: Marker | null = null;
  let current: ConvoyOptions = opts;
  let points: [number, number][] = [];

  function update(next: Member[], nextOpts: ConvoyOptions = current): void {
    if (disposed) return;
    current = nextOpts;
    latestMembers = next;
    if (settledTimer) { clearTimeout(settledTimer); settledTimer = null; }
    motion.update(next, current.now?.() ?? Date.now());
    const pins = pinsFor(next, current, current.now?.() ?? Date.now());
    const alive = new Set(pins.map((p) => p.id));
    for (const [id, marker] of markers) if (!alive.has(id)) { marker.remove(); markers.delete(id); }
    for (const pin of pins) {
      let marker = markers.get(pin.id);
      if (!marker) {
        marker = new Marker({ element: pinElement(), rotationAlignment: 'viewport' }).setLngLat([pin.lng, pin.lat]).addTo(map);
        markers.set(pin.id, marker);
      } else {
        const pose = motion.pose(pin.id, current.now?.() ?? Date.now());
        if (pose) marker.setLngLat([pose.lng, pose.lat]);
      }
      paint(marker.getElement(), pin);
    }
    points = pins.map((p) => [p.lng, p.lat]);
    if (!markers.size && frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (motion.isAnimating(current.now?.() ?? Date.now())) startAnimation();
    else {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (markers.size && document.visibilityState === 'visible') settledTimer = setTimeout(() => update(latestMembers, current), 5000);
    }
    const dest = current.destination ?? null;
    if (!dest) { flag?.remove(); flag = null; return; }
    if (!flag) {
      const el = document.createElement('div');
      el.className = 'convoy-flag';
      el.textContent = '⚑';
      flag = new Marker({ element: el, anchor: 'bottom-left' }).setLngLat([dest.lng, dest.lat]).addTo(map);
    } else {
      flag.setLngLat([dest.lng, dest.lat]);
    }
    flag.getElement().title = dest.label || 'Destination';
    points.push([dest.lng, dest.lat]);
  }

  function animate(): void {
    frame = null;
    if (disposed || !markers.size || document.visibilityState !== 'visible') return;
    // Browsers pause RAF in hidden tabs; explicitly skip work there as well.
    if ((current.now?.() ?? Date.now()) - lastPaint >= 32) {
      const now = current.now?.() ?? Date.now();
      lastPaint = now;
      points = [];
      for (const pin of pinsFor(latestMembers, current, now)) {
        const pose = motion.pose(pin.id, now);
        const marker = markers.get(pin.id);
        if (!pose || !marker) continue;
        marker.setLngLat([pose.lng, pose.lat]);
        paint(marker.getElement(), { ...pin, ...pose });
        points.push([pose.lng, pose.lat]);
      }
      if (current.destination) points.push([current.destination.lng, current.destination.lat]);
    }
    if (motion.isAnimating(current.now?.() ?? Date.now())) startAnimation();
    else settledTimer = setTimeout(() => update(latestMembers, current), 5000);
  }

  function startAnimation(): void {
    if (!disposed && markers.size && frame === null && document.visibilityState === 'visible') frame = requestAnimationFrame(animate);
  }
  function visibility(): void {
    if (document.visibilityState !== 'visible') {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (settledTimer) { clearTimeout(settledTimer); settledTimer = null; }
    } else startAnimation();
  }

  update(members, opts);
  document.addEventListener('visibilitychange', visibility);
  return {
    update,
    fit() {
      if (points.length === 0) return;
      if (points.length === 1) { map.easeTo({ center: points[0], zoom: Math.max(map.getZoom(), 13) }); return; }
      const lngs = points.map((p) => p[0]), lats = points.map((p) => p[1]);
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, maxZoom: 16, duration: 600 });
    },
    remove() {
      disposed = true;
      if (settledTimer) clearTimeout(settledTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      flag?.remove();
      flag = null;
    },
  };
}
