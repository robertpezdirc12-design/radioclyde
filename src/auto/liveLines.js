// Template-based live-segment lines -- the no-AI counterpart to
// director/liveSegments.js's LLM completion. Real data first (the same
// deterministic fetch + server clock the AI path uses), then the fact set is
// dropped into the station's configured template (auto/templates.js's
// "live" slots) instead of being handed to a model to phrase.
import { fetchCurrentWeather } from '../director/weather.js';
import { renderSlot, currentValues, slovenianWeatherDescription } from './templates.js';

export async function resolveLiveLineAuto({ persona, kind }) {
  const base = currentValues();
  if (kind === 'time') {
    return renderSlot('live:time', { values: base, seed: `${persona}|live|time|${base.time}` });
  }

  const current = await fetchCurrentWeather({ temperatureUnit: 'celsius', windSpeedUnit: 'kmh' });
  const values = {
    ...base,
    temp: Math.round(current.temperature_2m),
    wind: Math.round(current.wind_speed_10m),
    condition: slovenianWeatherDescription(current.weather_code),
  };

  return renderSlot(`live:${kind}`, { values, seed: `${persona}|live|${kind}|${base.time}|${current.temperature_2m}` });
}
