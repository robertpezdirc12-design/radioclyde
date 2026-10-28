// Entry-aware fade-in regression tests (Val 28 B1): lib/autocue.js's ebur128
// HEAD pass -- the mirror of the tail pass (test/autocueTail.test.mjs) onto
// the FIRST 20 s of a track. Covers the momentary-derived head metrics, the
// read-time fade-in sizing (fadeInSecondsFor), the annotate wiring in
// director/playlist.js's annotateTrackEntry (liq_fade_in: measured value or
// the 2 s default), and -- unlike the tail suite -- a REAL-ffmpeg integration
// block that generates an actual deep fade-in and a cold attack and proves
// the classification end-to-end (skip-guarded, the autocueLoudness.test.mjs
// honesty pattern: no ffmpeg on the box means the suite skips, not fails).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav } from './fixtures.mjs';

const execFileAsync = promisify(execFile);

const HAS_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const SKIP_REASON = HAS_FFMPEG ? false : 'ffmpeg not available on this box';

setupTestConfig('autocue-head', {
  autocue: { targetLufs: -16, maxGainDb: 6 },
});

const { config } = await import('../src/config/index.js');
const {
  parseEbur128Momentary,
  headMetrics,
  analyzeHead,
  fadeInSecondsFor,
  fadeInAnnotate,
  transitionFlagsFor,
  analyzeMissing,
} = await import('../src/lib/autocue.js');
const { annotateTrackEntry } = await import('../src/director/playlist.js');

// --- Val 28 D1: transition-effect rules (pure) -------------------------------
// The dormant dj_transitions.liq layer is armed deterministically from the
// SAME measurements the fade sizing uses. These are the RULES, pinned pure
// (head/tail/lufs in, three booleans out) -- the stamping integration lives
// in the annotateTrackEntry blocks above and in test/djTransitions.test.mjs.
describe('transitionFlagsFor (Val 28 D1 rules)', () => {
  test('washout: only an EPIC fade-out ending (fade + wind >= 6 s + drop >= 10 dB)', () => {
    assert.deepEqual(transitionFlagsFor(null, { windMs: 9000, fade: true, lufsDrop: 25 }, -14), { washout: true, dissolve: false, sweep: false });
    assert.deepEqual(transitionFlagsFor(null, { windMs: 9000, fade: true, lufsDrop: 8 }, -14), { washout: false, dissolve: false, sweep: false }, 'drop too shallow');
    assert.deepEqual(transitionFlagsFor(null, { windMs: 5500, fade: true, lufsDrop: 25 }, -14), { washout: false, dissolve: false, sweep: false }, 'wind too short');
    assert.deepEqual(transitionFlagsFor(null, { windMs: 9000, fade: false, lufsDrop: 25 }, -14), { washout: false, dissolve: false, sweep: false }, 'cold ending');
    assert.deepEqual(transitionFlagsFor(null, null, -14), { washout: false, dissolve: false, sweep: false }, 'no tail');
  });

  test('dissolve: only a deep ambient build-in (gradual + rise >= 3.5 s + rise >= 10 dB)', () => {
    assert.deepEqual(transitionFlagsFor({ riseMs: 7500, gradual: true, lufsRise: 35 }, null, -14), { washout: false, dissolve: true, sweep: false });
    assert.deepEqual(transitionFlagsFor({ riseMs: 7500, gradual: true, lufsRise: 6 }, null, -14), { washout: false, dissolve: false, sweep: false }, 'rise too shallow');
    assert.deepEqual(transitionFlagsFor({ riseMs: 3200, gradual: true, lufsRise: 35 }, null, -14), { washout: false, dissolve: false, sweep: false }, 'rise too short');
    assert.deepEqual(transitionFlagsFor({ riseMs: 7500, gradual: false, lufsRise: 35 }, null, -14), { washout: false, dissolve: false, sweep: false }, 'attack head');
    assert.deepEqual(transitionFlagsFor(null, null, -14), { washout: false, dissolve: false, sweep: false }, 'no head');
  });

  test('sweep: a LOUD cold start (rise <= 500 ms AND lufs >= -9.5)', () => {
    assert.deepEqual(transitionFlagsFor({ riseMs: 120, gradual: false, lufsRise: 0 }, null, -8.4), { washout: false, dissolve: false, sweep: true });
    assert.deepEqual(transitionFlagsFor({ riseMs: 120, gradual: false, lufsRise: 0 }, null, -12.3), { washout: false, dissolve: false, sweep: false }, 'cold but normally mastered');
    assert.deepEqual(transitionFlagsFor({ riseMs: 900, gradual: false, lufsRise: 0 }, null, -8.4), { washout: false, dissolve: false, sweep: false }, 'loud but not an attack');
    assert.deepEqual(transitionFlagsFor(null, null, -8.4), { washout: false, dissolve: false, sweep: false }, 'no head, no sweep');
  });

  test('all three can ride one track; malformed numbers never arm anything', () => {
    assert.deepEqual(
      transitionFlagsFor({ riseMs: 120, gradual: false, lufsRise: 0 }, { windMs: 9000, fade: true, lufsDrop: 25 }, -8.4),
      { washout: true, dissolve: false, sweep: true }
    );
    assert.deepEqual(transitionFlagsFor({ riseMs: NaN, gradual: true, lufsRise: 35 }, { windMs: Infinity, fade: true, lufsDrop: 25 }, -14),
      { washout: false, dissolve: false, sweep: false }, 'NaN/Infinity are not measurements');
  });
});

