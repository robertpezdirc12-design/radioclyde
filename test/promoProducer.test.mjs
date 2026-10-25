// Promo producer tests (Paket B2): scheduler/promoProducer.js -- the job that
// turns the REAL schedule into promo clips (Edge TTS + baked loudness) for
// the fourth imaging layer.
//
// Every network/process boundary goes through the job's seams
// ({ synthesize, analyze, run } -- the MCP ctx precedent): no Edge call, no
// ebur128 pass, no ffmpeg ever runs here.
//
// The job reads the wall clock (nextOccurrences(loadSchedule(), new Date())),
// so the schedule fixtures are built RELATIVE TO NOW: shows are scheduled on
// every weekday at a start time ~50 min (and a second one ~70 min) ahead, so
// the first occurrence always lands < 2 h out and every subsequent one
// exactly one calendar day later, regardless of when in the day the suite
// runs. Horizon choices keep >= 10 h of margin from every boundary, so the
// seconds of wall-clock drift between fixture setup and the job's own
// new Date() can never flip an assertion.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('promo-producer', {
  imaging: { checkIntervalMinutes: 30 }, // deliberately NO promos block (the F2-absent case)
});

const { config } = await import('../src/config/index.js');
const { producePromoClips } = await import('../src/scheduler/promoProducer.js');
const { absoluteStart } = await import('../src/scheduler/scheduleUtil.js');
const { slovenianWeekdayPhrase } = await import('../src/lib/time.js');

const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// ~50 min / ~70 min from now (see header): the two in-window show times.
const START_T = (() => {
  const t = new Date(Date.now() + 50 * 60000);
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
})();
const START_T2 = (() => {
  const t = new Date(Date.now() + 70 * 60000);
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
})();

// --- fixtures -----------------------------------------------------------------

// One lineup on every weekday (the shows air daily, so "today/tomorrow/
// +3 days" are all covered by one fixture and the horizon does the picking).
function writeStation(shows) {
  const schedule = {};
  for (const day of WEEKDAYS) schedule[day] = shows;
  fs.writeFileSync(
    config.paths.stationFile,
    JSON.stringify({ station: { name: 'Test Station', neverPlay: { keywords: [], artists: [] } }, schedule })
  );
}

