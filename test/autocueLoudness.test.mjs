// Loudness-analysis regression tests: lib/autocue.js's ffmpeg ebur128 pass,
// the derive-at-read amplify math, and the mtime/size side index. This is the
// measurement half of the contract with radio.liq's
// amplify(override="liq_amplify") -- the wiring half lives in
// autocueAnnotate.test.mjs.
//
// These tests DO run ffmpeg (the feature is an ffmpeg pipeline); when the
// binary is absent the suite skips rather than failing, same honesty as the
// live box logging a zero-work scan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav } from './fixtures.mjs';

const HAS_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const SKIP_REASON = HAS_FFMPEG ? false : 'ffmpeg not available on this box';

setupTestConfig('autocue-loudness', {
  autocue: { targetLufs: -16, maxGainDb: 6 },
});

const { config } = await import('../src/config/index.js');
const { analyzeTrack, amplifyDbFor, analyzeMissing, amplifyAnnotate, loudnessSettings } = await import(
  '../src/lib/autocue.js'
);

// Scales a 16-bit PCM WAV's sample data by `factor` into a NEW file -- a
// deterministic loudness knob for the -20 dB delta test that needs no
// second ffmpeg synthesis step: 20*log10(0.1) = -20 dB exactly, so the two
// analyses must differ by 20 LUFS within the rounding of int16 quantization.
function scaleWav(src, dst, factor) {
  const raw = fs.readFileSync(src);
  const data = raw.subarray(44); // canonical writeWav: 44-byte header, 16-bit LE
  const out = Buffer.alloc(data.length);
  for (let i = 0; i + 1 < data.length; i += 2) {
    const sample = data.readInt16LE(i);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * factor))), i);
  }
  fs.writeFileSync(dst, Buffer.concat([raw.subarray(0, 44), out]));
  return dst;
}

describe('analyzeTrack', { skip: SKIP_REASON }, () => {
  test('measures integrated LUFS and true peak of a known WAV', async () => {
    const file = writeWav(path.join(config.dataDir, 'lib', 'known.wav'), 3);
    const { lufs, peak } = await analyzeTrack(file);
    assert.ok(Number.isFinite(lufs), `lufs finite, got ${lufs}`);
    assert.ok(Number.isFinite(peak), `peak finite, got ${peak}`);
    // The writeWav fixture is a constant-amplitude 440 Hz sine at -12.3 dBFS
    // peak; the integrated value must land in the plausible window for that
    // signal (well above silence, well below full scale) -- a parser that
    // grabbed a progress line or a wrong field would fall outside.
    assert.ok(lufs > -30 && lufs < -5, `lufs plausible for the fixture, got ${lufs}`);
    assert.ok(peak > -30 && peak < 0, `peak plausible for the fixture, got ${peak}`);
  });

  test('a -20 dB scaled copy measures 20 LUFS quieter (parser reads the right field)', async () => {
    const loud = writeWav(path.join(config.dataDir, 'lib', 'loud.wav'), 3);
    const quiet = scaleWav(loud, path.join(config.dataDir, 'lib', 'quiet.wav'), 0.1);
    const a = await analyzeTrack(loud);
    const b = await analyzeTrack(quiet);
    const delta = a.lufs - b.lufs;
    assert.ok(Math.abs(delta - 20) < 1.5, `expected ~20 LUFS delta, got ${delta}`);
    assert.ok(b.peak < a.peak, 'true peak must drop with the signal');
  });

  test('a missing/unreadable file throws (callers count failures, never parse garbage)', async () => {
    await assert.rejects(() => analyzeTrack(path.join(config.dataDir, 'lib', 'nope.wav')));
    const text = path.join(config.dataDir, 'lib', 'text.wav');
    fs.writeFileSync(text, 'this is not audio');
    await assert.rejects(() => analyzeTrack(text));
  });
});

describe('amplifyDbFor (pure derive-at-read math)', () => {
  test('amplify = target - lufs, rounded to one decimal', () => {
    assert.deepEqual(amplifyDbFor(-15.7, { targetLufs: -16, maxGainDb: 6 }), { amplify: -0.3, clamped: false });
    assert.deepEqual(amplifyDbFor(-20.04, { targetLufs: -16, maxGainDb: 6 }), { amplify: 4, clamped: false });
    assert.deepEqual(amplifyDbFor(-17.96, { targetLufs: -16, maxGainDb: 6 }), { amplify: 2, clamped: false });
  });

  test('only the positive side clamps (quieting a loud master is always safe)', () => {
    // Very quiet master: boost capped at maxGainDb -- no limiter in the
    // chain, so pushing a hot master past 0 dBFS would clip in the encoder.
    assert.deepEqual(amplifyDbFor(-40, { targetLufs: -16, maxGainDb: 6 }), { amplify: 6, clamped: true });
    assert.deepEqual(amplifyDbFor(-23, { targetLufs: -16, maxGainDb: 6 }), { amplify: 6, clamped: true });
    // Loud master: negative corrections are never clamped.
    assert.deepEqual(amplifyDbFor(-10, { targetLufs: -16, maxGainDb: 6 }), { amplify: -6, clamped: false });
    assert.deepEqual(amplifyDbFor(-5, { targetLufs: -16, maxGainDb: 6 }), { amplify: -11, clamped: false });
  });

  test('loudnessSettings reads the config block with the documented defaults', () => {
    // setupTestConfig wrote the autocue override above.
    assert.deepEqual(loudnessSettings(), { targetLufs: -16, maxGainDb: 6 });
  });
});