// --- synthetic momentary series -------------------------------------------

function ramp(t0, t1, step, m) {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    const tt = Math.round(t * 1000) / 1000;
    out.push({ t: tt, m: typeof m === 'function' ? m(tt) : m });
  }
  return out;
}

// A deep gradual intro: -45 LU for the first 4 s, ramping to the -10 body
// over 4 more seconds, body to the end. p95 = -10 (the body holds the top
// slots), riseThreshold = -14.44, first above-floor point at t=0 -> the level
// arrives at t=7.6 (the ramp point at 7.5 computes to -14.49, one step short
// of the threshold) => riseMs 7600; startMean (first 1.5 s, all -45) => -45,
// which is 35 dB under the body => gradual, lufsRise 35.
const gradualSeries = [
  ...ramp(0, 4.0, 0.1, -45.0),
  ...ramp(4.1, 8.0, 0.1, (t) => -45 + ((t - 4.1) / 3.9) * 35),
  ...ramp(8.1, 19.9, 0.1, -10.0),
];

// A cold attack: the level is simply THERE from the first frame.
const coldSeries = ramp(0, 19.9, 0.1, -10.0);

// Leading digital padding is padding, not the entry: silence to t=2.0, then
// the cold body. startIdx must skip the padding (lufsRise stays 0, not the
// 50 dB the silence would otherwise "measure").
const paddedColdSeries = [...ramp(0, 1.9, 0.1, -60.0), ...ramp(2.0, 19.9, 0.1, -10.0)];

// A moderate intro: 1.2 s of build -- deeper than cold, shorter than the
// 3 s gradual gate. The middle band keeps the playlist default.
const moderateSeries = [
  ...ramp(0, 1.2, 0.1, (t) => -30 + (t / 1.2) * 20),
  ...ramp(1.3, 19.9, 0.1, -10.0),
];

const silentSeries = ramp(0, 19.9, 0.1, -60.0);

// --- canned stderr (the shapes measured on ffmpeg 7.1.5) -------------------

function frameLine(t, m) {
  const padded = m <= -100 ? `${m}` : `${m} `;
  return `[Parsed_ebur128_0 @ 0x7f5da4001c40] t: ${t}  TARGET:-23 LUFS    M:${padded}S:-120.7     I: -22.6 LUFS       LRA:   6.5 LU`;
}

