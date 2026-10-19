import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { showConvoyNotification } from '../src/convoy/notifications.js';

test('mobile alerts use the service worker instead of a Notification constructor that throws', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  let shown: NotificationOptions | undefined;
  class MobileNotification {
    static permission = 'granted';
    constructor() { throw new Error('Mobile requires service worker notifications'); }
  }
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: MobileNotification });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: {
    getRegistration: async () => ({ active: {}, showNotification: async (_title: string, options: NotificationOptions) => { shown = options; } }),
  } } });
  try {
    assert.equal(await showConvoyNotification({ room: 'ABCDEFGH', text: 'Bob: Wait for me' }), true);
    assert.equal(shown?.body, 'Bob: Wait for me');
    assert.equal(shown?.data.url, '/convoy?room=ABCDEFGH');
    MobileNotification.permission = 'denied';
    shown = undefined;
    assert.equal(await showConvoyNotification({ room: 'ABCDEFGH', text: 'Must not show' }), false);
    assert.equal(shown, undefined);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
    if (originalNotification) Object.defineProperty(globalThis, 'Notification', originalNotification); else Reflect.deleteProperty(globalThis, 'Notification');
  }
});

test('persistent notification clicks focus this app and reject off-site or unrelated destinations', async () => {
  const source = await fs.readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const target of ['/convoy?room=ABCDEFGH', 'https://evil.example/convoy', '/api/auth/logout']) {
    const handlers = new Map<string, (event: any) => void>();
    let opened = '', focused = false;
    vm.runInNewContext(source, { URL, self: {
      location: { origin: 'https://scout.example' },
      addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
      clients: { matchAll: async () => [{ url: 'https://scout.example/', navigate: async (url: string) => { opened = url; }, focus: async () => { focused = true; } }] },
    } });
    let work: Promise<void> | undefined;
    handlers.get('notificationclick')!({ notification: { data: { url: target }, close() {} }, waitUntil(promise: Promise<void>) { work = promise; } });
    await work;
    assert.equal(opened, target.startsWith('/convoy?') ? `https://scout.example${target}` : 'https://scout.example/convoy');
    assert.ok(focused);
  }
});
