// Val 32 regression tests: lib/autocue.js's VOCAL pass -- the third offline
// ebur128 measurement (band-limited 250-3200 Hz momentary series over the
// first 32 s) -- plus the read-time ramp window derivation, the pure ramp
// decision (rampStampFor), the annotate wiring in director/playlist.js
// (liq_ramp on BOTH sides of a verified speech->track seam,
// liq_cross_duration sizing the speech clip), the seam walker
// (resolveRampSeams), and -- like the head suite -- a REAL-ffmpeg
// integration block that generates an actual quiet-then-busy intro and
// proves the detector end-to-end (skip-guarded, the autocueLoudness honesty
// pattern: no ffmpeg on the box means the suite skips, not fails).
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

setupTestConfig('autocue-vocal', {
  autocue: { targetLufs: -16, maxGainDb: 6 },
});

const { config } = await import('../src/config/index.js');
const {
  vocalMetrics,
  analyzeVocal,
  rampWindowSecondsFor,
  rampTalkEnabled,
  rampStampFor,
  analyzeMissing,
} = await import('../src/lib/autocue.js');
const {
  annotateSpeechEntry,
  annotateTrackEntry,
  resolveRampSeams,
} = await import('../src/director/playlist.js');

// --- series builders ---------------------------------------------------------

function ramp(from, to, step, value) {
  const points = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    points.push({ t: Math.round(t * 10000) / 10000, m: typeof value === 'function' ? value(t) : value });
  }
  return points;
}

// A talkable intro: quiet band (baseline -45) for 10 s, then the fill-in
// (-10, a 35 dB sustained lift) to the end of the 32 s window. Baseline =
// mean of the first 1.5 s after the trimmed start = -45; threshold -40.5;
// the first point above it holds -> onsetMs 10000.
const talkableSeries = [
  ...ramp(0, 9.9, 0.1, -45.0),
  ...ramp(10.0, 31.9, 0.1, -10.0),
];

// A transient (a drum fill): the band lifts for 0.5 s at t=6, then falls
// back; the REAL fill-in arrives at 15 s and holds.
const transientSeries = [
  ...ramp(0, 5.9, 0.1, -45.0),
  ...ramp(6.0, 6.5, 0.1, -8.0),
  ...ramp(6.6, 14.9, 0.1, -45.0),
  ...ramp(15.0, 31.9, 0.1, -10.0),
];

// Busy from the top: the baseline IS the busy level, and nothing sustains
// +4.5 dB above it -> onset null (vocals from the first bar carry no window).
const busySeries = ramp(0, 31.9, 0.1, -10.0);

// Leading digital silence: padding around the entry, not the entry -- the
// baseline is measured from the trimmed start (t=2.0), not from 0.
const paddedSeries = [
  ...ramp(0, 1.9, 0.1, -60.0),
  ...ramp(2.0, 11.9, 0.1, -45.0),
  ...ramp(12.0, 31.9, 0.1, -10.0),
];

// A rise that only STARTS inside the last 1.2 s of the window: the sustain
// window would extend past the measured series, so the rise is unverifiable
// -> onset null (the honest answer, not a guess).
const edgeSeries = [
  ...ramp(0, 30.9, 0.1, -45.0),
  ...ramp(31.0, 31.9, 0.1, -10.0),
];

// --- vocalMetrics (pure) -----------------------------------------------------

