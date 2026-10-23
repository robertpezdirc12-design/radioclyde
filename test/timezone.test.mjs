import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('timezone validation', () => {
  function isValidTimeZone(tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch (e) {
      return false;
    }
  }

  test('valid IANA timezones', () => {
    assert.ok(isValidTimeZone('Europe/Ljubljana'));
    assert.ok(isValidTimeZone('UTC'));
    assert.ok(isValidTimeZone('America/New_York'));
    assert.ok(isValidTimeZone('Asia/Tokyo'));
  });

  test('invalid timezones return false', () => {
    assert.ok(!isValidTimeZone('INVALID_TZ_XYZ'));
    assert.ok(!isValidTimeZone(''));
    assert.ok(!isValidTimeZone(null));
    assert.ok(!isValidTimeZone('Not/A/Timezone'));
  });
});
