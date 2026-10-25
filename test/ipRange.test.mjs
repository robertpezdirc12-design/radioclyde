// lib/ipRange.js -- the trustedNetworks allowlist matcher auth.js's onRequest
// hook runs before ANYTHING else, so a throwing entry here 500s every request
// on the station (Task 11-P1: one non-string config entry did exactly that
// via cidr.split). These tests pin the defensive filter + the matching basics.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { isTrustedIp } = await import('../src/lib/ipRange.js');

describe('isTrustedIp (junk config never throws)', () => {
  test('non-string entries are ignored, not fatal -- even mid-list', () => {
    const junk = [null, undefined, 42, ['10.0.0.0/8'], { cidr: '10.0.0.0/8' }, () => {}, '10.0.0.0/8'];
    assert.doesNotThrow(() => isTrustedIp('10.1.2.3', junk));
    assert.equal(isTrustedIp('10.1.2.3', junk), true, 'the one real CIDR still matches');
    assert.equal(isTrustedIp('192.0.2.9', junk), false, 'outside the real CIDR, no accidental trust');
  });

  test('all-junk list neither throws nor trusts', () => {
    assert.doesNotThrow(() => isTrustedIp('10.1.2.3', [null, 42, {}]));
    assert.equal(isTrustedIp('10.1.2.3', [null, 42, {}]), false);
  });

  test('junk STRING entries stay safely non-matching (pre-existing behavior)', () => {
    assert.doesNotThrow(() => isTrustedIp('10.1.2.3', ['banana', '']));
    assert.equal(isTrustedIp('10.1.2.3', ['banana']), false);
  });
});

describe('isTrustedIp (matching basics)', () => {
  test('loopback is always trusted, no list needed', () => {
    assert.equal(isTrustedIp('127.0.0.1'), true);
    assert.equal(isTrustedIp('127.0.0.1', []), true);
    assert.equal(isTrustedIp('::1', []), true);
  });

  test('CIDR /32, /24 and IPv4-mapped IPv6 forms', () => {
    assert.equal(isTrustedIp('192.168.1.9', ['192.168.1.9']), true, 'bare IP = /32');
    assert.equal(isTrustedIp('192.168.1.10', ['192.168.1.9']), false);
    assert.equal(isTrustedIp('192.168.1.50', ['192.168.1.0/24']), true);
    assert.equal(isTrustedIp('192.168.2.50', ['192.168.1.0/24']), false);
    assert.equal(isTrustedIp('::ffff:192.168.1.50', ['192.168.1.0/24']), true, 'dual-stack listener form');
  });

  test('/0 trusts everything, untrusted default is false', () => {
    assert.equal(isTrustedIp('203.0.113.5', ['0.0.0.0/0']), true);
    assert.equal(isTrustedIp('203.0.113.5', []), false);
  });
});
