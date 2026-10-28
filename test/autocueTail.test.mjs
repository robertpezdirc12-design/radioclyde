// Ending-aware crossfade regression tests: lib/autocue.js's ebur128 tail pass
// (momentary parser, tail metrics, cross-stamp derivation), its storage
// through analyzeMissing, and the wiring into director/playlist.js's
// annotateTrackEntry -- the Node half of the contract with radio.liq's CROSS
// STAMPS block (the Liquidsoap half is pinned in test/djTransitions.test.mjs).
//
// NO real ffmpeg in this suite: the runner seam (analyzeTrack/analyzeTail/
// analyzeMissing all accept {runner}) injects canned stderr in the exact
// shapes measured on this box (ffmpeg 7.1.5 -- see the parser tests), and the
// pure functions get synthetic momentary series. The whole pipe against real
// generated fades was verified manually out-of-band (worklog 6-b).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav } from './fixtures.mjs';

setupTestConfig('autocue-tail', {
  autocue: { targetLufs: -16, maxGainDb: 6 },
});

const { config } = await import('../src/config/index.js');
const {
  parseEbur128Momentary,
  tailMetrics,
  analyzeTail,
  crossSecondsFor,
  crossfadeAnnotate,
  analyzeMissing,
} = await import('../src/lib/autocue.js');
const { annotateTrackEntry, annotateSpeechEntry, annotateJingleEntry } = await import(
  '../src/director/playlist.js'
);

// --- synthetic momentary series -------------------------------------------

// Points at a fixed step; `m` is a constant or (t)=>value. t is rounded to
// kill the float drift of the 0.1 step so the windMs assertions are exact.
function ramp(t0, t1, step, m) {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    const tt = Math.round(t * 1000) / 1000;
    out.push({ t: tt, m: typeof m === 'function' ? m(tt) : m });
  }
  return out;
}

// 20 s window @ 100 ms (the -sseof cadence ebur128 actually prints): loud
// body at -10, first sub-threshold point at 12.5, plateau at -42.6 across the
// trimmed final 1.5 s (t 18.0..19.5), digital padding after. The body holds
// the top 125 of 200 sorted slots, so p95 = -10 exactly.
const fadeSeries = [
  ...ramp(0, 12.4, 0.1, -10.0),
  { t: 12.5, m: -15.0 },
  ...ramp(12.6, 17.9, 0.1, (t) => -15 - ((t - 12.6) / 5.3) * 27.6),
  ...ramp(18.0, 19.5, 0.1, -42.6),
  ...ramp(19.6, 19.9, 0.1, -60.0),
];
// -> endIdx t=19.5, k t=12.4 => windMs 7100; tailMean -42.6 => drop 32.6.

// Gentle fade: body to 9.4, plateau at -39.8 over the trimmed final 1.5 s
// (t 17.9..19.4), padding after => windMs 10000, drop 29.8, stamp "10.0".
const gentleFadeSeries = [
  ...ramp(0, 9.4, 0.1, -10.0),
  { t: 9.5, m: -15.0 },
  ...ramp(9.6, 17.8, 0.1, (t) => -15 - ((t - 9.6) / 8.2) * 24.8),
  ...ramp(17.9, 19.4, 0.1, -39.8),
  ...ramp(19.5, 19.9, 0.1, -60.0),
];

const coldSeries = ramp(0, 19.9, 0.1, -10.0);
const paddedColdSeries = [...ramp(0, 17.9, 0.1, -10.0), ...ramp(18.0, 19.9, 0.1, -60.0)];
const shortWindSeries = [
  ...ramp(0, 17.4, 0.1, -10.0),
  { t: 17.5, m: -15.0 },
  ...ramp(17.6, 19.9, 0.1, -42.6),
];
const silentSeries = ramp(0, 19.9, 0.1, -60.0);

// --- canned stderr (shapes measured on ffmpeg 7.1.5) -----------------------

// The 7.x frame line: no colon after t, no space before M when the value is
// wide (ffmpeg pads to a fixed width, so "M: -41.7" occurs too -- the parser
// must accept both).
function frameLine(t, m) {
  const padded = m <= -100 ? `${m}` : `${m} `;
  return `[Parsed_ebur128_0 @ 0x7f5da4001c40] t: ${t}  TARGET:-23 LUFS    M:${padded}S:-120.7     I: -22.6 LUFS       LRA:   6.5 LU`;
}