function headStderrFor(points) {
  return [
    '[aist#0:0/pcm_s16le @ 0x55f5a413f580] Guessed Channel Layout: mono',
    'Input #0, wav, from <file>:',
    '  Duration: 00:00:20.00, bitrate: 705 kb/s',
    points.map((p) => frameLine(p.t, p.m)).join('\n'),
    '[Parsed_ebur128_0 @ 0x7f5da4001c40] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -22.6 LUFS',
    '    Threshold: -33.1 LUFS',
    '',
    '  True peak:',
    '    Peak:      -1.0 dBFS',
  ].join('\n');
}

const loudStderr = [
  '[Parsed_ebur128_0 @ 0x7f5da4001c40] t: 0.0999773  TARGET:-23 LUFS    M:-12.0 S:-12.0     I: -12.0 LUFS       LRA:   0.0 LU',
  '[Parsed_ebur128_0 @ 0x7f5da4001c40] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -12.0 LUFS',
  '    Threshold: -22.0 LUFS',
  '',
  '  True peak:',
  '    Peak:      -1.0 dBFS',
].join('\n');

// The tail pass's canned stderr: the flat cold series keeps the tail a
// non-fade (windMs 0) so the head is the only measured field that matters.
const tailStderr = headStderrFor(coldSeries);

// Val 32: the vocal pass's canned stderr (flat cold series -> no sustained
// band lift -> onset null; the default "unfilled" answer).
const vocalStderr = headStderrFor(coldSeries);

function cannedRunner({ head = headStderrFor(gradualSeries), headError = null, vocal = vocalStderr, vocalError = null, calls = [] } = {}) {
  return async (file, args) => {
    calls.push({ file, args });
    if (args[2] === '-t' && args[3] === '20') {
      if (headError) throw headError;
      return { stderr: head };
    }
    if (args[2] === '-t' && args[3] === '32') {
      if (vocalError) throw vocalError;
      return { stderr: vocal };
    }
    if (args.includes('-sseof')) {
      return { stderr: tailStderr };
    }
    return { stderr: loudStderr };
  };
}

// ONE index writer for the whole file (the autocueTail mtime-cache rule).
let indexStamp = 1_740_000_000_000;
function writeTestIndex(tracks) {
  const idx = config.paths.autocueIndexPath;
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, JSON.stringify({ version: 1, tracks }));
  indexStamp += 1000;
  fs.utimesSync(idx, new Date(indexStamp), new Date(indexStamp));
}

// --- metrics ---------------------------------------------------------------

describe('headMetrics', () => {
  test('a deep gradual intro: riseMs 7600, gradual, lufsRise 35', () => {
    assert.deepEqual(headMetrics(gradualSeries), { riseMs: 7600, gradual: true, lufsRise: 35 });
  });

  test('a cold attack: riseMs 0, not gradual, no rise', () => {
    assert.deepEqual(headMetrics(coldSeries), { riseMs: 0, gradual: false, lufsRise: 0 });
  });

  test('leading digital padding is skipped (padded cold: lufsRise stays 0)', () => {
    // DEVIATION pin, the mirror of the tail suite's paddedColdSeries test:
    // startMean is bounded to the silence-TRIMMED start, so the padding
    // cannot manufacture a "rise" the music never performed.
    assert.deepEqual(headMetrics(paddedColdSeries), { riseMs: 0, gradual: false, lufsRise: 0 });
  });

  test('a moderate 1.2 s build is neither cold nor gradual (the middle band)', () => {
    const head = headMetrics(moderateSeries);
    assert.ok(head.riseMs > 500 && head.riseMs < 3000, `riseMs in the middle band, got ${head.riseMs}`);
    assert.equal(head.gradual, false);
  });

  test('an all-silent window yields zeros', () => {
    assert.deepEqual(headMetrics(silentSeries), { riseMs: 0, gradual: false, lufsRise: 0 });
  });

  test('an empty series throws (callers count failures)', () => {
    assert.throws(() => headMetrics([]));
  });
});

// --- read-time sizing -------------------------------------------------------

