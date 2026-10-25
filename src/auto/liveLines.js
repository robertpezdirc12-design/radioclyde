// Template-based live-segment lines -- the no-AI counterpart to
// director/liveSegments.js's LLM completion. Real data first (the same
// deterministic fetch + server clock the AI path uses), then the fact set is
// dropped into the station's configured template (auto/templates.js's
// "live" slots) instead of being handed to a model to phrase.
import { fetchCurrentWeather } from '../director/weather.js';
import { createLogger } from '../lib/logger.js';
import { renderSlot, currentValues, slovenianWeatherDescription } from './templates.js';
import { loadSchedule, nextOccurrence, timeKey, dateKey, absoluteStart } from '../scheduler/scheduleUtil.js';
// resolveShowInfo (the brief's H1 title + capitalized primaryPersona) -- the
// exact import scheduler/pushDispatch.js:14 already makes, so the closing
// announcement, the push notification and /api/schedule all resolve one name
// per show ("Markec Podkast", never "markec-podkast").
import { resolveShowInfo } from '../server/showName.js';
import { slovenianDayLabel } from '../lib/time.js';

const log = createLogger('station');

export async function resolveLiveLineAuto({ persona, kind, occurrence = null }) {
  const base = currentValues();
  // Paket B1 (docs/programming-research.md §5): the closing next-show
  // announcement, resolved at DIRECT time from station.json's schedule --
  // never at script time, because same-day repeats share one script.md AND
  // one dj-audio cache, so a script-time "next show" would name a show that
  // already aired on the re-run. Unresolvable -> the honest offline pool
  // (weatherOffline's sibling, P4 #29 discipline: no invented day, time or
  // show). The online seed is the RESOLVED day+time, not the wall clock --
  // same schedule state = same line = reproducible transcripts (the weather
  // branch below keeps its wall-clock seed on purpose: its data IS the
  // wall clock).
  if (kind === 'nextShow') {
    const resolved = await resolveNextShowValues(occurrence);
    if (resolved.offline) {
      log(`live/nextShow: ${resolved.reason} -- honest offline line.`);
      return renderSlot('live:nextShowOffline', { values: base, seed: `${persona}|live|nextShowOffline` });
    }
    return renderSlot('live:nextShow', {
      values: { ...base, ...resolved.values },
      seed: `${persona}|live|nextShow|${resolved.values.nextDateKey}|${resolved.values.nextTime}`,
    });
  }

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

// The ONE shared next-show resolver (both the auto path above and the AI
// path in director/liveSegments.js import it, so the two modes can never
// disagree about who is next). `occurrence` is the occurrence identity the
// director threads in ({ show, weekday, date, timeKey }); anything less is
// honestly unresolvable. Never throws -- every failure resolves to
// { offline: true, reason } and the callers degrade to the honest offline
// line (the P4 #29 lesson: directShow awaits this with no retry, so a
// throw would abort the whole occurrence).
//
// A downtime gap does NOT change who is next: hasGap only tells
// updateNowPlaying to wait for wall-clock instead of cutting over early --
// the announcement simply speaks the next show's day+time honestly, and
// nextOccurrence already walks dark days correctly (scheduleUtil.js:398-409).
export async function resolveNextShowValues(occurrence) {
  try {
    if (!occurrence?.weekday || !occurrence?.date || !occurrence?.timeKey) {
      return { offline: true, reason: 'no occurrence identity (standalone caller?)' };
    }
    const schedule = loadSchedule();
    const entry = (schedule[occurrence.weekday] ?? []).find((s) => timeKey(s.startTime) === occurrence.timeKey);
    if (!entry) return { offline: true, reason: 'timeKey no longer in the schedule (edited after direction?)' };
    const next = nextOccurrence(schedule, { show: entry, weekday: occurrence.weekday, date: occurrence.date, timeKey: occurrence.timeKey });
    if (!next) return { offline: true, reason: 'no next show in the next 7 days' };
    const { name, host } = resolveShowInfo(next.show, next.show.specialTitle ?? next.show.id);
    // Nominal-END reference: a show crossing midnight must label the next
    // morning show "danes" -- that is what the listener hears when the line
    // airs (absoluteStart exported for exactly this, scheduleUtil.js:200-214).
    const nominalEndMs = absoluteStart(occurrence.date, entry.startTime) + entry.durationMinutes * 60_000;
    const referenceKey = dateKey(new Date(nominalEndMs));
    const dayWord = slovenianDayLabel(next.date, referenceKey);
    // nextDayWord CAN be null (unparseable keys -- practically impossible
    // here, since both keys come from scheduleUtil itself). Chosen policy:
    // let it ride into the values; the auto render's substitute() blanks a
    // null (templates.js substitute()), so the worst case is a line that
    // names the show and time without the day word -- still honest, never
    // a fabricated day. The AI path only reads nextShow/nextHost/nextDateKey/
    // nextTime, so it is unaffected by a null day word.
    return { offline: false, values: { nextShow: name, nextHost: host, nextTime: next.show.startTime, nextDayWord: dayWord, nextDateKey: next.date } };
  } catch (err) {
    return { offline: true, reason: err.message };
  }
}
