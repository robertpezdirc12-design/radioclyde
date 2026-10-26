#!/usr/bin/env node
// Format clock (Paket D1, docs/programming-research.md §5): the station's
// hourly template, spoken OVER the music as BEDS. Professional radio runs a
// "format clock" -- fixed minute marks in every hour carry fixed rubrics
// (weather at :15/:45, the next-show handoff N minutes before the switch).
// Radio Markec already owns the entire broadcast machinery: radio.liq's
// request.queue(id="beds") + sidechain ducker (P3 #13) mix a pushed clip over
// the program at 0.2 while it sounds, and src/liquidsoap/bedQueue.js is the
// Node half of that telnet contract. What was missing is exactly what
// docs/imaging-layer.md:27 called "samodejna produkcija -> postelja je ločena
// prihodnja odločitev" -- THIS job is that decision.
//
// Two event kinds, one engine:
//   weather  -- wall-clock minute marks (config.imaging.beds.weatherMinutes,
//               default [15, 45]): fetchCurrentWeather() at PRODUCE time
//               (Open-Meteo, °C/km/h -- the same live source the AI/auto
//               live segments use, director/weather.js), renderSlot('bedWeather'),
//               Edge TTS, one ebur128 pass, gain BAKED into the bytes.
//   nextshow -- every upcoming occurrence (incl. replays -- a rebroadcast is
//               a real airing): fire at absoluteStart - nextShowLeadMinutes,
//               text from the show's brief via resolveShowInfo (the /api/schedule
//               display-name precedent), renderSlot('bedNextShow').
//
// Timing model (push/dispatch.js's due-window + ledger pattern, ported from
// minutes to seconds): a tick every tickIntervalMinutes (default 0.1 = 6 s,
// fractional cadence is cadence()-legal -- nowPlayingCheckIntervalMinutes
// already runs 0.1) computes every event's fireTime. An event FIRES on the
// first tick inside [fireTime, fireTime + FIRE_WINDOW_MS); later ticks see
// the ledger key and do nothing, and a slot whose window closed while the
// process was down is skipped honestly -- a weather report two minutes late
// is not a weather report, it is a lie about the clock. An event is PRODUCED
// when fireTime - now <= produceLeadMinutes (default 4) and the clip does not
// exist yet: production happens BEFORE the minute so the fire action itself
// is a local file push (milliseconds), never a network call at air time.
// The deterministic clip name IS the re-work guard (promoProducer's
// "the produced artifact is the marker" philosophy).
//
// Honest degradation ladder (every rung tested):
//   - imaging.beds.enabled !== true -> { skipped: true }, scheduler does not
//     even register the tick (a layer that SPEAKS on air must never appear
//     unannounced on an existing install -- the promos OPT-IN rule);
//   - Open-Meteo down / no temperature -> no clip, no fire, one log line,
//     next slot retries (P4 #29 ground rules: no fabricated numbers);
//   - Edge TTS down -> clip never lands -> the slot fires nothing (the bed
//     layer is simply absent, never a hole in the program);
//   - ebur128/ffmpeg fail -> the clip lands UNMEASURED (a slightly-off-level
//     bed beats no bed; radio.liq's compress() still catches the peaks);
//   - Liquidsoap refuses the push (or the install template has no beds
//     wiring) -> the refusal is logged verbatim, the key is still recorded
//     (one attempt per slot -- retrying every 6 s against a dead telnet would
//     be spam, and Liquidsoap down means bigger problems than a missed bed).
//
// Dayparting (Val 25): weather rubrics can be windowed with
// config.imaging.beds.weatherDaypart {from,to} (the filler wheel's daypart
// semantics verbatim: strict zero-padded HH:MM + the "24:00" sentinel, from
// inclusive / to exclusive, no midnight wrap) so the night stays quiet --
// the shipped default is NO window (absent or junk -> every mark fires,
// existing installs keep their behavior). nextshow events are deliberately
// never windowed: a show boundary matters at any hour, and a night without
// shows generates no events to gate in the first place.
//
// Manual beds (Val 25): triggerBed() below is the operator's hands -- one
// FRESH clip produced and pushed NOW (weather: conditions at trigger time;
// nextshow: the next upcoming occurrence, or a specific show's). It honors
// ONLY the master OPT-IN gate: the schedule knobs (weatherMinutes,
// weatherDaypart) shape the AUTOMATIC clock, and an explicit manual action
// is exactly the override those knobs exist to be overridden by.
//
// Like every imaging-family module: 0 new dependencies, atomic tmp+rename
// everywhere (tmp names NEVER end in an audio extension), and the operator's
// hand-placed files are untouchable -- see the load-bearing comment at
// pruneStaleBedClips().
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { loadSchedule, upcomingOccurrences, absoluteStart, dateKey } from './scheduleUtil.js';
// parseWheelTime: the ONE source of truth for the HH:MM daypart-window
// convention (clockwheel.js dayparts parse with the identical function -- a
// station must never grow two subtly-different time-window grammars).
import { parseWheelTime } from './clockwheel.js';
import { resolveShowInfo } from '../server/showName.js';
// slovenianDayLabel: 'danes'/'jutri'/'v <dan>' RELATIVE TO THE FIRE MOMENT --
// the clip is produced minutes before it fires, so the day word must be
// anchored to the fire date, never the produce date (lib/time.js contract).
import { slovenianDayLabel } from '../lib/time.js';
import { renderSlot, stationName, slovenianWeatherDescription } from '../auto/templates.js';
import { synthesizeWithEdge } from '../auto/edgeTts.js';
import { fetchCurrentWeather } from '../director/weather.js';
import { analyzeTrack, amplifyDbFor } from '../lib/autocue.js';
import { pushBedFile } from '../liquidsoap/bedQueue.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