describe('fadeInSecondsFor', () => {
  test('a deep gradual intro clamps the measured rise into the 2.5-4.0 band', () => {
    // riseMs 7600 -> clamped 4.0; lufsRise 35 -> t saturates at 1 -> "4.0"
    assert.equal(fadeInSecondsFor({ riseMs: 7600, gradual: true, lufsRise: 35 }), '4.0');
  });

  test('a short-but-gradual rise keeps its own length', () => {
    // riseMs 3100 -> 3.1 s inside the band; deep rise -> t 1 -> "3.1"
    assert.equal(fadeInSecondsFor({ riseMs: 3100, gradual: true, lufsRise: 30 }), '3.1');
  });

  test('a shallow gradual rise trims toward the 2.5 s floor', () => {
    // riseMs 4000 -> 4.0; lufsRise 5 -> t = 2/9 -> 2.5 + 1.5*0.222 = 2.833 -> "2.8"
    assert.equal(fadeInSecondsFor({ riseMs: 4000, gradual: true, lufsRise: 5 }), '2.8');
  });

  test('a hand-edited sub-band gradual rise clamps up to the floor', () => {
    // gradual=true implies riseMs >= 3000 in real measurements; a malformed
    // hand-edited entry below the band still clamps INTO it (crossSecondsFor's
    // sub-8 s clamp, mirrored).
    assert.equal(fadeInSecondsFor({ riseMs: 2000, gradual: true, lufsRise: 30 }), '2.5');
  });

  test('a cold attack gets the short fixed soften', () => {
    assert.equal(fadeInSecondsFor({ riseMs: 0, gradual: false, lufsRise: 0 }), '0.5');
    assert.equal(fadeInSecondsFor({ riseMs: 400, gradual: false, lufsRise: 2 }), '0.5');
  });

  test('the moderate middle band stays null (playlist default stands)', () => {
    assert.equal(fadeInSecondsFor({ riseMs: 1200, gradual: false, lufsRise: 8 }), null);
    assert.equal(fadeInSecondsFor({ riseMs: 2900, gradual: false, lufsRise: 40 }), null); // deep but short
  });

  test('null guards: unmeasured, malformed, non-object', () => {
    assert.equal(fadeInSecondsFor(null), null);
    assert.equal(fadeInSecondsFor(undefined), null);
    assert.equal(fadeInSecondsFor({ riseMs: 8000, gradual: true }), null); // missing lufsRise
    assert.equal(fadeInSecondsFor({ gradual: true, lufsRise: 30 }), null); // missing riseMs
    assert.equal(fadeInSecondsFor('3.0'), null);
  });
});

// --- analyzeHead plumbing ---------------------------------------------------

describe('analyzeHead', () => {
  test('runs ONE input-side -t 20 pass with framelog=info and parses the series', async () => {
    const calls = [];
    const runner = cannedRunner({ calls });
    const head = await analyzeHead('/music/intro.mp3', { runner });
    assert.deepEqual(head, { riseMs: 7600, gradual: true, lufsRise: 35 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      '-hide_banner',
      '-nostats',
      '-t',
      '20',
      '-i',
      '/music/intro.mp3',
      '-filter_complex',
      'ebur128=metadata=1:framelog=info', // the pinned DEVIATION: bare metadata=1 prints 0 frame lines on >= 6.1
      '-f',
      'null',
      '-',
    ]);
  });

  test('rejects when the runner fails (same error contract as analyzeTrack)', async () => {
    const runner = cannedRunner({ headError: new Error('ffmpeg died') });
    await assert.rejects(() => analyzeHead('/music/x.mp3', { runner }), /ffmpeg died/);
  });

  test('rejects a frame-less stderr (the bare metadata=1 output on >= 6.1)', async () => {
    const runner = cannedRunner({ head: 'Summary:\n\n  Integrated loudness:\n    I: -22.6 LUFS\n' });
    await assert.rejects(() => analyzeHead('/music/x.mp3', { runner }), /no momentary frames/);
  });
});

// --- index reads + m3u stamping ----------------------------------------------

