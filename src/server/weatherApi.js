import { fetchCurrentWeather, describeWeatherCode } from '../director/weather.js';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('web');

// Conditions don't meaningfully change faster than this, and Open-Meteo is a
// free, unauthenticated API -- no reason to hit it on every client's 12s
// now-playing-style poll cycle.
const CACHE_TTL_MS = 10 * 60 * 1000;
// Negative cache: once Open-Meteo fails, don't re-attempt on EVERY 12 s poll
// until the TTL expires -- a dead upstream would otherwise take one full
// request per client per tick. The stale cache keeps serving; a fresh attempt
// is allowed at most this often while the failure persists.
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

let cached = null; // { temperatureF, temperatureC, condition } | null
let cachedAt = 0;
let lastFailedAt = 0;

// The station's own unit preference decides which value is the MEASUREMENT
// and which is derived: config.weather.temperatureUnit (already read by the
// linux deploy config, previously by no code path at all). "celsius" makes
// temperatureC the measured value -- which also removes the old double-
// rounding error of deriving C from an already-rounded F. The public page's
// chip reads temperatureC either way (public/app.js), so a Slovenian station
// now shows a true celsius measurement, not an F->C conversion artifact.
function stationTemperatureUnit() {
  return config.weather?.temperatureUnit === 'celsius' ? 'celsius' : 'fahrenheit';
}

export function registerWeatherRoute(fastify) {
  fastify.get('/api/weather', async () => {
    const now = Date.now();
    const fresh = cached && now - cachedAt <= CACHE_TTL_MS;
    const backingOff = now - lastFailedAt < RETRY_AFTER_FAILURE_MS;
    if (!fresh && !backingOff) {
      try {
        const unit = stationTemperatureUnit();
        const current = await fetchCurrentWeather({ temperatureUnit: unit });
        const t = Number(current.temperature_2m);
        cached =
          unit === 'celsius'
            ? {
                temperatureC: Math.round(t),
                temperatureF: Math.round((t * 9) / 5 + 32),
                condition: describeWeatherCode(current.weather_code),
              }
            : {
                temperatureF: Math.round(t),
                temperatureC: Math.round(((t - 32) * 5) / 9),
                condition: describeWeatherCode(current.weather_code),
              };
        cachedAt = now;
        lastFailedAt = 0;
      } catch (err) {
        log(`/api/weather: fetch failed: ${err.message}`);
        lastFailedAt = now;
        if (!cached) throw err; // nothing to serve -- let it 500, same as any other transient failure
      }
    }
    return cached;
  });
}