// promoProducer.js's discipline, verbatim in spirit: a wedged ffmpeg must
// never hang the tick and a long stderr must never look like "ffmpeg failed".
const FFMPEG_TIMEOUT_MS = 60_000;
const FFMPEG_MAX_BUFFER = 32 * 1024 * 1024;

// How long after fireTime an unfired slot still counts as fireable. Sized
// against the default 6 s tick: ~7 chances under a lagging event loop, and
// past it the slot is honestly late -- the weather of :15 aired at :16 is a
// lie about the clock. Also the restart-tolerance window: a process that
// comes back INSIDE the window still fires (the ledger keeps the no-double
// promise), one that comes back after it does not.
const FIRE_WINDOW_MS = 45_000;

// Fired-slot idempotence ledger, push/dispatch.js's sent.jsonl pattern
// (date@time@what keys, JSONL append, count-based prune): a restart mid-slot
// must not re-say a bed, and a hand-rerun of the CLI must not either.
const FIRED_LEDGER_MAX = 20_000;
const FIRED_LEDGER_KEEP = 10_000;

// ONLY filenames matching this pattern are ever removed by this job. See the
// load-bearing comment at pruneStaleBedClips(). Two shapes share it:
// weather clips have NO middle segment (weather_<date>_<HH-MM>.mp3),
// nextshow clips carry the show id (nextshow_<id>_<date>_<HH-MM>.mp3) --
// hence the OPTIONAL (?:_.+)? segment. Caught by the unit suite before it
// ever reached a real station: the promo-shaped pattern (mandatory _.+)
// never matched the weather names, so weather clips would have accumulated
// forever. Greedy .+ + right-anchored date/time groups bind from the RIGHT
// end of the name, so show ids containing date-like text stay unambiguous.
// EXPORTED since Val 26: doctor's beds check counts stale generated clips
// through THIS pattern (injected as a seam by doctorCli) -- the doctor must
// never grow a second copy of the operator-file exclusion rule.
export const GENERATED_BED_RE = /^(weather|nextshow)(?:_.+)?_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/;

const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// config resolution (F2 discipline, cadence()'s exact semantics: absent or
// junk falls back to the shipped default, only deliberate values change
// behavior; the one deliberate OFF value per knob is documented in
// docs/imaging-layer.md)
// ---------------------------------------------------------------------------

