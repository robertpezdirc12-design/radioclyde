// Tests for the metric-units switch in the AI live weather path (Paket A2,
// docs/programming-research.md §5): a Slovenian station's spoken weather
// must say °C and km/h, not °F and mph.
//   A. behavioral: fetchCurrentWeather() with NO arguments asks Open-Meteo
//      for celsius + kmh (the defaults the AI live segments rely on --
//      director/liveSegments.js calls it bare), while an explicit override
//      is still honored: the unit params are passthrough, never forced,
//   B. structural pin: director/liveSegments.js's weather FACT LINE labels
//      the numbers °C / km/h and never °F / mph -- the auto-radio path
//      already spoke metric via its Slovenian templates (auto/liveLines.js
//      passes celsius/kmh explicitly, templates read "°C"/"km/h" literally),
//      and this pin keeps the AI path's labels from drifting back.
// No real network anywhere: globalThis.fetch is stubbed per test and
// restored in a finally. /api/weather is deliberately NOT tested here -- it
// passes its own temperatureUnit from config.weather.temperatureUnit
// (server/weatherApi.js) and its behavior is unchanged by the default.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

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

describe('AI live-segment fact line labels (structural pin)', () => {
  test('the weather fact line speaks °C and km/h, never °F or mph', () => {
    const src = fs.readFileSync(path.join(repoRoot(), 'src', 'director', 'liveSegments.js'), 'utf8');
    // Strip //-comments conservatively -- whole comment LINES only, so the
    // module's header may keep DISCUSSING units without tripping the pin,
    // and no string content (the fact line is a template literal) is touched.
    const code = src
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/.*$/, ''))
      .join('\n');
    const factLine = code.match(/Current conditions:[^\n]*/)?.[0] ?? '';
    assert.ok(factLine, 'the AI weather fact line must exist in liveSegments.js');
    assert.ok(factLine.includes('°C'), `fact line must label the temperature in °C: ${factLine}`);
    assert.ok(factLine.includes('km/h'), `fact line must label the wind in km/h: ${factLine}`);
    assert.ok(!factLine.includes('°F'), `fact line must not label °F: ${factLine}`);
    assert.ok(!factLine.includes('mph'), `fact line must not label mph: ${factLine}`);
  });
});