describe('vocalMetrics', () => {
  test('a quiet intro that fills in at 10 s -> onsetMs 10000', () => {
    assert.deepEqual(vocalMetrics(talkableSeries), { onsetMs: 10000 });
  });

  test('a transient lift does not sustain -> onset only at the real fill-in', () => {
    assert.deepEqual(vocalMetrics(transientSeries), { onsetMs: 15000 });
  });

  test('busy from the top -> onset null (no window over a vocal head)', () => {
    assert.deepEqual(vocalMetrics(busySeries), { onsetMs: null });
  });

  test('leading digital silence is skipped -- the baseline starts at the entry', () => {
    // Baseline over [2.0, 3.5] = -45; threshold -40.5; the fill-in at 12.0.
    assert.deepEqual(vocalMetrics(paddedSeries), { onsetMs: 12000 });
  });

  test('a rise at the window edge is unverifiable -> onset null', () => {
    assert.deepEqual(vocalMetrics(edgeSeries), { onsetMs: null });
  });

  test('an all-silent window -> onset null; an empty series throws', () => {
    assert.deepEqual(vocalMetrics(ramp(0, 31.9, 0.1, -60.0)), { onsetMs: null });
    assert.throws(() => vocalMetrics([]), /empty momentary series/);
    assert.throws(() => vocalMetrics('nope'), /empty momentary series/);
  });

  test('the sustain gate: a lift that holds for only 1.1 s does not count', () => {
    // Threshold is baseline+4.5 = -40.5. Points at -38 from 10.0 to 11.1
    // (1.1 s) then back down: never a full 1.2 s window above threshold.
    const series = [
      ...ramp(0, 9.9, 0.1, -45.0),
      ...ramp(10.0, 11.1, 0.1, -38.0),
      ...ramp(11.2, 31.9, 0.1, -45.0),
    ];
    assert.deepEqual(vocalMetrics(series), { onsetMs: null });
  });
});

// --- rampWindowSecondsFor (pure read-time derivation) -------------------------

describe('rampWindowSecondsFor', () => {
  test('onset 10 s -> window 8.5 (margin 1.5 s off the onset)', () => {
    assert.equal(rampWindowSecondsFor({ onsetMs: 10000 }), 8.5);
  });

  test('onset 6.5 s -> exactly the 5 s minimum window', () => {
    assert.equal(rampWindowSecondsFor({ onsetMs: 6500 }), 5);
  });

  test('onset 6.4 s -> null (below the minimum window)', () => {
    assert.equal(rampWindowSecondsFor({ onsetMs: 6400 }), null);
  });

  test('unfilled, unmeasured and malformed entries -> null (pass-through)', () => {
    assert.equal(rampWindowSecondsFor({ onsetMs: null }), null);
    assert.equal(rampWindowSecondsFor(null), null);
    assert.equal(rampWindowSecondsFor({}), null);
    assert.equal(rampWindowSecondsFor({ onsetMs: 'soon' }), null);
    assert.equal(rampWindowSecondsFor('nope'), null);
  });
});

// --- rampTalkEnabled (config seam) --------------------------------------------

describe('rampTalkEnabled (F2: absent/junk = shipped default ON, false = OFF)', () => {
  test('absent config -> enabled (the knob is opt-out, like beds is opt-in)', () => {
    // setupTestConfig wrote autocue without rampTalk.
    assert.equal(rampTalkEnabled(), true);
  });
});

// --- rampStampFor (the pure decision) -----------------------------------------

