// Format clock tests (Paket D1): scheduler/formatClock.js -- the job that
// speaks the hourly template as BEDS over the music (weather at the
// weatherMinutes marks, the next-show handoff nextShowLeadMinutes before the
// switch) through the existing beds telnet queue.
//
// Every network/process boundary goes through the job's seams
// ({ now, schedule, synthesize, analyze, run, fetchWeather, push }): no Edge
// call, no ebur128 pass, no ffmpeg, no telnet, and -- unlike most scheduler
// jobs -- no wall-clock dependence either: `now` is a seam, so every fire
// window, produce lead and day-word rollover is tested with FIXED Dates,
// deterministically, at any time of day the suite runs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('format-clock', {
  imaging: { checkIntervalMinutes: 30 }, // deliberately NO beds block (the gating case)
});

const { config } = await import('../src/config/index.js');
const {
  formatClockTick,
  bedSettings,
  weatherSlot,
  nextShowEvents,
  loadFiredKeys,
  recordFiredKey,
  pruneFiredLedger,
  pruneStaleBedClips,
} = await import('../src/scheduler/formatClock.js');
const { DEFAULT_TEMPLATES, renderSlot } = await import('../src/auto/templates.js');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad2 = (n) => String(n).padStart(2, '0');

// Fixed-time anchor: Tuesday 2026-03-10 (the lineup is identical every
// weekday, so the calendar day itself carries no meaning -- only the clock).
function at(h, m, s = 0) {
  return new Date(2026, 2, 10, h, m, s);
}
const DAY = '2026-03-10';

// --- fixtures -----------------------------------------------------------------

function mkSchedule(shows) {
  const schedule = {};
  for (const day of WEEKDAYS) schedule[day] = shows;
  return schedule;
}