export function bedSettings() {
  const beds = config.imaging?.beds ?? {};
  const produceLeadMinutes = Number(beds.produceLeadMinutes ?? 4);
  const retentionHours = beds.clipRetentionHours;
  return {
    weatherMinutes: weatherMinutesSetting(beds),
    weatherDaypart: weatherDaypartSetting(beds),
    produceLeadMs:
      Number.isFinite(produceLeadMinutes) && produceLeadMinutes > 0 ? produceLeadMinutes * 60_000 : 4 * 60_000,
    // 0 = keep forever (archive retention's documented semantics); junk =
    // the shipped default, never an invented sweep.
    clipRetentionMs:
      retentionHours === 0
        ? Infinity
        : Number.isFinite(retentionHours) && retentionHours > 0
          ? retentionHours * 3600_000
          : 2 * 3600_000,
    persona: beds.persona ?? null,
  };
}

// Minute marks: absent or junk (non-array) -> the shipped [15, 45]; an
// EXPLICIT empty array is the honest "weather off" switch (the owner runs
// nextshow-only format clocks too); valid entries are integers in [0, 59],
// duplicates collapse (a mark listed twice is one slot).
function weatherMinutesSetting(beds) {
  const raw = beds.weatherMinutes;
  if (raw === undefined || !Array.isArray(raw)) return [15, 45];
  return [...new Set(raw.filter((m) => Number.isInteger(m) && m >= 0 && m < 60))].sort((a, b) => a - b);
}

// Daypart window for the weather rubric (Val 25) -- the module header has
// the full contract. Absent/junk -> null (always active, the shipped
// default); valid -> { fromMin, toMin }. Exported because the tests pin the
// F2 semantics directly, same as weatherMinutesSetting via bedSettings().
export function weatherDaypartSetting(beds) {
  const raw = beds?.weatherDaypart;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fromMin = parseWheelTime(raw.from);
  const toMin = parseWheelTime(raw.to);
  if (fromMin == null || toMin == null || toMin <= fromMin) return null;
  return { fromMin, toMin };
}

// The slot's MINUTE OF DAY decides (from inclusive, to exclusive -- the
// wheel's exact comparison, clockwheel.js:132-134): a :45 mark with
// to "22:30" is already outside while to "23:00" keeps it. Judged on the
// RESOLVED slot, so the next-hour roll at 05:58 lands on 06:15 and reads as
// morning, and DST cannot bend a minute-of-day comparison.
export function weatherSlotActive(slot, daypart) {
  if (!daypart) return true;
  const minuteOfDay = slot.getHours() * 60 + slot.getMinutes();
  return minuteOfDay >= daypart.fromMin && minuteOfDay < daypart.toMin;
}

function nextShowLeadMinutes() {
  const raw = config.imaging?.beds?.nextShowLeadMinutes;
  // 0 = the nextshow bed is OFF: announcing a show AS it starts is the
  // show's own opening line, not a format-clock element. Absent/junk -> the
  // shipped default (cadence()'s refusal semantics, never a silent OFF).
  if (raw === 0) return null;
  const lead = Number(raw ?? 5);
  return Number.isFinite(lead) && lead > 0 ? lead : 5;
}

// ---------------------------------------------------------------------------
// ledger (push/dispatch.js's sent.jsonl, same shapes)
// ---------------------------------------------------------------------------

export function loadFiredKeys({ filePath = null } = {}) {
  const target = filePath ?? config.paths.bedsFiredLedgerFile;
  const keys = new Set();
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return keys; // no ledger yet (fresh install) -- every slot is unfired
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.key === 'string') keys.add(parsed.key);
    } catch {
      // Torn line (the JSONL pattern): skip, don't crash the tick.
    }
  }
  return keys;
}