// A show brief with the exact shape producer/showBrief.js parses: H1 title +
// optional **Personas:** line (first persona = primary host).
function writeBrief(rel, title, personasLine) {
  const file = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${title}\n\n${personasLine ?? ''}\n\nProsti tekst.\n`);
}

// In-memory config mutation (autoGenreSteering.test.mjs's liveConfig pattern):
// the job reads config.imaging?.promos at CALL time, not at module load.
function enable(promos) {
  config.imaging = { checkIntervalMinutes: 30, promos: { enabled: true, ...promos } };
}

function resetPromosDir() {
  fs.rmSync(config.paths.imagingPromosDir, { recursive: true, force: true });
  fs.rmSync(config.paths.imagingPromosPath, { force: true });
}

// Seams: synthesize writes real bytes (the job renames what it produced),
// analyze returns the configured LUFS ('throw' = measurement failure), run
// writes the ffmpeg output file (the job renames tmp2 -> final).
function makeFakes({ lufs = -16, failFor = null } = {}) {
  const synthCalls = [];
  const runCalls = [];
  const synthesize = async (text, outPath, persona) => {
    if (failFor && path.basename(outPath).startsWith(`promo_${failFor}_`)) {
      throw new Error('edge TTS down (fake)');
    }
    synthCalls.push({ text, outPath, persona });
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
  return { synthesize, analyze, run, synthCalls, runCalls };
}

function producedNames(prefix) {
  return fs
    .readdirSync(config.paths.imagingPromosDir)
    .filter((n) => n.startsWith(`${prefix}_`) && n.endsWith('.mp3'));
}

// --- A. gating (F2: absent block = feature off) --------------------------------

describe('A. gating', () => {
  test('no imaging.promos block -> { skipped: true }, zero files, zero Edge calls', async () => {
    config.imaging = { checkIntervalMinutes: 30 };
    resetPromosDir();
    writeStation([{ id: 'some-show', startTime: START_T, durationMinutes: 30 }]);
    const { synthesize, synthCalls } = makeFakes();
    const result = await producePromoClips({ synthesize });
    assert.deepEqual(result, { skipped: true });
    assert.equal(synthCalls.length, 0);
    assert.ok(
      !fs.existsSync(config.paths.imagingPromosDir) || fs.readdirSync(config.paths.imagingPromosDir).length === 0,
      'the gated-off job must not even create the promos directory'
    );
  });
});

// --- B. text rendering (real brief -> real template pools) ---------------------

describe('B. rendering', () => {
  test('hosted show: brief H1 + host + time + weekday phrase + station in the synthesized text', async () => {
    resetPromosDir();
    writeBrief('show-descriptions/hosted.md', 'Radio Jutro', '**Personas:** petra');
    writeBrief('show-descriptions/hostless.md', 'Sami Večer', null);
    writeStation([
      { id: 'hosted', startTime: START_T, durationMinutes: 30, description: 'show-descriptions/hosted.md' },
      { id: 'hostless', startTime: START_T2, durationMinutes: 30, description: 'show-descriptions/hostless.md' },
    ]);
    enable({ horizonHours: 12.8 });

    const { synthesize, synthCalls } = makeFakes();
    const result = await producePromoClips({ synthesize });
    assert.equal(result.produced, 2);
    assert.equal(result.errors.length, 0);

    const byId = {};
    for (const call of synthCalls) {
      const base = path.basename(call.outPath);
      byId[base.startsWith('promo_hosted_') ? 'hosted' : 'hostless'] = call;
    }
    const hosted = byId.hosted;
    const hostless = byId.hostless;
    assert.ok(hosted, 'hosted occurrence synthesized');
    assert.ok(hostless, 'hostless occurrence synthesized');

    // The brief's H1 title (showName.js resolves display names from the
    // brief, exactly like /api/schedule) and the capitalized primary host.
    assert.ok(hosted.text.includes('Radio Jutro'), `H1 title missing: ${hosted.text}`);
    assert.ok(hosted.text.includes('Petra'), `host missing: ${hosted.text}`);
    // The occurrence's own startTime rides the {time} slot.
    assert.ok(hosted.text.includes(START_T), `time ${START_T} missing: ${hosted.text}`);
    // The station name (templates.js stationName() -> autoRadio.stationName).
    assert.ok(hosted.text.includes('Test Station'), `station missing: ${hosted.text}`);
    // The weekday-name day phrase derived from the SAME date the clip's
    // deterministic filename carries ("v ponedeljek", never "danes"/"jutri").
    const m = /promo_hosted_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3/.exec(path.basename(hosted.outPath));
    assert.ok(m, `deterministic name shape: ${hosted.outPath}`);
    const dayPhrase = slovenianWeekdayPhrase(m[1]);
    assert.ok(dayPhrase, 'weekday phrase resolved');
    assert.ok(hosted.text.includes(dayPhrase), `day phrase "${dayPhrase}" missing: ${hosted.text}`);

    // Hostless: the promo pool (never a dangling "z voditeljem" clause).
    assert.ok(hostless.text.includes('Sami Večer'), `H1 title missing: ${hostless.text}`);
    assert.ok(!hostless.text.includes('voditeljem'), `host clause leaked: ${hostless.text}`);
    assert.ok(!hostless.text.includes('Petra'), `host name leaked: ${hostless.text}`);

    // Persona seam: unset -> null (edgeVoiceForPersona then resolves the
    // global voice -- documented cascade, pinned as the passed-through value).
    assert.equal(hosted.persona, null);
    assert.equal(hostless.persona, null);
  });
});

// --- C. window (horizon filter + maxClips cap) ---------------------------------

describe('C. window', () => {
  test('only in-horizon occurrences synthesized; the clip names an occurrence inside the window', async () => {
    resetPromosDir();
    writeStation([{ id: 'win', startTime: START_T, durationMinutes: 30 }]);
    // 12.8 h: the ~50 min occurrence is in, the next (+1 calendar day) is
    // ~12 h past the boundary -- no wall-clock flakiness possible.
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes();
    const result = await producePromoClips(fakes);
    assert.equal(result.produced, 1);
    assert.equal(fakes.synthCalls.length, 1);

    // Semantic pin: the produced clip's occurrence IS inside the horizon.
    const name = producedNames('promo_win')[0];
    const m = /^promo_win_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/.exec(name);
    assert.ok(m, `generated name shape: ${name}`);
    const distance = absoluteStart(m[1], m[2].replace('-', ':')) - Date.now();
    assert.ok(distance > 0 && distance <= 12.8 * 3600_000, `occurrence out of window: ${distance} ms`);
  });

  test('maxClips caps the work list (windowCount reports the sliced list)', async () => {
    resetPromosDir();
    writeStation([{ id: 'win', startTime: START_T, durationMinutes: 30 }]);
    // 62 h holds three occurrences (~50 min, ~+1 day, ~+2 days); cap at 2.
    enable({ horizonHours: 62, maxClips: 2 });

    const fakes = makeFakes();
    const result = await producePromoClips(fakes);
    assert.equal(result.produced, 2);
    assert.equal(result.windowCount, 2);
    assert.equal(fakes.synthCalls.length, 2);
    assert.equal(producedNames('promo_win').length, 2);
  });
});

// --- D. deterministic naming = the re-work skip -------------------------------

describe('D. deterministic skip', () => {
  test('second run with the same schedule: produced 0, reused N, synthesize NOT called again', async () => {
    resetPromosDir();
    writeBrief('show-descriptions/hosted.md', 'Radio Jutro', '**Personas:** petra');
    writeStation([{ id: 'hosted', startTime: START_T, durationMinutes: 30, description: 'show-descriptions/hosted.md' }]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes();
    const first = await producePromoClips(fakes);
    assert.ok(first.produced >= 1);
    const synthAfterFirst = fakes.synthCalls.length;

    const second = await producePromoClips(fakes);
    assert.equal(second.produced, 0);
    assert.equal(second.reused, first.produced);
    assert.equal(fakes.synthCalls.length, synthAfterFirst, 'Edge must not be called again');
    assert.equal(second.removed, 0, 'in-window clips are not stale');
  });
});

// --- E. stale sweep (the load-bearing operator-safety pin) ---------------------

describe('E. stale sweep', () => {
  test('stale GENERATED clip removed; operator clip UNTOUCHED', async () => {
    resetPromosDir();
    fs.mkdirSync(config.paths.imagingPromosDir, { recursive: true });
    const stale = path.join(config.paths.imagingPromosDir, 'promo_oldshow_2020-01-01_08-00.mp3');
    const operator = path.join(config.paths.imagingPromosDir, 'moj-promo.mp3');
    fs.writeFileSync(stale, 'stale bytes');
    fs.writeFileSync(operator, 'operator bytes');

    writeStation([{ id: 'win', startTime: START_T, durationMinutes: 30 }]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes();
    const result = await producePromoClips(fakes);
    assert.equal(result.removed, 1);
    assert.ok(!fs.existsSync(stale), 'stale generated clip must be pruned');
    assert.ok(fs.existsSync(operator), 'OPERATOR clip must never be removed by this job');
    assert.equal(fs.readFileSync(operator, 'utf8'), 'operator bytes');
  });
});

// --- F. loudness bake ----------------------------------------------------------

describe('F. loudness bake', () => {
  test('measured -20 LUFS -> ffmpeg volume=4dB (amplifyDbFor, default target -16), tmp2 atomic chain', async () => {
    resetPromosDir();
    writeStation([{ id: 'loud', startTime: START_T, durationMinutes: 30 }]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes({ lufs: -20 });
    const result = await producePromoClips(fakes);
    assert.equal(result.produced, 1);

    assert.equal(fakes.runCalls.length, 1);
    const { file, args, opts } = fakes.runCalls[0];
    assert.equal(file, 'ffmpeg');
    // The input is the measured tmp (extension-less), the filter is the
    // exact one-decimal correction amplifyDbFor(-20) produces, and '-f mp3'
    // is LOAD-BEARING: ffmpeg picks the output muxer from the filename's
    // extension, the tmp2 output is extension-less on purpose (scan
    // invisibility), so without the explicit format the real ffmpeg dies
    // with "Unable to choose an output format" and every clip would land
    // unmeasured via the fallback -- caught live in the Val 21 orchestrator
    // E2E (2026-10-25); this pin keeps it from creeping back out.
    assert.deepEqual(args.slice(0, 7), ['-y', '-i', fakes.synthCalls[0].outPath, '-filter:a', 'volume=4dB', '-f', 'mp3']);
    // The output is the extension-less tmp2 -- never visible to the m3u scan.
    assert.ok(args[7].endsWith(`.tmp2-${process.pid}`), `tmp2 name: ${args[7]}`);
    assert.equal(opts.timeout, 60_000);
    assert.equal(opts.windowsHide, true);

    // The GAINED bytes are what landed (tmp2 -> final, not tmp -> final).
    const finalName = producedNames('promo_loud')[0];
    assert.equal(fs.readFileSync(path.join(config.paths.imagingPromosDir, finalName), 'utf8'), 'gained fake mp3');
    // No tmp leftovers on any path.
    assert.deepEqual(
      fs.readdirSync(config.paths.imagingPromosDir).filter((f) => f.includes('.tmp')),
      []
    );
  });

  test('on-target clip (amplify 0): NO ffmpeg pass, measured bytes renamed straight in', async () => {
    resetPromosDir();
    writeStation([{ id: 'ontarget', startTime: START_T, durationMinutes: 30 }]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes({ lufs: -16 });
    const result = await producePromoClips(fakes);
    assert.equal(result.produced, 1);
    assert.equal(fakes.runCalls.length, 0, 'a 0 dB correction must not spawn ffmpeg');
    const finalName = producedNames('promo_ontarget')[0];
    assert.equal(fs.readFileSync(path.join(config.paths.imagingPromosDir, finalName), 'utf8'), 'fake mp3 bytes');
  });

  test('failed measurement: clip still lands unmeasured, no ffmpeg', async () => {
    resetPromosDir();
    writeStation([{ id: 'unmeasured', startTime: START_T, durationMinutes: 30 }]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes({ lufs: 'throw' });
    const result = await producePromoClips(fakes);
    assert.equal(result.produced, 1, 'unmeasured degradation must still land the clip');
    assert.equal(result.errors.length, 0, 'a measurement failure is honest degradation, not a job error');
    assert.equal(fakes.runCalls.length, 0);
    assert.ok(producedNames('promo_unmeasured').length === 1);
  });
});

// --- G. Edge failure (skip-not-fail) -------------------------------------------

describe('G. Edge failure', () => {
  test('failed clip -> errors[] entry + no file; sibling clips still produced', async () => {
    resetPromosDir();
    writeStation([
      { id: 'boom', startTime: START_T, durationMinutes: 30 },
      { id: 'calm', startTime: START_T2, durationMinutes: 30 },
    ]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes({ failFor: 'boom' });
    const result = await producePromoClips(fakes);
    assert.equal(result.produced, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].show, 'boom');
    assert.equal(producedNames('promo_calm').length, 1);
    assert.equal(producedNames('promo_boom').length, 0, 'the failed clip must not land');
  });
});

// --- H. the m3u refresh at the end of the wave ---------------------------------

describe('H. promos.m3u refresh', () => {
  test('writeImagingPlaylists ran: promos.m3u lists the clips with the promo source_tag', async () => {
    resetPromosDir();
    writeBrief('show-descriptions/hosted.md', 'Radio Jutro', '**Personas:** petra');
    writeStation([{ id: 'hosted', startTime: START_T, durationMinutes: 30, description: 'show-descriptions/hosted.md' }]);
    enable({ horizonHours: 12.8 });

    const fakes = makeFakes();
    await producePromoClips(fakes);

    const lines = fs.readFileSync(config.paths.imagingPromosPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^annotate:source_tag="promo",liq_fade_in="0":/);
    assert.ok(lines[0].includes('promo_hosted_'));
  });
});