describe('fadeInAnnotate + annotateTrackEntry stamping', () => {
  test('a measured gradual head stamps its fade, cold stamps 0.5, exact lines', () => {
    writeTestIndex({
      '/music/gradual.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -12.3,
        peak: -0.5,
        analyzedAt: 'test',
        head: { riseMs: 7500, gradual: true, lufsRise: 35 },
      },
      '/music/coldattack.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -12.3,
        peak: -0.5,
        analyzedAt: 'test',
        head: { riseMs: 0, gradual: false, lufsRise: 0 },
      },
      '/music/hotslam.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -8.4,
        peak: -0.5,
        analyzedAt: 'test',
        head: { riseMs: 120, gradual: false, lufsRise: 0 },
      },
    });
    assert.equal(fadeInAnnotate('/music/gradual.mp3'), '4.0');
    assert.equal(fadeInAnnotate('/music/coldattack.mp3'), '0.5');
    assert.equal(fadeInAnnotate('/music/hotslam.mp3'), '0.5');
    // Val 28 D1 rides the same lines: the deep gradual build-in carries
    // liq_dissolve; a merely-cold normally-mastered start carries nothing;
    // a LOUD cold start (lufs >= -9.5) carries liq_sweep. Order: fade_in,
    // effect flags, amplify, cross.
    assert.equal(
      annotateTrackEntry('/music/gradual.mp3'),
      'annotate:source_tag="music",liq_fade_in="4.0",liq_dissolve="1",liq_amplify="-3.7 dB":/music/gradual.mp3'
    );
    assert.equal(
      annotateTrackEntry('/music/coldattack.mp3'),
      'annotate:source_tag="music",liq_fade_in="0.5",liq_amplify="-3.7 dB":/music/coldattack.mp3'
    );
    assert.equal(
      annotateTrackEntry('/music/hotslam.mp3'),
      'annotate:source_tag="music",liq_fade_in="0.5",liq_sweep="1",liq_amplify="-7.6 dB":/music/hotslam.mp3'
    );
  });

  test('middle-band heads, head-less entries and unscanned tracks keep the 2 s default', () => {
    writeTestIndex({
      '/music/middle.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -12.3,
        peak: -0.5,
        analyzedAt: 'test',
        head: { riseMs: 1200, gradual: false, lufsRise: 8 },
      },
      '/music/prehead.mp3': { mtimeMs: 1, size: 1, lufs: -12.3, peak: -0.5, analyzedAt: 'legacy' },
    });
    assert.equal(fadeInAnnotate('/music/middle.mp3'), null);
    assert.equal(fadeInAnnotate('/music/prehead.mp3'), null); // pre-head-pass entry
    assert.equal(fadeInAnnotate('/music/never-analyzed.mp3'), null);
    // Byte-identical to the pre-Val-28 line for every defaulting track.
    assert.equal(
      annotateTrackEntry('/music/unscanned.mp3'),
      'annotate:source_tag="music",liq_fade_in="2":/music/unscanned.mp3'
    );
  });
});

// --- scan round-trip (canned) -------------------------------------------------