function tailStderrFor(points) {
  return [
    '[aist#0:0/pcm_s16le @ 0x55f5a413f580] Guessed Channel Layout: mono',
    'Input #0, wav, from <file>:',
    '  Duration: 00:00:30.00, bitrate: 705 kb/s',
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

// The loudness pass's canned stderr (what analyzeTrack parses off the LAST
// Summary block): I: -12.0 LUFS, Peak: -1.0 dBFS.
const loudStderr = [
  '[Parsed_ebur128_0 @ 0x7f5da4001c40] t: 0.0999773  TARGET:-23 LUFS    M:-12.0 S:-12.0     I: -12.0 LUFS       LRA:   0.0 LU',
  '[Parsed_ebur128_0 @ 0x7f5da4001c40] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -12.0 LUFS',
  '    Threshold: -22.0 LUFS',
  '',
  '  Loudness range:',
  '    LRA:         0.0 LU',
  '    Threshold: -22.0 LUFS',
  '    LRA low:   -12.0 LUFS',
  '    LRA high:  -12.0 LUFS',
  '',
  '  True peak:',
  '    Peak:      -1.0 dBFS',
].join('\n');

// A runner answering the loudness pass, the tail pass, the head pass
// (Val 28 B1) and the vocal pass (Val 32) with canned stderr -- switching
// on the exact flag shapes of the four real execFileAsync calls
// (-sseof = tail, leading -t 20 = head, leading -t 32 = vocal, neither =
// loudness) -- and recording every call's args for pinning.
function cannedRunner({ tail = tailStderrFor(fadeSeries), tailError = null, head = tailStderrFor(coldSeries), headError = null, vocal = tailStderrFor(coldSeries), vocalError = null, calls = [] } = {}) {
  return async (file, args) => {
    calls.push({ file, args });
    if (args.includes('-sseof')) {
      if (tailError) throw tailError;
      return { stderr: tail };
    }
    if (args[2] === '-t' && args[3] === '20') {
      if (headError) throw headError;
      return { stderr: head };
    }
    if (args[2] === '-t' && args[3] === '32') {
      if (vocalError) throw vocalError;
      return { stderr: vocal };
    }
    return { stderr: loudStderr };
  };
}

// ONE index writer for the whole file: the mtime stamps must be strictly
// increasing across suites, or readIndexFresh's mtime cache would serve a
// stale copy between two same-millisecond writes.
let indexStamp = 1_730_000_000_000;
function writeTestIndex(tracks) {
  const idx = config.paths.autocueIndexPath;
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, JSON.stringify({ version: 1, tracks }));
  indexStamp += 1000;
  fs.utimesSync(idx, new Date(indexStamp), new Date(indexStamp));
}

// --- parser ----------------------------------------------------------------

describe('parseEbur128Momentary', () => {
  test('parses the measured ffmpeg 7.x frame line (no colon after t, no space before M)', () => {
    const stderr = [
      '[Parsed_ebur128_0 @ 0x7f5da4001c40] t: 0.0999773  TARGET:-23 LUFS    M:-18.5 S:-19.2     I: -22.6 LUFS       LRA:   6.5 LU',
      '[Parsed_ebur128_0 @ 0x7f5da4001c40] t: 0.199977   TARGET:-23 LUFS    M: -41.7 S:-32.7     I: -22.6 LUFS       LRA:   6.5 LU',
    ].join('\n');
    assert.deepEqual(parseEbur128Momentary(stderr), [
      { t: 0.0999773, m: -18.5 },
      { t: 0.199977, m: -41.7 },
    ]);
  });

  test('accepts the older colon format (t: <n>: ... M: <v>)', () => {
    const stderr = '[Parsed_ebur128_0 @ 0x1] t: 0.500000:  TARGET:-23 LUFS    M: -18.5 S: -19.2';
    assert.deepEqual(parseEbur128Momentary(stderr), [{ t: 0.5, m: -18.5 }]);
  });

  test('maps -inf to the -60 floor (older builds print it for silence)', () => {
    const stderr = '[Parsed_ebur128_0 @ 0x1] t: 1.0  TARGET:-23 LUFS    M:-inf S:-inf';
    assert.deepEqual(parseEbur128Momentary(stderr), [{ t: 1, m: -60 }]);
  });

  test('clamps everything below -60 LUFS to the floor (7.x digital silence prints ~-163)', () => {
    const stderr = [
      '[Parsed_ebur128_0 @ 0x1] t: 1.0  TARGET:-23 LUFS    M:-163.2 S:-171.9',
      '[Parsed_ebur128_0 @ 0x1] t: 2.0  TARGET:-23 LUFS    M:-59.9 S:-60.0',
    ].join('\n');
    assert.deepEqual(parseEbur128Momentary(stderr), [
      { t: 1, m: -60 },
      { t: 2, m: -59.9 },
    ]);
  });

  test('banner and Summary lines never parse (t: + M: must share a line)', () => {
    const stderr = tailStderrFor([
      { t: 1, m: -18.5 },
      { t: 2, m: -20 },
    ]);
    const parsed = parseEbur128Momentary(stderr);
    // The decoder banner ("Layout:"), the input banner and the Summary block
    // (I:/Peak:) are all present in there; only the two frame lines survive.
    assert.deepEqual(parsed, [
      { t: 1, m: -18.5 },
      { t: 2, m: -20 },
    ]);
  });

  test('sorts an out-of-order series by t', () => {
    const stderr = [
      '[Parsed_ebur128_0 @ 0x1] t: 2.0  TARGET:-23 LUFS    M:-20.0 S:-20.0',
      '[Parsed_ebur128_0 @ 0x1] t: 3.0  TARGET:-23 LUFS    M:-21.0 S:-21.0',
      '[Parsed_ebur128_0 @ 0x1] t: 1.0  TARGET:-23 LUFS    M:-18.5 S:-18.5',
    ].join('\n');
    assert.deepEqual(parseEbur128Momentary(stderr).map((p) => p.t), [1, 2, 3]);
  });

  test('a stderr with no frame lines yields an empty series', () => {
    // Exactly what the brief's bare `ebur128=metadata=1` produces on
    // ffmpeg >= 6.1 (measured: 0 frame lines) -- analyzeTail must reject it.
    assert.deepEqual(parseEbur128Momentary('Summary:\n\n  Integrated loudness:\n    I: -22.6 LUFS'), []);
    assert.deepEqual(parseEbur128Momentary(''), []);
  });
});

// --- metrics ---------------------------------------------------------------

describe('tailMetrics', () => {
  test('a clear fade-out: windMs 7100, lufsDrop 32.6', () => {
    assert.deepEqual(tailMetrics(fadeSeries), { windMs: 7100, fade: true, lufsDrop: 32.6 });
  });

  test('a gentle fade: windMs 10000, lufsDrop 29.8', () => {
    assert.deepEqual(tailMetrics(gentleFadeSeries), { windMs: 10000, fade: true, lufsDrop: 29.8 });
  });

  test('a cold ending (loud to the last frame): zeros, no fade', () => {
    assert.deepEqual(tailMetrics(coldSeries), { windMs: 0, fade: false, lufsDrop: 0 });
  });

  test('trailing digital padding is ignored (padded cold: drop stays 0)', () => {
    // DEVIATION 3 pin: tailMean is bounded to the silence-TRIMMED ending; an
    // unbounded mean would let the 2 s of padding inflate lufsDrop past 0.
    assert.deepEqual(tailMetrics(paddedColdSeries), { windMs: 0, fade: false, lufsDrop: 0 });
  });

  test('a deep but short (< 3 s) drop is NOT a fade', () => {
    const tail = tailMetrics(shortWindSeries);
    assert.equal(tail.windMs, 2500);
    assert.equal(tail.fade, false); // windMs < 3000, even though the drop is deep
    assert.equal(tail.lufsDrop, 32.6);
  });

  test('an all-silent window yields zeros', () => {
    assert.deepEqual(tailMetrics(silentSeries), { windMs: 0, fade: false, lufsDrop: 0 });
  });

  test('an empty series throws (callers count failures)', () => {
    assert.throws(() => tailMetrics([]));
  });
});

// --- analyzeTail plumbing ---------------------------------------------------

describe('analyzeTail', () => {
  test('runs ONE -sseof -20 pass with framelog=info and parses the series', async () => {
    const calls = [];
    const runner = cannedRunner({ calls });
    const tail = await analyzeTail('/music/fade.mp3', { runner });
    assert.deepEqual(tail, { windMs: 7100, fade: true, lufsDrop: 32.6 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      '-hide_banner',
      '-nostats',
      '-sseof',
      '-20',
      '-i',
      '/music/fade.mp3',
      '-filter_complex',
      'ebur128=metadata=1:framelog=info', // DEVIATION 1: metadata=1 alone prints 0 frame lines on ffmpeg >= 6.1
      '-f',
      'null',
      '-',
    ]);
  });

  test('rejects when the runner fails (same error contract as analyzeTrack)', async () => {
    const runner = cannedRunner({ tailError: new Error('ffmpeg died') });
    await assert.rejects(() => analyzeTail('/music/x.mp3', { runner }), /ffmpeg died/);
  });

  test('rejects a frame-less stderr (the bare metadata=1 output on >= 6.1)', async () => {
    const runner = cannedRunner({ tail: 'Summary:\n\n  Integrated loudness:\n    I: -22.6 LUFS\n' });
    await assert.rejects(() => analyzeTail('/music/x.mp3', { runner }), /no momentary frames/);
  });
});

// --- read-time sizing -------------------------------------------------------

describe('crossSecondsFor', () => {
  test('a shallow drop (<= 3 dB) trims to the 8 s floor', () => {
    assert.equal(crossSecondsFor({ windMs: 11000, fade: true, lufsDrop: 2 }), '8.0');
  });

  test('a deep drop (>= 12 dB) keeps the full wind-down', () => {
    assert.equal(crossSecondsFor({ windMs: 11000, fade: true, lufsDrop: 12 }), '11.0');
  });

  test('a mid drop interpolates and quantizes to 0.1', () => {
    // t = (7.5 - 3) / 9 = 0.5; windSec 10.85 -> 8 + 2.85*0.5 = 9.425 -> "9.4"
    assert.equal(crossSecondsFor({ windMs: 10850, fade: true, lufsDrop: 7.5 }), '9.4');
  });

  test('wind-downs past 12 s clamp to 12', () => {
    assert.equal(crossSecondsFor({ windMs: 25000, fade: true, lufsDrop: 20 }), '12.0');
  });

  test('a hand-edited sub-3 s wind can never produce a sub-8 s stamp', () => {
    // fade=true implies windMs >= 3000 in real measurements (tailMetrics);
    // a malformed hand-edited entry still clamps into the 8..12 band.
    assert.equal(crossSecondsFor({ windMs: 2000, fade: true, lufsDrop: 20 }), '8.0');
  });

  test('null guards: non-fade, missing fields, non-object', () => {
    assert.equal(crossSecondsFor(null), null);
    assert.equal(crossSecondsFor(undefined), null);
    assert.equal(crossSecondsFor({ windMs: 9000, fade: false, lufsDrop: 25 }), null);
    assert.equal(crossSecondsFor({ windMs: 9000, fade: true }), null); // missing lufsDrop
    assert.equal(crossSecondsFor('9.0'), null);
  });
});

// --- index reads -------------------------------------------------------------

describe('crossfadeAnnotate', () => {
  test('derives the stamp from a stored fade tail', () => {
    writeTestIndex({
      '/music/gentle.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -10,
        peak: -1,
        analyzedAt: 'test',
        tail: { windMs: 10000, fade: true, lufsDrop: 29.8 },
      },
    });
    assert.equal(crossfadeAnnotate('/music/gentle.mp3'), '10.0');
  });

  test('cold tails, tail-less entries and unknown tracks never stamp', () => {
    writeTestIndex({
      '/music/cold.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -10,
        peak: -1,
        analyzedAt: 'test',
        tail: { windMs: 0, fade: false, lufsDrop: 0 },
      },
      '/music/old.mp3': { mtimeMs: 1, size: 1, lufs: -10, peak: -1, analyzedAt: 'test' },
    });
    assert.equal(crossfadeAnnotate('/music/cold.mp3'), null);
    assert.equal(crossfadeAnnotate('/music/old.mp3'), null); // pre-tail-pass entry
    assert.equal(crossfadeAnnotate('/music/never-analyzed.mp3'), null);
  });
});