export function recordFiredKey(key, { filePath = null, firedAt = null } = {}) {
  const target = filePath ?? config.paths.bedsFiredLedgerFile;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify({ key, firedAt: firedAt ?? new Date().toISOString() })}\n`);
}

// Same shape and reason as push/dispatch.js's pruneSentLedger: append-only
// ledgers grow forever, ~60 keys/day here, so past MAX a rewrite keeps the
// newest KEEP -- oldest-first drop is exactly the idempotence window the
// ledger exists for. Atomic tmp+rename like every rewrite in this repo.
export function pruneFiredLedger({ filePath = null } = {}) {
  const target = filePath ?? config.paths.bedsFiredLedgerFile;
  if (!fs.existsSync(target)) return 0;
  const lines = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length <= FIRED_LEDGER_MAX) return 0;
  const kept = lines.slice(-FIRED_LEDGER_KEEP);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, kept.join('\n') + '\n');
  fs.renameSync(tmp, target);
  log(`format_clock: beds-fired.jsonl pruned (${lines.length} -> ${kept.length} lines)`);
  return lines.length - kept.length;
}

// ---------------------------------------------------------------------------
// event construction (pure -- every Date is passed in, tests decide time)
// ---------------------------------------------------------------------------

// The wall-clock slot for minute mark `mark`: THIS hour's mark while its fire
// window is still open, otherwise the next hour's. Calendar arithmetic via
// local Date methods -- the same wall-clock convention every schedule walker
// in scheduleUtil.js uses (the format clock speaks the process-local clock,
// exactly like the schedule itself), and setHours(+1) steps the LOCAL hour so
// a DST transition cannot bend a minute mark.
export function weatherSlot(mark, now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(mark);
  if (now.getTime() >= d.getTime() + FIRE_WINDOW_MS) {
    d.setHours(d.getHours() + 1);
  }
  return d;
}

function slotStamp(d) {
  return { date: dateKey(d), hm: `${pad2(d.getHours())}-${pad2(d.getMinutes())}` };
}

function weatherEvent(mark, now) {
  const slot = weatherSlot(mark, now);
  const { date, hm } = slotStamp(slot);
  return {
    kind: 'weather',
    key: `weather@${date}@${hm}`,
    fireTime: slot.getTime(),
    clipPath: path.join(config.paths.bedsDir, `weather_${date}_${hm}.mp3`),
  };
}

// nextShow events for every occurrence whose fire window is reachable inside
// the horizon. The horizon must cover lead + produceLead + slack so the
// PRODUCE phase can see the occurrence minutes before its fire time (an
// enumeration that only reached lead+2 would make every clip "missing" at
// fire time -- the exact bug this +2 prevents).
export function nextShowEvents(schedule, now, leadMinutes) {
  if (leadMinutes == null) return [];
  const produceLeadMs = bedSettings().produceLeadMs;
  const horizon = leadMinutes + Math.ceil(produceLeadMs / 60_000) + 2;
  const events = [];
  for (const occ of upcomingOccurrences(schedule, now, horizon)) {
    const start = absoluteStart(occ.date, occ.show.startTime);
    events.push({
      kind: 'nextshow',
      key: `nextshow@${occ.date}@${occ.timeKey}@${occ.show.id}`,
      fireTime: start - leadMinutes * 60_000,
      clipPath: path.join(config.paths.bedsDir, `nextshow_${occ.show.id}_${occ.date}_${occ.timeKey}.mp3`),
      occurrence: occ,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// production (promoProducer.js's pipeline, one clip at a time)
// ---------------------------------------------------------------------------

// Render + synthesize + measure + bake one clip onto `event.clipPath`.
// Returns true when the file landed (measured or honestly unmeasured),
// false when it did not (fetch/Edge failure -- the caller logs and moves on;
// the next tick retries because the file never appeared).
async function produceBedClip(event, { synthesize, analyze, run, fetchWeather }) {
  let body;
  if (event.kind === 'weather') {
    // Fresh conditions AT PRODUCE TIME: the clip airs minutes later, and a
    // current-conditions report produced hours early would be a forecast it
    // is not qualified to make. fetchCurrentWeather defaults to °C/km/h (the
    // Val 20/A2 metric fix) -- this station speaks metric on every surface.
    let weather;
    try {
      weather = await fetchWeather();
    } catch (err) {
      log(`format_clock: weather fetch failed for slot ${event.key} (${err?.message ?? err}) -- clip skipped, next slot retries.`);
      return false;
    }
    const temp = weather?.temperature_2m;
    if (temp == null || !Number.isFinite(temp)) {
      // P4 #29 ground rules: a weather report without numbers cannot pretend
      // to be data. Skip the slot entirely -- no clip, no fire.
      log(`format_clock: no temperature for slot ${event.key} -- skipping (no fabricated numbers).`);
      return false;
    }
    const wind = Number.isFinite(weather?.wind_speed_10m) ? Math.round(weather.wind_speed_10m) : null;
    const values = {
      station: stationName(),
      condition: slovenianWeatherDescription(weather?.weather_code),
      temp: Math.round(temp),
      wind,
    };
    body = renderSlot('bedWeather', { values, seed: `bedweather|${event.key}` });
  } else {
    const occ = event.occurrence;
    const { name, host } = resolveShowInfo(occ.show, occ.show.specialTitle ?? occ.show.id);
    // Day word RELATIVE TO THE FIRE MOMENT (see the import comment): produce
    // runs minutes early, so anchoring on `now` would say "jutri" for a bed
    // the listener hears after midnight as "danes".
    const fireDate = dateKey(new Date(event.fireTime));
    const dayWord = slovenianDayLabel(occ.date, fireDate) ?? '';
    const values = {
      station: stationName(),
      show: name,
      host,
      nextDayWord: dayWord,
      nextTime: occ.show.startTime,
    };
    body = renderSlot('bedNextShow', { values, seed: `bednextshow|${event.key}` });
  }

  fs.mkdirSync(config.paths.bedsDir, { recursive: true });
  // Tmp names WITHOUT an audio extension, ON PURPOSE (promoProducer's
  // lesson): nothing scans bedsDir per tick, but a crashed run must never
  // leave a half-written *.mp3 that a later fire could push onto the air.
  const tmpEdge = `${event.clipPath}.tmp-${process.pid}`;
  let tmpGain = null;
  try {
    await synthesize(body, tmpEdge, config.imaging?.beds?.persona ?? null);
    try {
      const { lufs } = await analyze(tmpEdge);
      const { amplify } = amplifyDbFor(lufs);
      if (amplify === 0) {
        fs.renameSync(tmpEdge, event.clipPath);
      } else {
        tmpGain = `${event.clipPath}.tmp2-${process.pid}`;
        // '-f mp3' LOAD-BEARING (Val 21's live-E2E catch): the tmp name is
        // extension-less on purpose, and ffmpeg picks the muxer from the
        // output filename's extension -- without the explicit format the
        // real ffmpeg dies with "Unable to choose an output format".
        await run(
          'ffmpeg',
          ['-y', '-i', tmpEdge, '-filter:a', `volume=${amplify}dB`, '-f', 'mp3', tmpGain],
          { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER, windowsHide: true }
        );
        fs.renameSync(tmpGain, event.clipPath);
      }
    } catch (measureErr) {
      // ebur128 or ffmpeg failed: land the UNCORRECTED clip -- a
      // slightly-off-level bed beats no bed, and the broadcast-bus limiter
      // (radio.liq's compress before output.icecast) still catches peaks.
      log(
        `format_clock: clip ${event.key} loudness unmeasured (${measureErr?.message ?? measureErr}) -- landing as-is, station unaffected.`
      );
      fs.renameSync(tmpEdge, event.clipPath);
    }
    return true;
  } catch (err) {
    // Synthesize threw (Edge down / rate-limited): skip-not-fail -- the file
    // never landed, so the next tick retries, and if it never lands the slot
    // fires nothing (the bed layer is absent, not broken).
    log(`format_clock: Edge TTS failed for ${event.key} (${err?.message ?? err}) -- clip skipped, next tick retries.`);
    return false;
  } finally {
    fs.rmSync(tmpEdge, { force: true });
    if (tmpGain) fs.rmSync(tmpGain, { force: true });
  }
}

// ---------------------------------------------------------------------------
// stale-clip sweep
// ---------------------------------------------------------------------------

// CRITICAL, load-bearing rule (promoProducer's verbatim): ONLY files matching
// the GENERATED pattern are ever removed -- operator files (ANY other name:
// "moja-postelja.mp3", "december_veter.mp3", anything) are untouchable by
// this job, forever. The greedy .+ swallows underscores in show ids, so the
// date/time groups bind from the RIGHT end of the name. A generated clip is
// stale when its slot epoch is older than clipRetentionMs: weather slots age
// out in hours (their data rots), nextshow clips age out once their show has
// aired. The operator's own bed clips are pushed BY HAND (beds.push CLI) and
// are none of this job's business.
export function pruneStaleBedClips({ now = new Date(), retentionMs = 2 * 3600_000 } = {}) {
  if (!Number.isFinite(retentionMs)) return 0; // keep-forever (0 in config)
  let names;
  try {
    names = fs.readdirSync(config.paths.bedsDir);
  } catch {
    return 0; // no beds dir (feature off / fresh install) -- honest no-op
  }
  let removed = 0;
  for (const name of names) {
    const m = GENERATED_BED_RE.exec(name);
    if (!m) continue; // operator clip -- never touched (rule above)
    const [y, mo, d] = m[2].split('-').map(Number);
    const [h, mi] = m[3].split('-').map(Number);
    const slot = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (slot.getTime() + retentionMs > now.getTime()) continue;
    fs.unlinkSync(path.join(config.paths.bedsDir, name));
    removed++;
    log(`format_clock: removed stale bed clip ${name} (slot past retention).`);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// manual beds (Val 25): the operator's hands
// ---------------------------------------------------------------------------

// A manual "next show" looks at most a day ahead: upcomingOccurrences walks
// today + tomorrow, and a mid-afternoon ask about tomorrow's breakfast show
// must answer (the day word says "jutri" honestly).
const MANUAL_NEXTSHOW_HORIZON_MINUTES = 24 * 60;

// Manual, on-demand bed: produce FRESH and push NOW (the exact action the
// automatic clock performs across minutes, compressed into one call).
// kind 'weather' reports conditions fetched AT TRIGGER TIME; kind 'nextshow'
// announces the next upcoming occurrence, or the next occurrence of a
// specific showId. Unlike the tick this function THROWS on refusal -- the
// tick is autonomous and must degrade softly, while a manual call's
// refusals are the caller's problem to see (the MCP tool maps them to
// isError, the CLI to a non-zero exit). No ledger key is written: the
// ledger deduplicates AUTOMATIC slots, and a manual trigger IS its own
// single deliberate fire. Manual clip names stay inside the
// GENERATED_BED_RE namespace (weather_manual_... / nextshow_manual_...) so
// the retention sweep owns them like every other generated clip -- and two
// triggers inside the same minute share one deterministic name (the
// overwrite carries the retrigger's FRESH bytes; a queued-but-unplayed bed
// is a sub-second window the operator re-triggered inside on purpose).
export async function triggerBed({
  kind = 'weather',
  showId = null,
  now = new Date(),
  schedule = undefined,
  synthesize,
  analyze,
  run,
  fetchWeather,
  push,
} = {}) {
  if (config.imaging?.beds?.enabled !== true) {
    throw new Error('imaging.beds.enabled is not true -- the bed layer is off (OPT-IN)');
  }
  const { date, hm } = slotStamp(new Date(now));
  let event;
  if (kind === 'weather') {
    event = {
      kind: 'weather',
      key: `manual-weather@${date}@${hm}`,
      fireTime: new Date(now).getTime(),
      clipPath: path.join(config.paths.bedsDir, `weather_manual_${date}_${hm}.mp3`),
    };
  } else if (kind === 'nextshow') {
    const upcoming = upcomingOccurrences(schedule ?? loadSchedule(), now, MANUAL_NEXTSHOW_HORIZON_MINUTES);
    const occ = showId != null ? upcoming.find((o) => o.show.id === showId) : upcoming[0];
    if (!occ) {
      throw new Error(
        showId != null
          ? `no upcoming occurrence of show "${showId}" within ${MANUAL_NEXTSHOW_HORIZON_MINUTES / 60} h`
          : `no upcoming show within ${MANUAL_NEXTSHOW_HORIZON_MINUTES / 60} h`
      );
    }
    event = {
      kind: 'nextshow',
      key: `manual-nextshow@${occ.date}@${occ.timeKey}@${occ.show.id}`,
      fireTime: new Date(now).getTime(),
      clipPath: path.join(config.paths.bedsDir, `nextshow_manual_${occ.show.id}_${date}_${hm}.mp3`),
      occurrence: occ,
    };
  } else {
    throw new Error(`unknown kind "${kind}" (expected "weather" or "nextshow")`);
  }
  const landed = await produceBedClip(event, {
    synthesize: synthesize ?? synthesizeWithEdge,
    analyze: analyze ?? analyzeTrack,
    run: run ?? execFileAsync,
    fetchWeather: fetchWeather ?? fetchCurrentWeather,
  });
  if (!landed) {
    throw new Error(
      `clip production failed for ${event.key} (weather source or Edge TTS unreachable) -- nothing was pushed`
    );
  }
  let outcome;
  try {
    outcome = await (push ?? pushBedFile)(event.clipPath);
  } catch (err) {
    throw new Error(`bed push failed for ${event.key}: ${err?.message ?? err}`);
  }
  if (outcome?.ok !== true) {
    throw new Error(`Liquidsoap refused the bed for ${event.key}: ${outcome?.error ?? outcome}`);
  }
  log(`format_clock: manual bed fired for ${event.key} -> ${event.clipPath}`);
  return { kind, key: event.key, clip: event.clipPath };
}

// ---------------------------------------------------------------------------
// the tick
// ---------------------------------------------------------------------------

// Overlap guard, push/dispatch.js's dispatchInFlight discipline: every()
// fires ticks without awaiting the previous one, and a tick that spends ~10 s
// producing a clip WILL overlap the next 6 s tick. Without the guard two
// concurrent ticks could double-fire the same slot (both read the ledger
// before either records) -- with it, the late tick is skipped whole and the
// 45 s fire window absorbs the delay.
let tickInFlight = false;

// Test seams (the MCP ctx / promoProducer precedent): production callers
// pass nothing; tests inject fakes so no test ever touches the network, Edge
// or ffmpeg. `now` is a seam for the same reason -- the whole job is
// wall-clock driven, so the tests own time itself.
export async function formatClockTick({
  now = new Date(),
  schedule = null,
  synthesize = synthesizeWithEdge,
  analyze = analyzeTrack,
  run = execFileAsync,
  fetchWeather = fetchCurrentWeather,
  push = pushBedFile,
} = {}) {
  // The job gates itself (like producePromoClips) so the CLI, tests and any
  // future manual call all honor the OPT-IN; scheduler.js additionally does
  // not register the tick at all when the block is off.
  if (config.imaging?.beds?.enabled !== true) {
    return { skipped: true };
  }
  if (tickInFlight) {
    return { skippedConcurrent: true };
  }
  tickInFlight = true;
  try {
    const beds = bedSettings();
    const firedKeys = loadFiredKeys();
    // `handled` is the up-to-date set (firedKeys alone is stale the moment
    // the fire loop below records a key): the produce loop must skip not
    // only slots fired in PREVIOUS ticks but the ones fired in THIS one.
    const handled = new Set(firedKeys);

    // Fires FIRST, produces after: a fire is one telnet push (milliseconds)
    // while a produce is seconds of Edge+ffmpeg -- a due slot must never
    // wait behind an unrelated clip's production.
    // Val 25: weather events outside the daypart window (if any) are simply
    // not events -- an inactive hour neither fires NOR produces, and the
    // filter runs on the RESOLVED slot so the 05:58 roll to 06:15 reads as
    // morning. nextshow events are never dayparted (module header).
    const events = [
      ...beds.weatherMinutes
        .map((mark) => weatherEvent(mark, now))
        .filter((event) => weatherSlotActive(new Date(event.fireTime), beds.weatherDaypart)),
      ...nextShowEvents(schedule ?? loadSchedule(), now, nextShowLeadMinutes()),
    ];

    const fired = [];
    for (const event of events) {
      if (firedKeys.has(event.key)) continue;
      const due = now.getTime() >= event.fireTime && now.getTime() < event.fireTime + FIRE_WINDOW_MS;
      if (!due) continue;

      // The slot is consumed EITHER WAY (honest single attempt): a push
      // refusal or a missing clip logs once, the ledger records once, and no
      // later tick re-litigates a slot whose window is already closing.
      let outcome;
      if (!fs.existsSync(event.clipPath)) {
        outcome = { ok: false, error: 'no clip' };
        log(`format_clock: slot ${event.key} fired with no clip on disk -- bed skipped (layer absent, program unaffected).`);
      } else {
        try {
          outcome = await push(event.clipPath);
        } catch (err) {
          // sendCommand rejects on a dead telnet (ECONNREFUSED, timeout) --
          // surfaced verbatim like every honesty contract in this repo.
          outcome = { ok: false, error: err?.message ?? String(err) };
        }
        if (outcome.ok) {
          log(`format_clock: bed fired for ${event.key} -> ${event.clipPath}`);
        } else {
          log(`format_clock: bed push REFUSED for ${event.key}: ${outcome.error ?? outcome}`);
        }
      }
      recordFiredKey(event.key);
      handled.add(event.key);
      fired.push({ key: event.key, ok: outcome.ok === true, error: outcome.ok ? null : outcome.error ?? 'push failed' });
    }

    // Then production for every event whose fire time is still ahead but
    // inside the produce lead. fs.existsSync IS the re-work skip (the
    // deterministic name is the marker); a tick that finds everything on
    // disk does zero network calls.
    let produced = 0;
    for (const event of events) {
      if (handled.has(event.key)) continue; // fired this tick or in a previous one
      if (now.getTime() >= event.fireTime) continue; // past slots never (re)produce
      if (event.fireTime - now.getTime() > beds.produceLeadMs) continue;
      if (fs.existsSync(event.clipPath)) continue;
      const landed = await produceBedClip(event, { synthesize, analyze, run, fetchWeather });
      if (landed) produced++;
    }

    const prunedClips = pruneStaleBedClips({ now, retentionMs: beds.clipRetentionMs });
    const prunedLedger = pruneFiredLedger();

    if (fired.length || produced || prunedClips) {
      log(
        `format_clock: ${fired.length} fired (${fired.filter((f) => f.ok).length} ok), ${produced} produced, ${prunedClips} stale clip(s) removed.`
      );
    }
    return { fired, produced, prunedClips, prunedLedger };
  } finally {
    tickInFlight = false;
  }
}

// CLI for box-side verification (the promoProducer precedent): one honest
// tick, numbers on stdout, non-zero exit only on a thrown tick (gating and
// degradation are outcomes, not errors).
//   node src/scheduler/formatClock.js                        -- one tick
//   node src/scheduler/formatClock.js trigger weather        -- one manual weather bed (Val 25)
//   node src/scheduler/formatClock.js trigger nextshow [showId]
// The manual path exits non-zero on every honest refusal (layer off, no
// show, production failure, refused push) -- a trigger the operator asked
// for by name must never look like it succeeded silently.
async function main() {
  const result = await formatClockTick();
  if (result.skipped === true) {
    console.log('Format clock skipped: imaging.beds.enabled is not true.');
    return;
  }
  if (result.skippedConcurrent === true) {
    console.log('Format clock: previous tick still running, this one skipped.');
    return;
  }
  const ok = result.fired.filter((f) => f.ok).length;
  console.log(
    `Format clock: ${result.fired.length} fired (${ok} ok), ${result.produced} produced, ${result.prunedClips} stale clip(s) removed.`
  );
  for (const f of result.fired.filter((x) => !x.ok)) {
    console.log(`  REFUSED ${f.key}: ${f.error}`);
  }
}

async function mainTrigger(kind, showId) {
  const result = await triggerBed({ kind, showId });
  console.log(`Manual bed fired: ${result.key} -> ${result.clip}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , cmd, kindArg, showIdArg] = process.argv;
  const invocation =
    cmd === 'trigger' ? mainTrigger(kindArg ?? 'weather', showIdArg ?? null) : main();
  invocation.catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
