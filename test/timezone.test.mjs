// Timezone validation regression tests -- against the REAL production helper
// (audit 2026-10-24 finding: the previous version re-implemented
// isValidTimeZone inline three times and never imported the production
// function, so the tests passed while production behavior diverged).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('timezone');

const { isValidTimeZone, toLocalISOString } = await import('../src/lib/time.js');
const { currentLocalTimeString, currentLocalDateString } = await import('../src/director/weather.js');

describe('timezone validation (production helpers)', () => {
  test('valid IANA zones and UTC accepted', () => {
    assert.ok(isValidTimeZone('Europe/Ljubljana'));
    assert.ok(isValidTimeZone('UTC'));
    assert.ok(isValidTimeZone('America/New_York'));
    assert.ok(isValidTimeZone('Asia/Tokyo'));
  });

  test('invalid zones, empties and non-strings rejected', () => {
    assert.ok(!isValidTimeZone('INVALID_TZ_XYZ'));
    assert.ok(!isValidTimeZone('TBD')); // the value shipped in config.example.json at audit time
    assert.ok(!isValidTimeZone(''));
    assert.ok(!isValidTimeZone('   '));
    assert.ok(!isValidTimeZone(null));
    assert.ok(!isValidTimeZone(undefined));
    assert.ok(!isValidTimeZone(42));
  });

  test('toLocalISOString uses the configured zone when valid', () => {
    const iso = toLocalISOString(new Date('2026-10-24T12:00:00Z'), 'Europe/Ljubljana');
    assert.match(iso, /\+02:00$/); // CEST in October (DST ends 2026-10-25)
  });

  test('toLocalISOString falls back to UTC and logs for invalid zones', () => {
    const err = console.error;
    let logged = '';
    console.error = (m) => (logged = String(m));
    try {
      const iso = toLocalISOString(new Date('2026-10-24T12:00:00Z'), 'TBD');
      assert.match(iso, /Z$/); // UTC instant, not a shifted offset
      assert.match(logged, /invalid config\.weather\.timezone/);
    } finally {
      console.error = err;
    }
  });

  test('spoken time/date formatters survive an invalid zone (UTC fallback, no crash)', () => {
    assert.doesNotThrow(() => currentLocalTimeString('TBD'));
    assert.doesNotThrow(() => currentLocalDateString(''));
    assert.match(currentLocalTimeString('Europe/Ljubljana'), /^\d{1,2}:\d{2}(\s?[AP]M)?$/);
  });
});
