import { config } from '../config/index.js';
import { complete } from '../llm/client.js';
import { PARALINGUISTIC_INSTRUCTION, TIME_OF_DAY_INSTRUCTION } from '../llm/prompts.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { fetchCurrentWeather, describeWeatherCode, currentLocalTimeString, currentLocalDateString } from './weather.js';
import { autoRadioEnabled } from '../auto/voice.js';
import { resolveLiveLineAuto, resolveNextShowValues } from '../auto/liveLines.js';
import { renderSlot, currentValues } from '../auto/templates.js';
import { formatCalendarDate } from '../lib/time.js';

// Real data first (deterministic fetch, or the server clock for time --
// no network call, per script-format.md), THEN one small tool-free
// completion turns it into a spoken line shaped by the segment's `brief`.
//
// autoRadio mode keeps "real data first" and drops the completion: the fact
// set is dropped into the station's configured live template
// (auto/liveLines.js -> auto/templates.js), with the weather code described
// in Slovenian from the same WMO table mapping. Same facts, no model.
//
// `occurrence` ({ show, weekday, date, timeKey }, director/index.js's own
// directShow arguments) is the occurrence identity the nextShow kind needs;
// the time/weather kinds ignore it entirely.
export async function resolveLiveLine({ persona, kind, brief }, occurrence = null) {
  if (autoRadioEnabled()) {
    return resolveLiveLineAuto({ persona, kind, brief, occurrence });
  }

  const facts = [];
  if (kind === 'time' || kind === 'time-weather') {
    facts.push(`Current local date: ${currentLocalDateString(config.weather.timezone)}. Current local time: ${currentLocalTimeString(config.weather.timezone)}.`);
  }
  if (kind === 'weather' || kind === 'time-weather') {
    const current = await fetchCurrentWeather();
    facts.push(
      `Current conditions: ${describeWeatherCode(current.weather_code)}, ${Math.round(current.temperature_2m)}°C, wind ${Math.round(current.wind_speed_10m)} km/h.`
    );
  }
  // Paket B1: the closing next-show announcement. The schedule is resolved
  // HERE, at direct time, from the occurrence identity (auto/liveLines.js's
  // resolveNextShowValues -- the same shared resolver the auto path uses, so
  // AI and autoRadio can never disagree about who is next). An unresolvable
  // answer (no occurrence identity, schedule edited away, nothing programmed)
  // returns EARLY with the honest offline pool -- no LLM call, no invented
  // day/time/show (the P4 #29 lesson: directShow awaits this with no retry,
  // so a throw would abort the whole occurrence). A healthy answer becomes
  // one English fact below and falls through to the shared complete() call.
  if (kind === 'nextShow') {
    const resolved = await resolveNextShowValues(occurrence);
    if (resolved.offline) {
      return renderSlot('live:nextShowOffline', { values: currentValues(), seed: 'live|nextShowOffline' });
    }
    const v = resolved.values;
    facts.push(
      `Next show on the schedule: "${v.nextShow}"${v.nextHost ? `, hosted by ${v.nextHost}` : ''}, starts ${formatCalendarDate(v.nextDateKey)} at ${v.nextTime}.`
    );
    // Naming the day/time here is covered: the system prompt below says
    // "using ONLY the real data given below", and TIME_OF_DAY_INSTRUCTION's
    // carve-out ("unless the real data you were given states it explicitly")
    // permits speaking a day/time the fact actually states.
  }

  const personaPrompt = loadPersonas()[persona]?.systemPrompt ?? DEFAULT_PERSONA_PROMPT(persona);
  const messages = [
    {
      role: 'system',
      content: [
        personaPrompt,
        '',
        `Speak a short live segment using ONLY the real data given below -- don't invent any other facts.`,
        `Direction: ${brief}`,
        'Speak it exactly as it should be said -- no stage directions, no meta-commentary, no quotation marks.',
        PARALINGUISTIC_INSTRUCTION,
        TIME_OF_DAY_INSTRUCTION,
      ].join('\n'),
    },
    { role: 'user', content: facts.join(' ') },
  ];
  return complete(messages);
}