// --- scan round-trip ---------------------------------------------------------

describe('analyzeMissing tail round-trip (canned stderr)', () => {
  test('stores the measured tail on disk and derives the stamp end-to-end', async () => {
    const dir = path.join(config.dataDir, 'roundtrip');
    const file = writeWav(path.join(dir, 'fade.wav'), 1);
    const calls = [];
    const summary = await analyzeMissing([file], {
      runner: cannedRunner({ tail: tailStderrFor(gentleFadeSeries), calls }),
    });

    assert.deepEqual(
      {
        analyzed: summary.analyzed,
        skipped: summary.skipped,
        failed: summary.failed,
        tailFailed: summary.tailFailed,
        headFailed: summary.headFailed,
        vocalFailed: summary.vocalFailed,
      },
      { analyzed: 1, skipped: 0, failed: 0, tailFailed: 0, headFailed: 0, vocalFailed: 0 }
    );
    // Loudness pass first, tail pass second, head pass third, vocal pass
    // fourth (the order that guarantees loudness never regresses on a
    // tail/head/vocal failure).
    assert.equal(calls.length, 4);
    assert.ok(calls[0].args.includes('ebur128=peak=true'));
    assert.ok(!calls[0].args.includes('-sseof'));
    assert.deepEqual(calls[1].args.filter((a) => a === '-sseof' || a === '-20'), ['-sseof', '-20']);
    assert.ok(calls[1].args.includes('ebur128=metadata=1:framelog=info')); // pinned DEVIATION 1
    assert.deepEqual(calls[2].args.filter((a, i) => (i === 2 && a === '-t') || (i === 3 && a === '20')), ['-t', '20']);
    // The vocal pass: -t 32 through the presence band (Val 32).
    assert.deepEqual(calls[3].args.filter((a, i) => (i === 2 && a === '-t') || (i === 3 && a === '32')), ['-t', '32']);
    assert.ok(calls[3].args.includes('highpass=f=250,lowpass=f=3200,ebur128=metadata=1:framelog=info'));

    const onDisk = JSON.parse(fs.readFileSync(config.paths.autocueIndexPath, 'utf8'));
    assert.deepEqual(onDisk.tracks[file].tail, { windMs: 10000, fade: true, lufsDrop: 29.8 });
    // The canned head is the flat cold series -> the cold regime lands too.
    assert.deepEqual(onDisk.tracks[file].head, { riseMs: 0, gradual: false, lufsRise: 0 });
    // The canned vocal is the same flat series -> unfilled (onset null).
    assert.deepEqual(onDisk.tracks[file].vocal, { onsetMs: null });
    assert.equal(onDisk.tracks[file].lufs, -12); // loudness from the canned Summary
    assert.equal(crossfadeAnnotate(file), '10.0');
  });

  test('a failed tail pass stores the entry WITHOUT tail, counts tailFailed, loudness intact', async () => {
    const dir = path.join(config.dataDir, 'tailfail');
    const file = writeWav(path.join(dir, 'cold.wav'), 1);
    const summary = await analyzeMissing([file], { runner: cannedRunner({ tailError: new Error('boom') }) });
    assert.deepEqual(
      { analyzed: summary.analyzed, failed: summary.failed, tailFailed: summary.tailFailed, headFailed: summary.headFailed, vocalFailed: summary.vocalFailed },
      { analyzed: 1, failed: 0, tailFailed: 1, headFailed: 0, vocalFailed: 0 }
    );
    const onDisk = JSON.parse(fs.readFileSync(config.paths.autocueIndexPath, 'utf8'));
    assert.equal(onDisk.tracks[file].tail, undefined);
    assert.deepEqual(onDisk.tracks[file].head, { riseMs: 0, gradual: false, lufsRise: 0 });
    assert.equal(onDisk.tracks[file].lufs, -12);
    assert.equal(crossfadeAnnotate(file), null); // no stamp...
    assert.match(annotateTrackEntry(file), /liq_amplify=/); // ...but loudness is intact
  });

  test('an unchanged file is skipped -- old entries never gain a tail without re-analysis', async () => {
    const dir = path.join(config.dataDir, 'oldentry');
    const file = writeWav(path.join(dir, 'legacy.wav'), 1);
    const stat = fs.statSync(file);
    // A pre-tail-pass entry whose mtimeMs+size still matches: the scan must
    // skip it (zero ffmpeg calls) and the entry must stay tail-less (and
    // head-less -- the same skip rule covers both passes).
    writeTestIndex({ [file]: { mtimeMs: stat.mtimeMs, size: stat.size, lufs: -14, peak: -2, analyzedAt: 'legacy' } });
    const calls = [];
    const summary = await analyzeMissing([file], { runner: cannedRunner({ calls }) });
    assert.deepEqual(
      { analyzed: summary.analyzed, skipped: summary.skipped, tailFailed: summary.tailFailed, headFailed: summary.headFailed, vocalFailed: summary.vocalFailed },
      { analyzed: 0, skipped: 1, tailFailed: 0, headFailed: 0, vocalFailed: 0 }
    );
    assert.equal(calls.length, 0);
    assert.equal(crossfadeAnnotate(file), null);
  });
});

