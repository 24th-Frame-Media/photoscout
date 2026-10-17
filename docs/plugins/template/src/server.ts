import type { ServerPlugin } from './sdk/server-api.js';

/** Sample data. A real plugin fetches from its source, caches in ctx.db and filters by the bbox. */
const PLACES = [
  { id: 'castle', title: 'Edinburgh Castle', point: [-3.1999, 55.9486] },
  { id: 'palace', title: 'Holyrood Palace', point: [-3.1721, 55.9525] },
];

const plugin: ServerPlugin = {
  activate(ctx) {
    // GET /api/plugins/com.example.hello-places/places?bbox=minLng,minLat,maxLng,maxLat
    // The bbox is optional; without a usable one, every place is returned.
    ctx.router.get('/places', (req, res) => {
      const bbox = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(Number) : [];
      const usable = bbox.length === 4 && bbox.every(Number.isFinite);
      const inside = (p: { point: number[] }) =>
        !usable || (p.point[0] >= bbox[0] && p.point[1] >= bbox[1] && p.point[0] <= bbox[2] && p.point[1] <= bbox[3]);
      res.json({ places: PLACES.filter(inside) });
    });
    ctx.log.info(`serving ${PLACES.length} sample places`);
  },
};

export default plugin;