describe('analyzeMissing + index', { skip: SKIP_REASON }, () => {
  // Cache staleness hazard: readIndexFresh invalidates on the file's
  // mtimeMs, and two writes inside the same millisecond can carry the SAME
  // mtimeMs. Every index write in this suite stamps an explicitly
  // increasing mtime via utimes, making cache invalidation deterministic.
  let stamp = 1_700_000_000_000;
  function touchFreshly(file) {
    stamp += 1000;
    fs.utimesSync(file, new Date(stamp), new Date(stamp));
  }

  test('analyzes new files, skips unchanged, re-analyzes changed', async () => {
    const dir = path.join(config.dataDir, 'lib2');
    const a = writeWav(path.join(dir, 'a.wav'), 2);
    const b = writeWav(path.join(dir, 'b.wav'), 2);
    const missing = path.join(dir, 'gone.wav');

    let summary = await analyzeMissing([a, b, missing]);
    assert.deepEqual(
      { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed },
      { analyzed: 2, skipped: 0, failed: 1 },
      'first pass: both new files analyzed, absent path counted failed'
    );
    assert.equal(summary.total, 3);

    // Same files again: pure skip, zero ffmpeg work.
    summary = await analyzeMissing([a, b]);
    assert.deepEqual({ analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed }, { analyzed: 0, skipped: 2, failed: 0 });

    // Touching mtime WITHOUT changing content forces re-analysis (the scan
    // contract: mtimeMs+size is the change detector, not content hashing).
    touchFreshly(a);
    summary = await analyzeMissing([a, b]);
    assert.deepEqual({ analyzed: summary.analyzed, skipped: summary.skipped }, { analyzed: 1, skipped: 1 });

    // A byte-size change with a fresh mtime re-analyzes too.
    touchFreshly(b);
    fs.appendFileSync(b, Buffer.alloc(2)); // corrupts the wav, but analysis of it is what a changed size means here
    summary = await analyzeMissing([b]);
    assert.equal(summary.analyzed, 1);
  });

  test('the per-run budget caps ffmpeg work (first sweep spreads across ticks)', async () => {
    const dir = path.join(config.dataDir, 'lib3');
    const files = [0, 1, 2].map((n) => writeWav(path.join(dir, `t${n}.wav`), 1));
    const summary = await analyzeMissing(files, { maxAnalyzePerRun: 2 });
    assert.equal(summary.analyzed, 2);
    assert.equal(summary.total, 3);
    // The third file is NOT counted skipped (it was never analyzed) -- it
    // simply remains outstanding for the next tick.
    assert.equal(summary.skipped, 0);
  });

  test('index rewrites are visible to amplifyAnnotate in the same process (cache invalidation)', async () => {
    const dir = path.join(config.dataDir, 'lib4');
    const file = writeWav(path.join(dir, 'x.wav'), 1);
    assert.equal(amplifyAnnotate(file), null, 'no analysis -> no annotate field');

    await analyzeMissing([file]);
    const entryLine = amplifyAnnotate(file);
    assert.ok(entryLine && entryLine.match(/^-?\d+\.\d dB$/), `measured entry yields a one-decimal dB string, got ${entryLine}`);

    // And after an atomic rewrite the cache serves the NEW data, not the
    // old: -25 LUFS derives to +9 dB raw, clamped to +6.0 -- clearly
    // distinguishable from the measured entry's ~-0.3 dB above.
    fs.writeFileSync(config.paths.autocueIndexPath, JSON.stringify({ version: 1, tracks: { [file]: { mtimeMs: 1, size: 1, lufs: -25, peak: null, analyzedAt: 'test' } } }));
    touchFreshly(config.paths.autocueIndexPath);
    assert.equal(amplifyAnnotate(file), '6.0 dB', 'rewritten index must be served, not the cached copy');
  });

  test('a corrupt index degrades to empty (pass-through), never a crash', async () => {
    fs.writeFileSync(config.paths.autocueIndexPath, '{not json');
    touchFreshly(config.paths.autocueIndexPath);
    const file = path.join(config.dataDir, 'lib4', 'x.wav');
    assert.equal(amplifyAnnotate(file), null);
  });
});