describe('analyzeMissing head round-trip (canned stderr)', () => {
  test('stores the measured head on disk and derives the stamp end-to-end', async () => {
    const dir = path.join(config.dataDir, 'headroundtrip');
    const file = writeWav(path.join(dir, 'intro.wav'), 1);
    const calls = [];
    const summary = await analyzeMissing([file], {
      runner: cannedRunner({ head: headStderrFor(gradualSeries), calls }),
    });
    assert.deepEqual(
      { analyzed: summary.analyzed, failed: summary.failed, tailFailed: summary.tailFailed, headFailed: summary.headFailed, vocalFailed: summary.vocalFailed },
      { analyzed: 1, failed: 0, tailFailed: 0, headFailed: 0, vocalFailed: 0 }
    );
    // Loudness, tail, head, vocal -- in that order.
    assert.equal(calls.length, 4);
    assert.ok(calls[0].args.includes('ebur128=peak=true'));
    assert.ok(calls[1].args.includes('-sseof'));
    assert.deepEqual(calls[2].args.filter((a, i) => (i === 2 && a === '-t') || (i === 3 && a === '20')), ['-t', '20']);
    // The vocal pass: -t 32, through the 250-3200 Hz presence band.
    assert.deepEqual(calls[3].args.filter((a, i) => (i === 2 && a === '-t') || (i === 3 && a === '32')), ['-t', '32']);
    assert.ok(calls[3].args.includes('highpass=f=250,lowpass=f=3200,ebur128=metadata=1:framelog=info'));

    const onDisk = JSON.parse(fs.readFileSync(config.paths.autocueIndexPath, 'utf8'));
    assert.deepEqual(onDisk.tracks[file].head, { riseMs: 7600, gradual: true, lufsRise: 35 });
    assert.deepEqual(onDisk.tracks[file].vocal, { onsetMs: null }); // flat canned series -> unfilled
    assert.equal(fadeInAnnotate(file), '4.0');
    assert.match(annotateTrackEntry(file), /liq_fade_in="4\.0"/);
  });

  test('a failed head pass stores the entry WITHOUT head, counts headFailed, loudness+tail intact', async () => {
    const dir = path.join(config.dataDir, 'headfail');
    const file = writeWav(path.join(dir, 'cold.wav'), 1);
    const summary = await analyzeMissing([file], { runner: cannedRunner({ headError: new Error('boom') }) });
    assert.deepEqual(
      { analyzed: summary.analyzed, failed: summary.failed, tailFailed: summary.tailFailed, headFailed: summary.headFailed, vocalFailed: summary.vocalFailed },
      { analyzed: 1, failed: 0, tailFailed: 0, headFailed: 1, vocalFailed: 0 }
    );
    const onDisk = JSON.parse(fs.readFileSync(config.paths.autocueIndexPath, 'utf8'));
    assert.equal(onDisk.tracks[file].head, undefined);
    assert.equal(onDisk.tracks[file].lufs, -12);
    assert.equal(fadeInAnnotate(file), null); // no measured fade...
    assert.match(annotateTrackEntry(file), /liq_fade_in="2"/); // ...default stands
  });
});

// --- real-ffmpeg integration (skip-guarded, the autocueLoudness pattern) -----

describe('analyzeHead against REAL generated audio', { skip: SKIP_REASON }, () => {
  test('a cold attack (constant sine from t=0) classifies cold -> 0.5 s', async () => {
    const file = writeWav(path.join(config.dataDir, 'real', 'cold.wav'), 10);
    const head = await analyzeHead(file);
    assert.ok(head.riseMs <= 500, `constant sine must arrive fast, got riseMs ${head.riseMs}`);
    assert.equal(head.gradual, false);
    assert.equal(fadeInSecondsFor(head), '0.5');
  });

  test('a deep cubic fade-in (8 s) classifies gradual -> the 4.0 s ceiling', async () => {
    const file = path.join(config.dataDir, 'real', 'fadein.wav');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // curve=cub is the CUBIC fade (x^3): it spends its first seconds DEEP
    // under the body -- the shape real quiet intros have. (curve=cbr is the
    // cube ROOT: near-instant rise, i.e. the moderate/cold side -- measured
    // live while writing this test: cbr's whole envelope spans ~4 dB.)
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
      '-af', 'volume=0.3,afade=t=in:st=0:d=8:curve=cub',
      '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
      file,
    ]);
    const head = await analyzeHead(file);
    assert.ok(head.riseMs >= 3000, `an 8 s deep fade must rise slowly, got riseMs ${head.riseMs}`);
    assert.equal(head.gradual, true, `expected gradual, got ${JSON.stringify(head)}`);
    const stamp = fadeInSecondsFor(head);
    assert.ok(stamp !== null && Number.parseFloat(stamp) >= 2.5 && Number.parseFloat(stamp) <= 4.0, `stamp in band, got ${stamp}`);
  });
});
