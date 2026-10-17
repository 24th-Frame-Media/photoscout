import type { Map as MlMap } from 'maplibre-gl';
import type { WindGridResponse } from '../api.js';

export interface AirCurrentsState {
  visible: boolean;
  windKmh: number | null;
  windDeg: number | null;
  windGrid: WindGridResponse | null;
}

/** Lightweight canvas wind-field overlay; it never intercepts map input. */
export class AirCurrentsOverlay {
  private readonly map: MlMap;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private state: AirCurrentsState = { visible: false, windKmh: null, windDeg: null, windGrid: null };

  constructor(map: MlMap) {
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'air-currents-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '3' });
    this.ctx = this.canvas.getContext('2d')!;
    map.getContainer().appendChild(this.canvas);
  }

  update(next: Partial<AirCurrentsState>) {
    Object.assign(this.state, next);
    this.render();
  }

  private render() {
    const { clientWidth: w, clientHeight: h } = this.map.getCanvas();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    if (!this.state.visible || !w || !h) return;

    const points = this.state.windGrid?.grid?.length ? this.state.windGrid.grid : [{ windKmh: this.state.windKmh ?? 0, windDeg: this.state.windDeg ?? 0 }];
    for (let i = 0; i < 42; i++) {
      const p = points[i % points.length];
      const heading = ((p.windDeg + 180) * Math.PI) / 180;
      const length = Math.max(8, Math.min(30, p.windKmh * 0.65));
      const x = ((i * 83) % Math.max(1, w - 20)) + 10;
      const y = ((i * 47) % Math.max(1, h - 20)) + 10;
      const color = p.windKmh >= 55 ? '#f43f5e' : p.windKmh >= 35 ? '#fbbf24' : p.windKmh >= 15 ? '#38bdf8' : '#7dd3fc';
      this.ctx.strokeStyle = color;
      this.ctx.globalAlpha = 0.52;
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(x + Math.sin(heading) * length, y - Math.cos(heading) * length);
      this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
  }

  destroy() {
    this.canvas.remove();
  }
}
