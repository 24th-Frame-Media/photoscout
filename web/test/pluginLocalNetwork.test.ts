import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginPermission } from '../src/settings/pluginsApi.js';
import { isLocalNetworkDetail, localNetworkLines } from '../src/settings/pluginsFormat.js';

test('a loopback, private, .local or bare-host detail is local, with or without a port', () => {
  for (const detail of [
    '127.0.0.1', '127.9.9.9:11434', 'localhost', 'localhost:8080', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.20', '192.168.1.20:11434', 'nas', 'printer.local', '*.local', '::1', '[::1]:8080', 'fd12:3456::1', 'fe80::1',
  ]) {
    assert.equal(isLocalNetworkDetail(detail), true, `${detail} is local`);
  }
});

test('a public host, a public address, a wildcard of a public domain, and no detail are not local', () => {
  for (const detail of [
    'radio.garden', 'example.com:443', '*.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1',
    '192.169.0.1', '2001:db8::1', '', undefined,
  ]) {
    assert.equal(isLocalNetworkDetail(detail), false, `${String(detail)} is not local`);
  }
});

test('localNetworkLines: one warning per distinct local network permission, and nothing else', () => {
  const permissions: PluginPermission[] = [
    { kind: 'network', detail: 'radio.garden' },
    { kind: 'network', detail: '192.168.1.20:11434' },
    { kind: 'network', detail: '192.168.1.20:11434' },
    { kind: 'secrets' },
    { kind: 'network', detail: 'localhost' },
  ];
  const lines = localNetworkLines(permissions);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /192\.168\.1\.20:11434/);
  assert.match(lines[0], /loopback or local-network address/);
  assert.match(lines[1], /localhost/);
  assert.deepEqual(localNetworkLines([{ kind: 'network', detail: 'radio.garden' }]), []);
});