function writeBrief(rel, title, personasLine) {
  const file = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${title}\n\n${personasLine ?? ''}\n\nProsti tekst.\n`);
}

// The live config-mutation lever (promoProducer.test.mjs's enable() pattern):
// the job reads config.imaging?.beds at CALL time, not at module load.
function enable(beds) {
  config.imaging = { checkIntervalMinutes: 30, beds: { enabled: true, ...beds } };
}

function reset() {
  fs.rmSync(config.paths.bedsDir, { recursive: true, force: true });
  fs.rmSync(config.paths.bedsFiredLedgerFile, { force: true });
}

// Seams (promoProducer's makeFakes pattern): synthesize writes real bytes
// (the job renames what it produced), analyze returns the configured LUFS
// ('throw' = measurement failure), run writes the ffmpeg output file, push
// records the call. fetchWeather is per-test (its return value is the
// scenario).
function makeFakes({ lufs = -16, pushResult = null, failPushFor = null } = {}) {
  const synthCalls = [];
  const runCalls = [];
  const pushCalls = [];
  const synthesize = async (text, outPath, persona) => {
    synthCalls.push({ text, outPath, persona });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from('fake mp3 bytes'));
  };
  const analyze = async () => {
    if (lufs === 'throw') throw new Error('ebur128 produced no Summary block (fake)');
    return { lufs, peak: -1.5 };
  };
  const run = async (file, args, opts) => {
    runCalls.push({ file, args, opts });
    fs.writeFileSync(args[args.length - 1], Buffer.from('gained fake mp3'));
  };
  const push = async (clipPath) => {
    pushCalls.push(clipPath);
    if (failPushFor && clipPath.includes(failPushFor)) {
      if (pushResult === 'throw') throw new Error('connect ECONNREFUSED 127.0.0.1:1234 (fake)');
      return { ok: false, error: 'Liquidsoap ni sprejel postelje: "ERROR: Unknown command"' };
    }
    return { ok: true, requestId: '42', localPath: clipPath, leadIn: true };
  };
  return { synthesize, analyze, run, push, synthCalls, runCalls, pushCalls };
}

function weatherOf(current) {
  return async () => current;
}

const WEATHER_FULL = { temperature_2m: 12.3, weather_code: 61, wind_speed_10m: 8.4 };

function bedClip(name) {
  return path.join(config.paths.bedsDir, name);
}

// --- A. gating (the OPT-IN rule: a layer that SPEAKS must stay off by default)

describe('A. gating', () => {
  test('no imaging.beds block -> { skipped: true }, no beds dir, zero seam calls', async () => {
    config.imaging = { checkIntervalMinutes: 30 };
    reset();
    const { synthesize, push, synthCalls, pushCalls } = makeFakes();
    const result = await formatClockTick({ now: at(14, 10), schedule: mkSchedule([]), synthesize, push });
    assert.deepEqual(result, { skipped: true });
    assert.equal(synthCalls.length, 0);
    assert.equal(pushCalls.length, 0);
    assert.ok(
      !fs.existsSync(config.paths.bedsDir) || fs.readdirSync(config.paths.bedsDir).length === 0,
      'the gated-off job must not even create the beds directory'
    );
  });
});

// --- B. settings resolution (F2: absent/junk -> shipped default, deliberate OFF)

describe('B. settings', () => {
  test('weatherMinutes: absent -> [15,45]; junk -> [15,45]; [] -> off; dedupe + bounds', () => {
    enable({});
    assert.deepEqual(bedSettings().weatherMinutes, [15, 45]);
    config.imaging.beds.weatherMinutes = '15';
    assert.deepEqual(bedSettings().weatherMinutes, [15, 45], 'non-array junk falls back to the default');
    config.imaging.beds.weatherMinutes = [];
    assert.deepEqual(bedSettings().weatherMinutes, [], 'explicit empty array = weather off');
    config.imaging.beds.weatherMinutes = [45, 15, 15, 75, -1, '20'];
    assert.deepEqual(bedSettings().weatherMinutes, [15, 45], 'out-of-range/junk entries drop, duplicates collapse');
  });

  test('produceLeadMinutes: absent -> 4 min; junk -> 4 min; 10 -> 10 min', () => {
    enable({});
    assert.equal(bedSettings().produceLeadMs, 4 * 60_000);
    config.imaging.beds.produceLeadMinutes = 'abc';
    assert.equal(bedSettings().produceLeadMs, 4 * 60_000);
    config.imaging.beds.produceLeadMinutes = 10;
    assert.equal(bedSettings().produceLeadMs, 10 * 60_000);
  });

  test('clipRetentionHours: 0 -> keep forever; junk -> 2 h default; 6 -> 6 h', () => {
    enable({});
    assert.equal(bedSettings().clipRetentionMs, 2 * 3600_000);
    config.imaging.beds.clipRetentionHours = 0;
    assert.equal(bedSettings().clipRetentionMs, Infinity);
    config.imaging.beds.clipRetentionHours = 'junk';
    assert.equal(bedSettings().clipRetentionMs, 2 * 3600_000);
    config.imaging.beds.clipRetentionHours = 6;
    assert.equal(bedSettings().clipRetentionMs, 6 * 3600_000);
  });
});

// --- C. wall-clock slot math ---------------------------------------------------

describe('C. weatherSlot', () => {
  test('before this hour\'s mark -> this hour', () => {
    const slot = weatherSlot(15, at(14, 10));
    assert.equal(slot.getTime(), at(14, 15).getTime());
  });

  test('inside the fire window -> still this hour\'s mark (fires late, not skipped)', () => {
    const slot = weatherSlot(15, at(14, 15, 20));
    assert.equal(slot.getTime(), at(14, 15).getTime());
  });

  test('past the window -> next hour\'s mark (a :15 report aired at :16 would lie about the clock)', () => {
    const slot = weatherSlot(15, at(14, 15, 46));
    assert.equal(slot.getTime(), at(15, 15).getTime());
  });

  test('mark already passed this hour -> next hour', () => {
    const slot = weatherSlot(45, at(14, 50));
    assert.equal(slot.getTime(), at(15, 45).getTime());
  });

  test('late evening rolls to tomorrow (the date key follows the calendar)', () => {
    const slot = weatherSlot(15, at(23, 50));
    assert.equal(slot.getTime(), new Date(2026, 2, 11, 0, 15).getTime());
  });
});

// --- D. the fire loop (due window, single attempt, honest refusals) -----------

describe('D. firing', () => {
  test('due weather slot with a clip on disk -> pushed once, ledger records, second tick silent', async () => {
    enable({});
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'CLIP');
    const { push, pushCalls } = makeFakes();
    const schedule = mkSchedule([]);

    const r1 = await formatClockTick({ now: at(14, 15, 5), schedule, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r1.fired.length, 1);
    assert.equal(r1.fired[0].key, `weather@${DAY}@14-15`);
    assert.equal(r1.fired[0].ok, true);
    assert.deepEqual(pushCalls, [bedClip(`weather_${DAY}_14-15.mp3`)]);
    assert.deepEqual([...loadFiredKeys()], [`weather@${DAY}@14-15`]);

    const r2 = await formatClockTick({ now: at(14, 15, 11), schedule, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r2.fired.length, 0, 'the ledger key makes the second tick a no-op');
    assert.equal(pushCalls.length, 1);
  });

  test('due slot with NO clip -> no push, key still recorded (single honest attempt)', async () => {
    enable({});
    reset();
    const { push, pushCalls } = makeFakes();
    const r1 = await formatClockTick({ now: at(14, 15, 5), schedule: mkSchedule([]), push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(pushCalls.length, 0);
    assert.equal(r1.fired[0].ok, false);
    assert.equal(r1.fired[0].error, 'no clip');
    assert.deepEqual([...loadFiredKeys()], [`weather@${DAY}@14-15`], 'the slot is consumed even when its clip is missing');
    const r2 = await formatClockTick({ now: at(14, 15, 30), schedule: mkSchedule([]), push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r2.fired.length, 0);
  });

  test('push refused by Liquidsoap -> verbatim error in the report, key recorded', async () => {
    enable({});
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'CLIP');
    const { push, pushCalls } = makeFakes({ failPushFor: 'weather_', pushResult: 'refuse' });
    const r = await formatClockTick({ now: at(14, 15, 5), schedule: mkSchedule([]), push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(pushCalls.length, 1);
    assert.equal(r.fired[0].ok, false);
    assert.match(r.fired[0].error, /Liquidsoap ni sprejel/);
  });

  test('push THROWS (dead telnet) -> caught, surfaced, key recorded', async () => {
    enable({});
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'CLIP');
    const { push } = makeFakes({ failPushFor: 'weather_', pushResult: 'throw' });
    const r = await formatClockTick({ now: at(14, 15, 5), schedule: mkSchedule([]), push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.fired[0].ok, false);
    assert.match(r.fired[0].error, /ECONNREFUSED/);
  });

  test('a slot whose window closed while the process was down is skipped honestly', async () => {
    enable({});
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'CLIP');
    const { push, pushCalls } = makeFakes();
    // now = 14:16:05 -- a full minute past the slot, window long closed.
    const r = await formatClockTick({ now: at(14, 16, 5), schedule: mkSchedule([]), push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.fired.length, 0);
    assert.equal(pushCalls.length, 0);
    assert.equal(loadFiredKeys().size, 0, 'an expired slot never even reaches the ledger');
  });

  test('nextshow: show starting 14:20, lead 5 -> fires at 14:15 with the deterministic clip name', async () => {
    enable({ weatherMinutes: [] });
    reset();
    writeBrief('show-descriptions/jutro.md', 'Radio Jutro', '**Personas:** petra');
    const schedule = mkSchedule([{ id: 'jutro', startTime: '14:20', durationMinutes: 30, description: 'show-descriptions/jutro.md' }]);
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`nextshow_jutro_${DAY}_14-20.mp3`), 'CLIP');
    const { push, pushCalls } = makeFakes();
    const r = await formatClockTick({ now: at(14, 15, 5), schedule, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.fired.length, 1);
    assert.equal(r.fired[0].key, `nextshow@${DAY}@14-20@jutro`);
    assert.deepEqual(pushCalls, [bedClip(`nextshow_jutro_${DAY}_14-20.mp3`)]);
  });

  test('nextShowLeadMinutes 0 -> the nextshow bed is off entirely', async () => {
    enable({ weatherMinutes: [], nextShowLeadMinutes: 0 });
    reset();
    const schedule = mkSchedule([{ id: 'jutro', startTime: '14:20', durationMinutes: 30 }]);
    const { push, pushCalls, synthesize, synthCalls } = makeFakes();
    // 14:15:05 is the exact moment a lead-5 config would have FIRED -- with
    // the bed off there is no event, no fire, and (one tick later, inside
    // what would have been the produce window) no clip either.
    const r1 = await formatClockTick({ now: at(14, 15, 5), schedule, push, synthesize, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r1.fired.length, 0);
    assert.equal(pushCalls.length, 0);
    const r2 = await formatClockTick({ now: at(14, 12), schedule, push, synthesize, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r2.produced, 0);
    assert.equal(synthCalls.length, 0);
  });
});

// --- E. weather production ------------------------------------------------------

describe('E. weather production', () => {
  test('inside the produce lead -> fetch, render, synthesize; deterministic name = the re-work skip', async () => {
    enable({});
    reset();
    const { synthesize, analyze, run, push, synthCalls } = makeFakes();
    const schedule = mkSchedule([]);
    const r1 = await formatClockTick({ now: at(14, 11), schedule, synthesize, analyze, run, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r1.produced, 1);
    assert.equal(synthCalls.length, 1);
    const call = synthCalls[0];
    // Text: real template pools, real Slovenian condition map, rounded metric
    // values, the station name -- no fabricated anything.
    assert.match(call.text, /Test Station/);
    assert.match(call.text, /rahel de\u017e/);
    assert.match(call.text, /12 stopinj/);
    assert.match(call.text, /8 kilometrov/);
    // Tmp name carries NO audio extension (a half-written clip must never be
    // fireable), and the final name is the deterministic slot stamp.
    assert.doesNotMatch(call.outPath, /\.(mp3|wav|ogg|flac|m4a|opus)$/);
    assert.ok(fs.existsSync(bedClip(`weather_${DAY}_14-15.mp3`)));
    // Second tick 6 s later: the file exists -> zero new Edge calls.
    const r2 = await formatClockTick({ now: at(14, 11, 6), schedule, synthesize, analyze, run, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r2.produced, 0);
    assert.equal(synthCalls.length, 1);
  });

  test('the produced clip fires at the slot: produce at 14:11, fire at 14:15', async () => {
    enable({});
    reset();
    const fakes = makeFakes();
    const schedule = mkSchedule([]);
    await formatClockTick({ now: at(14, 11), schedule, ...fakes, fetchWeather: weatherOf(WEATHER_FULL) });
    const r = await formatClockTick({ now: at(14, 15, 3), schedule, ...fakes, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.fired.length, 1);
    assert.equal(r.fired[0].ok, true);
    assert.deepEqual(fakes.pushCalls, [bedClip(`weather_${DAY}_14-15.mp3`)]);
  });

  test('no wind from the API -> the noWind pool (never a dangling wind clause)', async () => {
    enable({});
    reset();
    const { synthesize, synthCalls } = makeFakes();
    await formatClockTick({
      now: at(14, 11),
      schedule: mkSchedule([]),
      synthesize,
      analyze: makeFakes().analyze,
      run: makeFakes().run,
      push: makeFakes().push,
      fetchWeather: weatherOf({ temperature_2m: 12.3, weather_code: 61, wind_speed_10m: null }),
    });
    assert.doesNotMatch(synthCalls[0].text, /veter|piha/, 'the noWind pool drops the whole wind clause');
    assert.match(synthCalls[0].text, /12 stopinj/);
  });

  test('no temperature -> no clip at all (P4 #29: no fabricated numbers)', async () => {
    enable({});
    reset();
    const { synthesize, synthCalls } = makeFakes();
    const r = await formatClockTick({
      now: at(14, 11),
      schedule: mkSchedule([]),
      synthesize,
      analyze: makeFakes().analyze,
      run: makeFakes().run,
      push: makeFakes().push,
      fetchWeather: weatherOf({ temperature_2m: null, weather_code: 61, wind_speed_10m: 8 }),
    });
    assert.equal(r.produced, 0);
    assert.equal(synthCalls.length, 0);
    assert.ok(!fs.existsSync(bedClip(`weather_${DAY}_14-15.mp3`)));
  });

  test('Open-Meteo down -> honest skip; the next tick retries', async () => {
    enable({});
    reset();
    const { synthesize, synthCalls } = makeFakes();
    const fetchWeather = async () => {
      throw new Error('Open-Meteo request failed: 503 (fake)');
    };
    const seams = { synthesize, analyze: makeFakes().analyze, run: makeFakes().run, push: makeFakes().push };
    const r1 = await formatClockTick({ now: at(14, 11), schedule: mkSchedule([]), ...seams, fetchWeather });
    assert.equal(r1.produced, 0);
    assert.equal(synthCalls.length, 0);
    const r2 = await formatClockTick({ now: at(14, 11, 6), schedule: mkSchedule([]), ...seams, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r2.produced, 1, 'the file never landed, so the next tick retries');
  });

  test('gain bake: off-target LUFS -> ffmpeg volume pass onto the final bytes', async () => {
    enable({});
    reset();
    const { synthesize, analyze, run, push, runCalls } = makeFakes({ lufs: -20 });
    await formatClockTick({ now: at(14, 11), schedule: mkSchedule([]), synthesize, analyze, run, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(runCalls.length, 1);
    const argv = runCalls[0].args;
    assert.ok(argv.includes('volume=4dB'), `expected the measured +4 dB bake, got ${argv.join(' ')}`);
    assert.ok(argv.includes('-f') && argv.includes('mp3'), 'the extension-less tmp needs the explicit mp3 muxer (Val 21 lesson)');
    assert.equal(fs.readFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'utf8'), 'gained fake mp3');
  });

  test('on-target LUFS -> bytes land untouched, no ffmpeg pass', async () => {
    enable({});
    reset();
    const { synthesize, analyze, run, push, runCalls } = makeFakes({ lufs: -16 });
    await formatClockTick({ now: at(14, 11), schedule: mkSchedule([]), synthesize, analyze, run, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(runCalls.length, 0);
    assert.equal(fs.readFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'utf8'), 'fake mp3 bytes');
  });

  test('ebur128 failure -> clip lands UNMEASURED (station unaffected)', async () => {
    enable({});
    reset();
    const { synthesize, analyze, run, push, runCalls } = makeFakes({ lufs: 'throw' });
    const r = await formatClockTick({ now: at(14, 11), schedule: mkSchedule([]), synthesize, analyze, run, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.produced, 1);
    assert.equal(runCalls.length, 0);
    assert.equal(fs.readFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'utf8'), 'fake mp3 bytes');
  });

  test('ffmpeg failure -> the UNCORRECTED clip still lands', async () => {
    enable({});
    reset();
    const { synthesize, analyze, run, push } = makeFakes({ lufs: -20 });
    const failingRun = async (file, args) => {
      throw new Error('ffmpeg died (fake)');
    };
    const r = await formatClockTick({ now: at(14, 11), schedule: mkSchedule([]), synthesize, analyze, run: failingRun, push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.produced, 1);
    assert.equal(fs.readFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'utf8'), 'fake mp3 bytes');
    // No tmp leftovers survive the tick (atomic discipline).
    assert.deepEqual(fs.readdirSync(config.paths.bedsDir).filter((n) => n.includes('tmp')), []);
  });
});

// --- F. nextshow production ------------------------------------------------------

describe('F. nextshow production', () => {
  test('hosted show: brief H1 + host + start time + danes + station, deterministic name', async () => {
    enable({ weatherMinutes: [] });
    reset();
    writeBrief('show-descriptions/jutro.md', 'Radio Jutro', '**Personas:** petra');
    const schedule = mkSchedule([{ id: 'jutro', startTime: '14:20', durationMinutes: 30, description: 'show-descriptions/jutro.md' }]);
    const { synthesize, synthCalls } = makeFakes();
    // now 14:12, fire 14:15, produce lead 4 -> in the produce window.
    const r = await formatClockTick({ now: at(14, 12), schedule, synthesize, analyze: makeFakes().analyze, run: makeFakes().run, push: makeFakes().push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.produced, 1);
    const text = synthCalls[0].text;
    assert.match(text, /Radio Jutro/);
    assert.match(text, /Petra/);
    assert.match(text, /14:20/);
    assert.match(text, /danes/);
    assert.match(text, /Test Station/);
    assert.ok(fs.existsSync(bedClip(`nextshow_jutro_${DAY}_14-20.mp3`)));
  });

  test('hostless show -> the noHost pool (never a dangling "z voditeljem")', async () => {
    enable({ weatherMinutes: [] });
    reset();
    writeBrief('show-descriptions/vecer.md', 'Sami Vecer', null);
    const schedule = mkSchedule([{ id: 'vecer', startTime: '14:20', durationMinutes: 30, description: 'show-descriptions/vecer.md' }]);
    const { synthesize, synthCalls } = makeFakes();
    await formatClockTick({ now: at(14, 12), schedule, synthesize, analyze: makeFakes().analyze, run: makeFakes().run, push: makeFakes().push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.doesNotMatch(synthCalls[0].text, /voditelj/);
  });

  test('day word is anchored to the FIRE moment: 23:55 fire for a 00:02 show says "jutri"', async () => {
    enable({ weatherMinutes: [] });
    reset();
    writeBrief('show-descriptions/nocna.md', 'Nocna Smena', null);
    const schedule = mkSchedule([{ id: 'nocna', startTime: '00:02', durationMinutes: 30, description: 'show-descriptions/nocna.md' }]);
    const { synthesize, synthCalls } = makeFakes();
    // today's 00:02 already aired; tomorrow's 00:02 is +7 min, fire at 23:57
    // TODAY -- anchoring on `now` (23:55, still Tuesday) vs the fire date
    // (also Tuesday) is identical here; the target date is Wednesday, so the
    // honest label from the listener's chair at 23:57 is "jutri".
    const r = await formatClockTick({ now: at(23, 55), schedule, synthesize, analyze: makeFakes().analyze, run: makeFakes().run, push: makeFakes().push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.produced, 1);
    assert.match(synthCalls[0].text, /jutri/);
    assert.match(synthCalls[0].text, /00:02/);
  });

  test('a replay occurrence is announced like any airing (rebroadcasts are real airings)', async () => {
    enable({ weatherMinutes: [] });
    reset();
    const schedule = mkSchedule([{ id: 'repriza', startTime: '14:20', durationMinutes: 30, type: 'replay', sourceDate: '2026-03-03' }]);
    const { synthesize, synthCalls } = makeFakes();
    const r = await formatClockTick({ now: at(14, 12), schedule, synthesize, analyze: makeFakes().analyze, run: makeFakes().run, push: makeFakes().push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.produced, 1);
    assert.match(synthCalls[0].text, /repriza/);
  });

  test('no upcoming show inside the horizon -> no nextshow event, no produce', async () => {
    enable({ weatherMinutes: [] });
    reset();
    const schedule = mkSchedule([{ id: 'kasneje', startTime: '23:00', durationMinutes: 30 }]);
    const { synthesize, synthCalls } = makeFakes();
    const r = await formatClockTick({ now: at(14, 12), schedule, synthesize, analyze: makeFakes().analyze, run: makeFakes().run, push: makeFakes().push, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.produced, 0);
    assert.equal(synthCalls.length, 0);
  });
});

// --- G. concurrency guard (push/dispatch.js's dispatchInFlight discipline) -----

describe('G. concurrency', () => {
  test('a tick still producing (awaiting the weather fetch) skips the overlapping tick whole', async () => {
    enable({});
    reset();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchWeather = () => gate;
    const fakes = makeFakes();
    const schedule = mkSchedule([]);
    const t1 = formatClockTick({ now: at(14, 11), schedule, ...fakes, fetchWeather });
    await new Promise((resolve) => setImmediate(resolve)); // let t1 reach the gated await
    const t2 = await formatClockTick({ now: at(14, 11, 6), schedule, ...fakes, fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(t2.skippedConcurrent, true, 'the overlapping tick must not double-fire or double-produce');
    release(WEATHER_FULL);
    const r1 = await t1;
    assert.equal(r1.produced, 1);
  });
});

// --- H. stale-clip sweep (the load-bearing operator-file rule) ------------------

describe('H. pruning', () => {
  test('stale generated clips go, fresh stay, operator files are untouchable forever', () => {
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    const now = at(14, 10);
    // Slot 12:15 today = ~2 h ago -> stale at the default 2 h retention...
    // 12:15 + 2 h = 14:15 > 14:10 -> NOT yet stale. Use 12:00 to be safely out.
    fs.writeFileSync(bedClip(`weather_${DAY}_12-00.mp3`), 'OLD');
    fs.writeFileSync(bedClip(`weather_${DAY}_14-15.mp3`), 'FRESH');
    fs.writeFileSync(bedClip(`nextshow_jutro_${DAY}_12-00.mp3`), 'OLD-NEXTSHOW');
    fs.writeFileSync(bedClip('moja-postelja.mp3'), 'OPERATOR');
    fs.writeFileSync(bedClip('weather_brez_datuma.mp3'), 'OPERATOR-ISH');

    const removed = pruneStaleBedClips({ now, retentionMs: 2 * 3600_000 });
    assert.equal(removed, 2);
    assert.ok(!fs.existsSync(bedClip(`weather_${DAY}_12-00.mp3`)));
    assert.ok(!fs.existsSync(bedClip(`nextshow_jutro_${DAY}_12-00.mp3`)));
    assert.ok(fs.existsSync(bedClip(`weather_${DAY}_14-15.mp3`)));
    assert.ok(fs.existsSync(bedClip('moja-postelja.mp3')), 'operator clip: untouchable');
    assert.ok(fs.existsSync(bedClip('weather_brez_datuma.mp3')), 'generated PREFIX alone is not the pattern -- never guessed at');
  });

  test('retention Infinity (clipRetentionHours 0) removes nothing', () => {
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`weather_2020-01-01_08-00.mp3`), 'ANCIENT');
    assert.equal(pruneStaleBedClips({ now: at(14, 10), retentionMs: Infinity }), 0);
    assert.ok(fs.existsSync(bedClip('weather_2020-01-01_08-00.mp3')));
  });

  test('the tick prunes with the configured retention', async () => {
    enable({ clipRetentionHours: 2 });
    reset();
    fs.mkdirSync(config.paths.bedsDir, { recursive: true });
    fs.writeFileSync(bedClip(`weather_${DAY}_12-00.mp3`), 'OLD');
    const r = await formatClockTick({ now: at(14, 16), schedule: mkSchedule([]), ...makeFakes(), fetchWeather: weatherOf(WEATHER_FULL) });
    assert.equal(r.prunedClips, 1);
    assert.ok(!fs.existsSync(bedClip(`weather_${DAY}_12-00.mp3`)));
  });
});

// --- I. the fired ledger ----------------------------------------------------------

describe('I. ledger', () => {
  test('loadFiredKeys skips torn lines, recordFiredKey appends parseable JSONL', () => {
    reset();
    fs.mkdirSync(path.dirname(config.paths.bedsFiredLedgerFile), { recursive: true });
    fs.writeFileSync(config.paths.bedsFiredLedgerFile, `${JSON.stringify({ key: 'weather@x@14-15' })}\n{torn json\n\n`);
    const keys = loadFiredKeys();
    assert.deepEqual([...keys], ['weather@x@14-15']);
    recordFiredKey('nextshow@d@14-20@jutro');
    const lines = fs.readFileSync(config.paths.bedsFiredLedgerFile, 'utf8').split('\n').filter((l) => l.trim());
    // The torn line STAYS on disk (the prune only rewrites past MAX lines) --
    // loaders skip it, so the ledger's contract is about reads, not hygiene.
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).key, 'nextshow@d@14-20@jutro');
    assert.ok(JSON.parse(lines[2]).firedAt);
  });

  test('pruneFiredLedger: past MAX a rewrite keeps the newest KEEP, atomically', () => {
    reset();
    fs.mkdirSync(path.dirname(config.paths.bedsFiredLedgerFile), { recursive: true });
    const lines = [];
    for (let i = 0; i < 20_001; i++) lines.push(JSON.stringify({ key: `k${i}`, firedAt: '2026-01-01T00:00:00.000Z' }));
    fs.writeFileSync(config.paths.bedsFiredLedgerFile, lines.join('\n') + '\n');
    const removed = pruneFiredLedger();
    assert.equal(removed, 20_001 - 10_000);
    const kept = fs.readFileSync(config.paths.bedsFiredLedgerFile, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(kept.length, 10_000);
    assert.equal(JSON.parse(kept[0]).key, 'k10001', 'oldest-first drop -- exactly the idempotence window the ledger needs');
    assert.equal(fs.existsSync(`${config.paths.bedsFiredLedgerFile}.tmp-${process.pid}`), false);
  });
});

// --- J. template pools (integrity + the override path) ---------------------------

describe('J. templates', () => {
  test('bedWeather pools: every withWind variant carries station/condition/temp/wind, noWind drops wind', () => {
    for (const t of DEFAULT_TEMPLATES.bedWeather.withWind) {
      assert.match(t, /\{station\}/);
      assert.match(t, /\{condition\}/);
      assert.match(t, /\{temp\}/);
      assert.match(t, /\{wind\}/);
    }
    for (const t of DEFAULT_TEMPLATES.bedWeather.noWind) {
      assert.match(t, /\{temp\}/);
      assert.doesNotMatch(t, /\{wind\}/);
    }
  });

  test('bedNextShow pools: withHost carries host, noHost never mentions it', () => {
    for (const t of DEFAULT_TEMPLATES.bedNextShow.withHost) {
      assert.match(t, /\{host\}/);
      assert.match(t, /\{nextTime\}/);
    }
    for (const t of DEFAULT_TEMPLATES.bedNextShow.noHost) {
      assert.doesNotMatch(t, /\{host\}/);
    }
  });

  test('renderSlot: wind presence picks the pool; host presence picks the pool', () => {
    const values = { station: 'Test Station', condition: 'jasno', temp: 5 };
    const withWind = renderSlot('bedWeather', { values: { ...values, wind: 3 }, seed: 's1' });
    assert.match(withWind, /3 kilometrov/);
    const noWind = renderSlot('bedWeather', { values, seed: 's1' });
    assert.doesNotMatch(noWind, /veter|piha/);
    const withHost = renderSlot('bedNextShow', {
      values: { station: 'Test Station', show: 'X', host: 'Petra', nextTime: '14:20', nextDayWord: 'danes' },
      seed: 's2',
    });
    assert.match(withHost, /Petra/);
    const noHost = renderSlot('bedNextShow', {
      values: { station: 'Test Station', show: 'X', nextTime: '14:20', nextDayWord: 'danes' },
      seed: 's2',
    });
    assert.doesNotMatch(noHost, /voditelj/);
  });

  test('owner override: config.autoRadio.templates.bedNextShow replaces the pool wholesale', () => {
    const previous = config.autoRadio?.templates;
    config.autoRadio = { ...(config.autoRadio ?? {}), templates: { bedNextShow: { noHost: ['PRIHAJA {show} OB {nextTime}!'] } } };
    try {
      const text = renderSlot('bedNextShow', { values: { show: 'X', nextTime: '14:20' }, seed: 'any' });
      assert.equal(text, 'PRIHAJA X OB 14:20!');
    } finally {
      config.autoRadio = previous;
    }
  });
});
