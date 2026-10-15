// One-command/Settings setup. Runtime keys stay in the app's data directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'), 'waze');
fs.mkdirSync(dir, { recursive: true });
const configFile = path.join(dir, 'runtime.json');
let config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
config.key = process.env.WAZE_HARVESTER_API_KEY || config.key || crypto.randomBytes(32).toString('hex');
config.url = process.env.WAZE_ALERT_SERVICE_URL || config.url || 'http://127.0.0.1:8098/alerts';
fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const statusFile = path.join(dir, 'setup.json');
const status = (state, message, extra = {}) => { fs.writeFileSync(statusFile, JSON.stringify({ state, message, updatedAt: Date.now(), ...extra })); console.log(message); };
const env = { ...process.env, SERVICE_API_KEY: config.key, PORT: '8098' };
// --screen-access lets the operator view and control the Android screen on loopback (127.0.0.1:5556) for Waze's one-time welcome screens.
const screenAccess = process.argv.includes('--screen-access') || process.env.WAZE_SCREEN_ACCESS === '1';
const systemImage = process.env.WAZE_SYSTEM_IMAGE || null;
let startupFailure = null;
let lastProgress = '';
let firstRunHow = null; // the operator instructions while the worker waits for a person
const stages = {
  creating_emulator: 'Creating the Android test device',
  booting_android: 'Android is booting with software emulation; first boot can take 15–30 minutes',
  preparing_android: 'Preparing the Android debug connection',
  installing_waze: 'Downloading and installing Waze',
  compiling_waze: 'Compiling Waze for faster launches (one-off; can take a while without KVM)',
  starting_report_reader: 'Starting the Waze report reader',
  connecting_waze: 'Waiting for Waze reports; the app may need initial onboarding',
  needs_first_run: 'Waze needs its first-run screen completed once by the server operator; the instructions follow',
};
async function showProgress() {
  try {
    const health = new URL(config.url); health.pathname = health.pathname.replace(/alerts\/?$/, 'health'); health.search = '';
    const response = await fetch(health, { headers: { 'X-API-Key': config.key }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const data = await response.json();
    if (data.setup_stage === 'needs_installer') {
      startupFailure = new Error('The download source did not supply a compatible Waze app. Download an ARM64 Waze APK bundle and retry with npm run waze:setup -- --apk PATH, or save it as data/waze/installer.apkm and retry Settings setup.');
      return;
    }
    if (data.setup_stage === 'needs_first_run') {
      // Not a failure: keep waiting while the operator completes Waze's welcome screens.
      const how = typeof data.first_run?.how === 'string' ? data.first_run.how : stages.needs_first_run;
      if (how !== firstRunHow) { firstRunHow = how; console.log(how); }
      if (lastProgress !== 'needs_first_run') { lastProgress = 'needs_first_run'; status('needs_first_run', stages.needs_first_run, { first_run: { how } }); }
      return;
    }
    firstRunHow = null;
    const message = Object.hasOwn(stages, data.setup_stage) ? stages[data.setup_stage] : null;
    if (message && message !== lastProgress) { lastProgress = message; status('starting', message); }
  } catch { /* The worker may still be starting its HTTP server. */ }
}
async function healthy() {
  try {
    const response = await fetch(config.url, { headers: { 'X-API-Key': config.key }, signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) return false;
    const data = await response.json();
    return data.mock !== true && data.connected !== false && Array.isArray(data.alerts) &&
      ['viewport', 'route'].includes(data.coverage) && Number.isFinite(data.observedAt) &&
      Date.now() - data.observedAt < 120000 && data.observedAt <= Date.now() + 60000;
  }
  catch { return false; }
}
try {
  if (systemImage && !/^system-images;android-\d+(\.\d+)?;google_apis(_ps16k)?;x86_64$/.test(systemImage)) throw new Error('WAZE_SYSTEM_IMAGE must be a Google APIs x86_64 system image, such as system-images;android-36;google_apis;x86_64');
  if (await healthy()) { status('ready', 'Waze reports are already running'); process.exit(0); }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : path.join(process.env.HOME, 'Android', 'Sdk'));
  const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const devices = fs.existsSync(adb) ? spawnSync(adb, ['devices'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).stdout?.split(/\r?\n/).map(s => /^([^\s]+)\s+device$/.exec(s)).filter(Boolean).map(m => m[1]) ?? [] : [];
  const emulators = devices.filter(id => id.startsWith('emulator-'));
  const apkIndex = process.argv.indexOf('--apk');
  if (apkIndex >= 0 && !process.argv[apkIndex + 1]) throw new Error('--apk requires a Waze APK or bundle path');
  const suppliedApk = (apkIndex >= 0 ? process.argv[apkIndex + 1] : null) || process.env.WAZE_APK_PATH || (fs.existsSync(path.join(dir, 'installer.apkm')) ? path.join(dir, 'installer.apkm') : null);
  const apkPath = suppliedApk ? path.resolve(suppliedApk) : null;
  const apkExtension = apkPath ? path.extname(apkPath).toLowerCase() : null;
  if (apkPath && (!fs.statSync(apkPath).isFile() || !['.apk', '.apkm', '.apks', '.xapk', '.zip'].includes(apkExtension))) throw new Error('Supply a Waze APK or APK bundle file');
  const useExisting = !apkPath && (process.argv.includes('--existing') || process.platform === 'win32' && emulators.length === 1);
  const configuredRemote = !!process.env.WAZE_ALERT_SERVICE_URL && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.url).hostname);
  if (configuredRemote) {
    // Container deployments and remote workers own their emulator lifecycle.
    status('starting', 'Waiting for the configured Android report bridge to connect');
  } else if (useExisting) {
    if (emulators.length !== 1) throw new Error('Connect exactly one Android test emulator, or use the Docker setup');
    status('installing', 'Preparing the existing Android emulator and report reader');
    if (screenAccess) console.log('Screen access is for the Docker worker only; the existing emulator is already available to scrcpy on this computer.');
    env.ADB_PATH = adb; env.ADB_SERIAL = emulators[0]; env.FRIDA_DEVICE_ID = emulators[0];
    const python = process.platform === 'win32' ? path.join(dir, 'venv', 'Scripts', 'python.exe') : path.join(dir, 'venv', 'bin', 'python');
    if (!fs.existsSync(python)) {
      const created = spawnSync('python', ['-m', 'venv', path.join(dir, 'venv')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      if (created.status !== 0) throw new Error('Python 3 with venv is required for the existing-emulator option');
      const pip = spawnSync(python, ['-m', 'pip', 'install', '-r', path.join(root, 'services', 'waze-harvester', 'requirements.txt')], { stdio: 'ignore', windowsHide: true, timeout: 300000 });
      if (pip.status !== 0) throw new Error('Could not install the isolated report service dependencies');
    }
    // Existing-emulator mode preserves its app installation and root setup.
    const log = fs.openSync(path.join(dir, 'service.log'), 'a');
    const child = spawn(python, [path.join(root, 'services', 'waze-harvester', 'harvester.py')], { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.on('error', () => { startupFailure = new Error('Could not start the Waze report service'); });
    child.on('exit', () => { startupFailure = new Error('The report reader exited before connecting; inspect the service log'); });
    config.pid = child.pid;
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    child.unref(); fs.closeSync(log);
  } else {
    const engine = ['docker', 'podman'].find(cli => spawnSync(cli, ['info'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }).status === 0);
    if (!engine) throw new Error('Start Docker with Linux containers or Podman, then retry setup');
    status('installing', 'Building Android and installing Waze; first setup can take several minutes');
    const log = fs.openSync(path.join(dir, 'setup.log'), 'a');
    async function command(args) {
      const child = spawn(engine, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Container setup timed out; check the container engine and setup log')); }, args[0] === 'build' ? 60 * 60_000 : 120000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Container setup failed; inspect the setup log')); });
      });
    }
    const image = 'localhost/photoscout-waze-reports:local', container = 'photoscout-waze-reports';
    await command(['build', '--tag', image, ...(systemImage ? ['--build-arg', `WAZE_SYSTEM_IMAGE=${systemImage}`] : []), '--file', path.join(root, 'services/waze-harvester/Dockerfile.emulator'), path.join(root, 'services/waze-harvester')]);
    const owned = spawnSync(engine, ['inspect', '--format', '{{index .Config.Labels "photoscout.waze.managed"}}', container], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (owned.status === 0) {
      if (owned.stdout.trim() !== 'true') throw new Error('A container named photoscout-waze-reports already exists and is not managed by this setup');
      await command(['rm', '--force', container]); // Only the owned container; its Android volume is retained.
    }
    const suppliedPath = `/data/supplied${apkExtension}`;
    // KVM is roughly ten times faster than software emulation. Rootless Podman
    // also needs the caller's kvm group carried into the container.
    const kvm = process.platform === 'linux' && fs.existsSync('/dev/kvm')
      ? ['--device', '/dev/kvm', ...(engine === 'podman' ? ['--group-add', 'keep-groups'] : [])] : [];
    status('starting', kvm.length ? 'Using KVM acceleration' : 'No /dev/kvm; using slow software emulation (enable SVM/VT-x in firmware for KVM)');
    // Screen access publishes the guest's adb port on loopback only: anyone who can reach it controls the Android guest.
    const screen = screenAccess ? ['--env', 'WAZE_SCREEN_ACCESS=1', '--publish', '127.0.0.1:5556:5556'] : [];
    await command(['create', '--init', '--name', container, '--label', 'photoscout.waze.managed=true', '--restart', 'unless-stopped', '--publish', '127.0.0.1:8098:8088', ...screen, '--volume', 'photoscout-waze-android:/data', '--shm-size', '512m', '--memory', '6g', '--cpus', '4', ...kvm, '--env', 'SERVICE_API_KEY', ...(apkPath ? ['--env', `WAZE_APK_PATH=${suppliedPath}`] : []), image]);
    if (apkPath) await command(['cp', apkPath, `${container}:${suppliedPath}`]);
    await command(['start', container]);
    fs.closeSync(log);
  }
  status('starting', 'Waiting for Waze to connect and return reports');
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    if (startupFailure) throw startupFailure;
    if (await healthy()) { status('ready', 'Waze police and hazard reports are ready'); process.exit(0); }
    await showProgress();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (firstRunHow) throw new Error(`Waze is still waiting for its one-time first-run screen. ${firstRunHow}`);
  throw new Error('Waze has not returned reports yet; inspect the service log for onboarding or connection issues');
} catch (err) { status('failed', err.message); process.exitCode = 1; }
