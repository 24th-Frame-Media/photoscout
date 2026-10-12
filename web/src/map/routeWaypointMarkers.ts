/**
 * Draggable waypoint markers for Rolling Routes on MapLibre.
 *
 * Distinct styling for start (A), finish (B) and intermediate (2, 3...) stops.
 *
 * Drag-to-move calls back on dragend for road re-snapping.
 */
import { Marker, type Map as MlMap } from 'maplibre-gl';
import { stopLabel } from './routeGeometry.js';

type LngLat = [number, number];

export interface MarkerLike {
  setLngLat(at: LngLat): this;
  getLngLat(): { lng: number; lat: number };
  addTo(map: MlMap): this;
  remove(): void;
  on(type: 'dragstart' | 'drag' | 'dragend' | string, handler: () => void): unknown;
  getElement(): HTMLElement;
}

export function updateRouteWaypointElement(el: HTMLElement, index: number, total: number): void {
  const kind = index === 0 ? 'start' : index === total - 1 ? 'finish' : 'via';

  el.classList.add('route-waypoint-handle');
  el.classList.remove('route-waypoint-handle--start', 'route-waypoint-handle--finish', 'route-waypoint-handle--via');
  el.classList.add(`route-waypoint-handle--${kind}`);
  el.textContent = stopLabel(index, total);
  el.title = `${kind === 'via' ? `Stop ${index + 1}` : kind === 'start' ? 'Start' : 'Finish'}: drag to move`;
}

export class RouteWaypointMarkers {
  private markers: MarkerLike[] = [];
  private onDragEnd?: (index: number, at: LngLat) => void;
  private dragPanWasEnabled = new WeakMap<MarkerLike, boolean>();

  update(
    map: MlMap | null,
    waypoints: LngLat[],
    active: boolean,
    onDragEnd?: (index: number, at: LngLat) => void,
  ): void {
    this.onDragEnd = onDragEnd;
    if (!map || !active || waypoints.length === 0) {
      this.clear();
      return;
    }

    while (this.markers.length > waypoints.length) {
      this.markers.pop()!.remove();
    }

    const total = waypoints.length;
    waypoints.forEach((coord, index) => {
      const existing = this.markers[index];
      if (existing) {
        updateRouteWaypointElement(existing.getElement(), index, total);
        existing.setLngLat(coord);
      } else {
        const marker = this.addMarker(map, index, total, coord);
        marker.setLngLat(coord);
      }
    });
  }

  clear(): void {
    for (const marker of this.markers) {
      marker.remove();
    }
    this.markers = [];
  }

  private addMarker(
    map: MlMap,
    index: number,
    total: number,
    at: LngLat,
  ): MarkerLike {
    const el = document.createElement('div');
    updateRouteWaypointElement(el, index, total);

    const marker = new Marker({ element: el, draggable: true }).setLngLat(at).addTo(map);

    marker.on('dragstart', () => {
      this.dragPanWasEnabled.set(marker, map.dragPan?.isEnabled() ?? false);
      map.dragPan?.disable();
    });

    marker.on('dragend', () => {
      if (this.dragPanWasEnabled.get(marker)) map.dragPan?.enable();
      this.dragPanWasEnabled.delete(marker);
      const ll = marker.getLngLat();
      this.onDragEnd?.(index, [ll.lng, ll.lat]);
    });

    this.markers[index] = marker;
    return marker;
  }
}

/** One draggable "M" marker for the route's meetup (staging) point. */
export class RouteStagingMarker {
  private marker: Marker | null = null;
  private onDragEnd?: (at: LngLat) => void;

  update(map: MlMap | null, at: LngLat | null, onDragEnd?: (at: LngLat) => void): void {
    this.onDragEnd = onDragEnd;
    if (!map || !at) return this.clear();
    if (this.marker) return void this.marker.setLngLat(at);

    const el = document.createElement('div');
    el.className = 'route-waypoint-handle route-staging-handle';
    el.textContent = 'M';
    el.title = 'Meetup point: drag to move';
    const marker = new Marker({ element: el, draggable: true }).setLngLat(at).addTo(map);
    let panWas = false;
    marker.on('dragstart', () => { panWas = map.dragPan?.isEnabled() ?? false; map.dragPan?.disable(); });
    marker.on('dragend', () => {
      if (panWas) map.dragPan?.enable();
      const ll = marker.getLngLat();
      this.onDragEnd?.([ll.lng, ll.lat]);
    });
    this.marker = marker;
  }

  clear(): void {
    this.marker?.remove();
    this.marker = null;
  }
}
