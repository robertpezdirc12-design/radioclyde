// Template-based live-segment lines -- the no-AI counterpart to
// director/liveSegments.js's LLM completion. Real data first (the same
// deterministic fetch + server clock the AI path uses), then the fact set is
// dropped into the station's configured template (auto/templates.js's
// "live" slots) instead of being handed to a model to phrase.
import { fetchCurrentWeather } from '../director/weather.js';
import { createLogger } from '../lib/logger.js';
import { renderSlot, currentValues, slovenianWeatherDescription } from './templates.js';

const log = createLogger('station');

export async function resolveLiveLineAuto({ persona, kind }) {
  const base = currentValues();
  if (kind === 'time') {
    return renderSlot('live:time', { values: base, seed: `${persona}|live|time|${base.time}` });
  }

  // P4 #29 "vreme brez omrežja": directShow() awaits this resolver with no
  // retry -- a dead Open-Meteo used to THROW here and abort the whole
  // occurrence (no playlist.m3u, dead air until the next scheduled show;
  // the same failure that froze the queue before weather.js got its
  // timeout). Now the failure resolves to the honest offline line instead:
  // the local clock is the only fact left, no condition/temperature is
  // invented, and the handoff's promise ("vremenska napoved sledi") is
  // still kept -- just by the station's own tone.
  let current = null;
  try {
    current = await fetchCurrentWeather({ temperatureUnit: 'celsius', windSpeedUnit: 'kmh' });
  } catch (err) {
    log(`live/weather: fetch failed (${err.message}) -- honest offline line (P4 #29).`);
    return renderSlot('live:weatherOffline', {
      values: base,
      seed: `${persona}|live|weatherOffline|${base.time}`,
    });
  }
  const values = {
    ...base,
    temp: Math.round(current.temperature_2m),
    wind: Math.round(current.wind_speed_10m),
    condition: slovenianWeatherDescription(current.weather_code),
  };

  return renderSlot(`live:${kind}`, { values, seed: `${persona}|live|${kind}|${base.time}|${current.temperature_2m}` });
}
