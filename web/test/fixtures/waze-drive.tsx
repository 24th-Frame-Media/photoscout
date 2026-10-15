// Development-only visual fixture: real Waze API reports, simulated GPS/route.
// This entry is not included in the production Vite build.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import Drive from '../../src/pages/Drive.js';
import { api, type User } from '../../src/api.js';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
const bounds = params.get('area') === 'bathurst'
  ? { minLng: 149.54, maxLng: 149.61, minLat: -33.44, maxLat: -33.38 }
  : { minLng: 151.15, maxLng: 151.25, minLat: -33.93, maxLat: -33.8 };
let data = await api.wazeAlerts(bounds);
for (let tries = 0; data.state !== 'fresh' && tries < 8; tries++) {
  document.getElementById('root')!.textContent = 'Waiting for the real Waze area scan…';
  await new Promise(resolve => setTimeout(resolve, 5000));
  data = await api.wazeAlerts(bounds);
}
const police = data.alerts.find(a => a.type === 'POLICE' && (params.get('kind') !== 'camera' || a.subType?.includes('MOBILE')));
if (!police) {
  document.getElementById('root')!.textContent = 'No live police report is currently available in this test area. This fixture never supplies a mock report.';
  throw new Error('No live police report available for navigation verification');
}
const [lng, lat] = police.point;
const start: [number, number] = [lng, lat - .003], end: [number, number] = [lng, lat + .002];
Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
  watchPosition(callback: PositionCallback) {
    const send = () => callback({ coords: { longitude: start[0], latitude: start[1], accuracy: 5, altitude: null, altitudeAccuracy: null, heading: 0, speed: 8 }, timestamp: Date.now() } as GeolocationPosition);
    send(); return window.setInterval(send, 1000);
  }, clearWatch(id: number) { clearInterval(id); },
} });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (String(input).startsWith('/api/route?')) {
    return new Response(JSON.stringify({ code: 'Ok', routes: [{ duration: 90, distance: 555,
      geometry: { coordinates: [start, police.point, end] }, legs: [{ steps: [
        { distance: 555, duration: 90, name: police.street, maneuver: { type: 'depart', bearing_after: 0 } },
        { distance: 0, duration: 0, name: police.street, maneuver: { type: 'arrive' } },
      ] }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};
params.set('to', `${end[1]},${end[0]}`);
history.replaceState(null, '', `?${params}`);
const user: User = { id: 'visual-fixture', username: 'navigation-test', avatar: '', role: 'contributor', banned: false, created_at: '', bio: '', instagram: '' };
createRoot(document.getElementById('root')!).render(<BrowserRouter><Drive user={user}><div style={{ position: 'absolute', bottom: 5, left: 5, zIndex: 9, background: '#111', color: '#fff', fontSize: 11 }}>Verification: simulated GPS and route; live Waze reports</div></Drive></BrowserRouter>);
