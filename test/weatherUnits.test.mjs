// Tests for the metric-units contract of the station's weather fetch
// (Paket A2, docs/programming-research.md §5): a Slovenian station's spoken
// weather must say °C and km/h, not °F and mph.
//   A. behavioral: fetchCurrentWeather() with NO arguments asks Open-Meteo
//      for celsius + kmh (the defaults the live weather line relies on --
//      auto/liveLines.js consumes the same fetch), while an explicit
//      override is still honored: the unit params are passthrough, never
//      forced,
//   B. (Val 28) the old AI live-segment fact-line structural pin is gone
//      with the AI layer -- the spoken weather line is rendered by the
//      Slovenian templates (auto/liveLines.js), whose own units pins live
//      in test/voiceRegister.test.mjs and test/weatherOffline.test.mjs.
// No real network anywhere: globalThis.fetch is stubbed per test and
// restored in a finally. /api/weather is deliberately NOT tested here -- it
// passes its own temperatureUnit from config.weather.temperatureUnit
// (server/weatherApi.js) and its behavior is unchanged by the default.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('weather-units', {});

const { fetchCurrentWeather } = await import('../src/director/weather.js');

// The minimal Open-Meteo `current` payload the stub answers with -- same
// shape weatherOffline.test.mjs stubs for the auto path.
const STUB_CURRENT = { temperature_2m: 21.4, weather_code: 0, wind_speed_10m: 3.2 };

function stubFetch(captured) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    captured.url = String(url);
    return { ok: true, json: async () => ({ current: STUB_CURRENT }) };
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe('fetchCurrentWeather unit defaults (behavioral)', () => {
  test('no args -> Open-Meteo is asked for celsius and kmh', async () => {
    const captured = {};
    const restore = stubFetch(captured);
    try {
      const current = await fetchCurrentWeather();
      assert.deepEqual(current, STUB_CURRENT, 'returns the current-conditions object untouched');
      assert.match(captured.url, /temperature_unit=celsius/, `temperature_unit must default to celsius: ${captured.url}`);
      assert.match(captured.url, /wind_speed_unit=kmh/, `wind_speed_unit must default to kmh: ${captured.url}`);
      assert.doesNotMatch(captured.url, /fahrenheit/);
      assert.doesNotMatch(captured.url, /wind_speed_unit=mph/);
    } finally {
      restore();
    }
  });

  test('explicit overrides are still respected (passthrough, not forced)', async () => {
    const captured = {};
    const restore = stubFetch(captured);
    try {
      await fetchCurrentWeather({ temperatureUnit: 'fahrenheit', windSpeedUnit: 'mph' });
      assert.match(captured.url, /temperature_unit=fahrenheit/, `explicit fahrenheit must pass through: ${captured.url}`);
      assert.match(captured.url, /wind_speed_unit=mph/, `explicit mph must pass through: ${captured.url}`);
      assert.doesNotMatch(captured.url, /temperature_unit=celsius/);
      assert.doesNotMatch(captured.url, /wind_speed_unit=kmh/);
    } finally {
      restore();
    }
  });
});