describe('rampStampFor', () => {
  test('a fitting single intro clip -> { dur } quantized to 0.1 s', () => {
    assert.deepEqual(rampStampFor({ slots: ['intro'], speechSeconds: 6.24, vocal: { onsetMs: 10000 } }), { dur: '6.2' });
    assert.deepEqual(rampStampFor({ slots: ['quizIntro'], speechSeconds: 8.5, vocal: { onsetMs: 20000 } }), { dur: '8.5' });
  });

  test('enabled: false -> null (the one deliberate OFF value)', () => {
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 6, vocal: { onsetMs: 10000 }, enabled: false }), null);
  });

  test('a spliced run (open + intro) -> null: station business stays sequential', () => {
    assert.equal(rampStampFor({ slots: ['open', 'intro'], speechSeconds: 6, vocal: { onsetMs: 10000 } }), null);
    assert.equal(rampStampFor({ slots: ['intro', 'intro'], speechSeconds: 6, vocal: { onsetMs: 10000 } }), null);
  });

  test('every other slot -> null (recap/close/tease/dj/plain live)', () => {
    for (const slot of ['recap', 'close', 'open', 'tease', 'dj', 'live:weather', 'quizReveal']) {
      assert.equal(rampStampFor({ slots: [slot], speechSeconds: 6, vocal: { onsetMs: 10000 } }), null, slot);
    }
  });

  test('no slot information / bad durations -> null (never a guessed ramp)', () => {
    assert.equal(rampStampFor({ slots: undefined, speechSeconds: 6, vocal: { onsetMs: 10000 } }), null);
    assert.equal(rampStampFor({ slots: [], speechSeconds: 6, vocal: { onsetMs: 10000 } }), null);
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: NaN, vocal: { onsetMs: 10000 } }), null);
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 0, vocal: { onsetMs: 10000 } }), null);
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: -3, vocal: { onsetMs: 10000 } }), null);
  });

  test('speech longer than the window -> null (the last word must clear the fill-in)', () => {
    // window 8.5 (onset 10 s): an 8.6 s clip does not fit, an 8.5 s one does.
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 8.6, vocal: { onsetMs: 10000 } }), null);
    assert.deepEqual(rampStampFor({ slots: ['intro'], speechSeconds: 8.5, vocal: { onsetMs: 10000 } }), { dur: '8.5' });
  });

  test('speech over the 20 s budget -> null (under cross_stamps\u2019 30 s cap, with room)', () => {
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 20.1, vocal: { onsetMs: 30000 } }), null);
    assert.deepEqual(rampStampFor({ slots: ['intro'], speechSeconds: 20, vocal: { onsetMs: 30000 } }), { dur: '20.0' });
  });

  test('unmeasured / unfilled vocal -> null (data-gated: no measurement, no ramp)', () => {
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 6, vocal: null }), null);
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 6, vocal: { onsetMs: null } }), null);
    assert.equal(rampStampFor({ slots: ['intro'], speechSeconds: 6, vocal: undefined }), null);
  });
});

// --- annotate wiring ----------------------------------------------------------

describe('annotate ramp stamps', () => {
  test('speech entry: ramp adds liq_ramp + liq_cross_duration after liq_fade_in', () => {
    assert.equal(
      annotateSpeechEntry('/show/speech_000.wav', 'Show', 'Station', ['Elena'], { dur: '6.2' }),
      'annotate:source_tag="speech",liq_fade_in="0",liq_ramp="1",liq_cross_duration="6.2",title="Show",artist="Station",dj="Elena":/show/speech_000.wav'
    );
  });

  test('speech entry without a ramp -> byte-identical to the pre-Val-32 line', () => {
    assert.equal(
      annotateSpeechEntry('/show/speech_000.wav', 'Show', 'Station', ['Elena']),
      'annotate:source_tag="speech",liq_fade_in="0",title="Show",artist="Station",dj="Elena":/show/speech_000.wav'
    );
    assert.equal(
      annotateSpeechEntry('/show/speech_000.wav', 'Show', 'Station', ['Elena'], null),
      'annotate:source_tag="speech",liq_fade_in="0",title="Show",artist="Station",dj="Elena":/show/speech_000.wav'
    );
  });

  test('track entry: ramp adds liq_ramp right after liq_fade_in; without it, unchanged', () => {
    assert.equal(
      annotateTrackEntry('/music/unscanned.mp3', true),
      'annotate:source_tag="music",liq_fade_in="2",liq_ramp="1":/music/unscanned.mp3'
    );
    assert.equal(
      annotateTrackEntry('/music/unscanned.mp3'),
      'annotate:source_tag="music",liq_fade_in="2":/music/unscanned.mp3'
    );
  });
});

// --- resolveRampSeams (the seam walker) ---------------------------------------

