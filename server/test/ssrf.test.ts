import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl, SsrfError } from '../src/ssrf.js';

test('isPrivateIp: classifies loopback, private and link-local IPv4', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('172.32.0.1'), false); // just outside the 172.16/12 block
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('169.254.1.1'), true);
  assert.equal(isPrivateIp('0.0.0.0'), true);
});

test('isPrivateIp: a normal public IPv4 is not private', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('isPrivateIp: classifies IPv6 loopback, unique-local and link-local', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true); // IPv4-mapped loopback
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false); // Google DNS, public
});

test('assertPublicUrl: refuses non-http(s) schemes', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com/x'), SsrfError);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), SsrfError);
});

test('assertPublicUrl: refuses a literal private IP without a DNS lookup', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:3003/api/share/x'), SsrfError);
  await assert.rejects(() => assertPublicUrl('http://192.168.1.1/x'), SsrfError);
});

test('assertPublicUrl: allowPrivate lets a private literal IP through', async () => {
  const url = await assertPublicUrl('http://127.0.0.1:3003/api/share/x', true);
  assert.equal(url.hostname, '127.0.0.1');
});

test('isPrivateIp: carrier NAT, benchmarking, protocol, multicast and reserved IPv4', () => {
  for (const ip of ['100.64.0.1', '100.127.255.254', '198.18.0.1', '198.19.255.255', '192.0.0.8', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['100.63.255.255', '100.128.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('isPrivateIp: IPv6 forms that carry a private IPv4 address', () => {
  for (const ip of [
    '2002:7f00:1::', '2002:a00:1::1', '2002:c0a8:101::', '2002:a9fe:a9fe::1', // 6to4 of 127.0.0.1, 10.0.0.1, 192.168.1.1, 169.254.169.254
    '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe',            // NAT64
    '::7f00:1', '::127.0.0.1', '::10.0.0.1', '::a9fe:a9fe',                   // IPv4-compatible
    '::ffff:7f00:1', '::ffff:192.168.0.1',                                    // mapped
    'ff02::1',
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['2002:808:808::1', '64:ff9b::808:808', '::ffff:8.8.8.8', '::808:808', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});