// --- m3u stamping -------------------------------------------------------------

describe('annotateTrackEntry liq_cross_duration stamping', () => {
  test('a fade tail gets the stamp, after liq_amplify (exact line)', () => {
    writeTestIndex({
      '/music/tail.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -12.3,
        peak: -0.5,
        analyzedAt: 'test',
        tail: { windMs: 9000, fade: true, lufsDrop: 25 },
      },
    });
    // Val 28 D1: an EPIC fade-out ending (windMs 9 s + drop 25 dB, both past
    // the washout thresholds) also arms the dormant washout effect.
    assert.equal(
      annotateTrackEntry('/music/tail.mp3'),
      'annotate:source_tag="music",liq_fade_in="2",liq_washout="1",liq_amplify="-3.7 dB",liq_cross_duration="9.0":/music/tail.mp3'
    );
  });

  test('cold tails, old entries and unscanned tracks get NO stamp (3.5 s default stands)', () => {
    writeTestIndex({
      '/music/cold2.mp3': {
        mtimeMs: 1,
        size: 1,
        lufs: -12.3,
        peak: -0.5,
        analyzedAt: 'test',
        tail: { windMs: 0, fade: false, lufsDrop: 0 },
      },
      '/music/old2.mp3': { mtimeMs: 1, size: 1, lufs: -12.3, peak: -0.5, analyzedAt: 'test' },
    });
    // Cold: loudness stamp only, no cross stamp.
    assert.equal(
      annotateTrackEntry('/music/cold2.mp3'),
      'annotate:source_tag="music",liq_fade_in="2",liq_amplify="-3.7 dB":/music/cold2.mp3'
    );
    // Old index entry (pre-tail-pass): never stamped.
    assert.equal(
      annotateTrackEntry('/music/old2.mp3'),
      'annotate:source_tag="music",liq_fade_in="2",liq_amplify="-3.7 dB":/music/old2.mp3'
    );
    // No index entry at all: byte-identical to the pre-feature line.
    assert.equal(annotateTrackEntry('/music/unscanned2.mp3'), 'annotate:source_tag="music",liq_fade_in="2":/music/unscanned2.mp3');
  });

  test('speech and jingle entries never carry the stamp', () => {
    // By construction: only annotateTrackEntry reads crossfadeAnnotate, and
    // the scan only measures library music files.
    const speech = annotateSpeechEntry('/music/dj.wav', 'Show', 'Station', ['Elena']);
    const jingle = annotateJingleEntry('/music/jingle.wav', 'Show', 'Station');
    assert.doesNotMatch(speech, /liq_cross_duration/);
    assert.doesNotMatch(jingle, /liq_cross_duration/);
  });
});