describe('resolveRampSeams', () => {
  const mkCase = () => {
    const segments = ['/show/jingle.wav', '/show/speech_000.wav', '/music/track.wav', '/show/speech_001.wav', '/music/short.wav'];
    const speechPaths = new Set(['/show/speech_000.wav', '/show/speech_001.wav']);
    const durations = [2, 6.2, 240, 6.2, 30];
    const slotsFor = (p) =>
      p === '/show/speech_000.wav' ? ['intro'] : p === '/show/speech_001.wav' ? ['open', 'intro'] : [];
    return { segments, speechPaths, jinglePath: '/show/jingle.wav', durations, slotsFor };
  };

  test('a fitting intro run ramps and marks BOTH sides of the seam', () => {
    const { speech, tracks } = resolveRampSeams({
      ...mkCase(),
      vocalFor: (p) => (p === '/music/track.wav' ? { onsetMs: 10000 } : null),
    });
    assert.deepEqual([...speech.entries()], [['/show/speech_000.wav', { dur: '6.2' }]]);
    assert.deepEqual([...tracks], ['/music/track.wav']);
  });

  test('a spliced open+intro run stays sequential (only speech_000 ever ramps here)', () => {
    const { speech, tracks } = resolveRampSeams({
      ...mkCase(),
      vocalFor: () => ({ onsetMs: 30000 }),
    });
    // speech_001 (open+intro, 6.2 s, window 28.5) -> no ramp: multi-clip.
    // speech_000 DOES ramp (its own window is 8.5, the clip 6.2).
    assert.deepEqual([...speech.keys()], ['/show/speech_000.wav']);
    assert.deepEqual([...tracks], ['/music/track.wav']);
  });

  test('a speech run before the jingle or at the list\u2019s end never ramps', () => {
    const segments = ['/show/speech_000.wav', '/show/jingle.wav', '/show/speech_001.wav'];
    const { speech } = resolveRampSeams({
      segments,
      speechPaths: new Set(['/show/speech_000.wav', '/show/speech_001.wav']),
      jinglePath: '/show/jingle.wav',
      durations: [6.2, 2, 6.2],
      slotsFor: () => ['intro'],
      vocalFor: () => ({ onsetMs: 30000 }),
    });
    assert.equal(speech.size, 0); // speech->jingle and the trailing run: no candidates
  });

  test('no vocal measurement on the incoming track -> no stamps at all', () => {
    const { speech, tracks } = resolveRampSeams({ ...mkCase(), vocalFor: () => null });
    assert.equal(speech.size, 0);
    assert.equal(tracks.size, 0);
  });

  test('the default vocalFor reads the real autocue index (pass-through when empty)', () => {
    // No index file in this dataDir -> no vocal anywhere -> empty result,
    // exactly the unscanned-library behavior.
    const { speech, tracks } = resolveRampSeams(mkCase());
    assert.equal(speech.size, 0);
    assert.equal(tracks.size, 0);
  });
});

// --- analyzeVocal (canned runner) ---------------------------------------------

// Canned stderr in the measured ffmpeg 7.x frame-line shape.
function frameLine(t, m) {
  const padded = m <= -100 ? `${m}` : `${m} `;
  return `[Parsed_ebur128_0 @ 0x7f5da4001c40] t: ${t}  TARGET:-23 LUFS    M:${padded}S:-120.7     I: -22.6 LUFS       LRA:   6.5 LU`;
}

function stderrFor(points) {
  return [
    points.map((p) => frameLine(p.t, p.m)).join('\n'),
    '[Parsed_ebur128_0 @ 0x7f5da4001c40] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -22.6 LUFS',
  ].join('\n');
}

