import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dataDir } from './db.js';
import { fetchWazeWorkerHealth, type WazeWorkerHealth } from './feeds/waze.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(dataDir, 'waze');
let running = false;

export function loadWazeRuntime(): void {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8')) as { url?: string; key?: string };
    if (!process.env.WAZE_ALERT_SERVICE_URL && config.url) process.env.WAZE_ALERT_SERVICE_URL = config.url;
    if (!process.env.WAZE_HARVESTER_API_KEY && config.key) process.env.WAZE_HARVESTER_API_KEY = config.key;
  } catch { /* Setup has not run on this instance. */ }
}

interface SetupFile {
  state: string;
  message: string;
  updatedAt: number | null;
  first_run?: { detected_at?: number | null; how?: string };
}
export interface WazeSetupView {
  state: string;
  message: string;
  updatedAt: number | null;
  first_run?: { detected_at: number | null; how?: string };
}

export const FIRST_RUN_MESSAGE = 'Waze needs its one-time first-run screen completed by the server operator. Police and hazard reports start after that.';
const PROBE_INTERVAL_MS = 5000;
const PROBE_MAX_AGE_MS = 60000;
let worker: { at: number; health: WazeWorkerHealth | null } | null = null;
let probing = false;

// Refresh the worker's health in the background, so status requests never wait on the worker.
function probeWorker(): void {
  if (probing || !process.env.WAZE_ALERT_SERVICE_URL) return;
  if (worker && Date.now() - worker.at < PROBE_INTERVAL_MS) return;
  probing = true;
  fetchWazeWorkerHealth()
    .then(health => { worker = { at: Date.now(), health }; }, () => { worker = { at: Date.now(), health: null }; })
    .finally(() => { probing = false; });
}

function currentWorkerHealth(): WazeWorkerHealth | null {
  return worker && Date.now() - worker.at < PROBE_MAX_AGE_MS ? worker.health : null;
}

/** Pure: combine the saved setup record with the worker's live stage. Instructions reach admins only. */
export function presentWazeSetup(setup: SetupFile, health: WazeWorkerHealth | null, options: { admin?: boolean } = {}): WazeSetupView {
  const admin = options.admin === true;
  if (health?.setupStage === 'needs_first_run') {
    return firstRunView(health.firstRun?.detectedAt ?? null, health.firstRun?.how ?? null, admin, setup.updatedAt);
  }
  if (setup.state === 'needs_first_run') {
    // The worker has moved on; its health is the newer truth.
    if (health) return { state: 'starting', message: 'Waiting for Waze to connect and return reports', updatedAt: setup.updatedAt };
    return firstRunView(setup.first_run?.detected_at ?? null, setup.first_run?.how ?? null, admin, setup.updatedAt);
  }
  return { state: setup.state, message: setup.message, updatedAt: setup.updatedAt };
}

function firstRunView(detectedAt: number | null, how: string | null, admin: boolean, updatedAt: number | null): WazeSetupView {
  return {
    state: 'needs_first_run', message: FIRST_RUN_MESSAGE, updatedAt,
    first_run: admin ? { detected_at: detectedAt, how: how ?? undefined } : { detected_at: detectedAt },
  };
}

export function wazeSetupStatus(options: { admin?: boolean } = {}): WazeSetupView {
  probeWorker();
  let setup: SetupFile;
  try { setup = JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8')) as SetupFile; }
  catch { setup = { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null }; }
  return presentWazeSetup(setup, currentWorkerHealth(), options);
}

export function startWazeSetup() {
  if (running) return wazeSetupStatus();
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(root, 'scripts', 'setup-waze.mjs');
  if (!fs.existsSync(script)) throw new Error('This installation does not include the Waze setup helper');
  running = true;
  fs.writeFileSync(path.join(dir, 'setup.json'), JSON.stringify({ state: 'starting', message: 'Starting Waze setup', updatedAt: Date.now() }));
  const log = fs.openSync(path.join(dir, 'setup-helper.log'), 'a');
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, DATA_DIR: dataDir }, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.on('error', () => { running = false; fs.writeFileSync(path.join(dir, 'setup.json'), JSON.stringify({ state: 'failed', message: 'Setup helper could not start', updatedAt: Date.now() })); });
  child.on('exit', () => { running = false; loadWazeRuntime(); });
  return wazeSetupStatus();
}
loadWazeRuntime();