describe('analyzeVocal (canned stderr)', () => {
  test('runs ONE input-side -t 32 pass through the presence band and parses the series', async () => {
    const calls = [];
    const runner = async (file, args) => {
      calls.push({ file, args });
      return { stderr: stderrFor(talkableSeries) };
    };
    assert.deepEqual(await analyzeVocal('/music/track.wav', { runner }), { onsetMs: 10000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      '-hide_banner', '-nostats', '-t', '32', '-i', '/music/track.wav',
      '-filter_complex',
      'highpass=f=250,lowpass=f=3200,ebur128=metadata=1:framelog=info',
      '-f', 'null', '-',
    ]);
    assert.deepEqual(calls[0].args, calls[0].args); // args pinned above, verbatim
  });

  test('no momentary frames -> throws (the caller counts the failure)', async () => {
    const runner = async () => ({ stderr: 'nothing here' });
    await assert.rejects(analyzeVocal('/music/track.wav', { runner }), /no momentary frames/);
  });

  test('a failed vocal pass stores the entry WITHOUT vocal, counts vocalFailed', async () => {
    const dir = path.join(config.dataDir, 'vocalfail');
    const file = writeWav(path.join(dir, 'cold.wav'), 1);
    const loud = 'Summary:\n\n  Integrated loudness:\n    I: -12.0 LUFS\n\n  True peak:\n    Peak: -1.0 dBFS\n';
    const seriesStderr = stderrFor(busySeries); // flat busy -> onset null where needed
    const runner = async (fileArg, args) => {
      if (args[2] === '-t' && args[3] === '32') throw new Error('boom');
      if (args[2] === '-t' || args.includes('-sseof')) return { stderr: seriesStderr };
      return { stderr: loud };
    };
    const summary = await analyzeMissing([file], { runner });
    assert.deepEqual(
      { analyzed: summary.analyzed, failed: summary.failed, vocalFailed: summary.vocalFailed },
      { analyzed: 1, failed: 0, vocalFailed: 1 }
    );
    const onDisk = JSON.parse(fs.readFileSync(config.paths.autocueIndexPath, 'utf8'));
    assert.equal(onDisk.tracks[file].vocal, undefined);
    assert.equal(onDisk.tracks[file].lufs, -12);
  });
});

// --- real-ffmpeg integration (skip-guarded) -----------------------------------

describe('analyzeVocal against REAL generated audio', () => {
  // The probe: 20 s of quiet white noise, then 12 s of loud noise carrying a
  // strong 250-3200 Hz band component. The band-limited momentary series
  // rises ~15+ dB at the seam and holds -> onset ~20 s.
  async function makeProbe(dir, { busyAt, quietAmp = 0.012, busyAmp = 0.3, total = 32 }) {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `probe-${busyAt}s.wav`);
    // Two concatenated lavfi segments via the concat demuxer of two inputs
    // would need files; simpler: ONE anoisesrc with a volume envelope that
    // steps at busyAt (volume expression, no re-encode beyond pcm_s16le).
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=${quietAmp}:duration=${total}:sample_rate=44100`,
      '-filter_complex',
      `volume='if(lt(t,${busyAt}),1,${(busyAmp / quietAmp).toFixed(3)})':eval=frame`,
      '-ac', '1', '-ar', '44100',
      out,
    ]);
    return out;
  }

  test('a quiet intro that fills in at 20 s -> onset within +/-0.7 s', { skip: SKIP_REASON }, async () => {
    const file = await makeProbe(path.join(config.dataDir, 'realvocal'), { busyAt: 20 });
    const { onsetMs } = await analyzeVocal(file);
    assert.ok(Number.isFinite(onsetMs), `onset measurable, got ${onsetMs}`);
    assert.ok(Math.abs(onsetMs - 20000) <= 700, `onset ~20000 ms, got ${onsetMs}`);
  });

  test('busy from the top -> onset null (no window over a vocal head)', { skip: SKIP_REASON }, async () => {
    const dir = path.join(config.dataDir, 'realvocal');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'busy.wav');
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.3:duration=32:sample_rate=44100',
      '-ac', '1', '-ar', '44100',
      file,
    ]);
    assert.deepEqual(await analyzeVocal(file), { onsetMs: null });
  });

  test('a 0.5 s transient burst does not register; the later fill-in does', { skip: SKIP_REASON }, async () => {
    const dir = path.join(config.dataDir, 'realvocal');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transient.wav');
    // Quiet 0-8 s (amp .012), burst 8-8.5 s (amp .3), quiet 8.5-15 s, busy 15-32 s.
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.012:duration=32:sample_rate=44100',
      '-filter_complex',
      "volume='if(between(t,8,8.5),25,if(gte(t,15),25,1))':eval=frame",
      '-ac', '1', '-ar', '44100',
      file,
    ]);
    const { onsetMs } = await analyzeVocal(file);
    assert.ok(Number.isFinite(onsetMs), `onset measurable, got ${onsetMs}`);
    assert.ok(Math.abs(onsetMs - 15000) <= 700, `onset ~15000 ms (past the burst), got ${onsetMs}`);
  });
});
