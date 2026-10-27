// Val 28 B4+B5 tests: src/director/speechRuns.js -- the director's speech-run
// finalizer. Covers:
//   A. speechRunInputs (the B5 beat: a pause after every non-final
//      live:nextShow clip, and ONLY there -- continuous patter stays spliced),
//   B. speechAlignDbFor (the B4 math: music target + djDrops.gain taste
//      offset, positive side clamped, one-decimal quantization),
//   C. finalizeSpeechRun through SEAMS (pause generation + concat ordering +
//      measurement + bake, and every honest degradation: unmeasured airs as
//      produced, on-target airs untouched, bake failure airs unaligned,
//      single cached clips are never mutated),
//   D. REAL ffmpeg forensics (skip-guarded, the autocueLoudness pattern):
//      the pause file is 0.7 s of real silence, the concat carries the beat
//      in the bytes, and the bake measurably moves the file's loudness.
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
const SKIP_FFMPEG = HAS_FFMPEG ? false : 'ffmpeg not available on this box';

setupTestConfig('speech-runs', {
  autocue: { targetLufs: -16, maxGainDb: 6 },
});

const { config } = await import('../src/config/index.js');
const {
  SPEECH_PAUSE_AFTER_SLOT,
  SPEECH_PAUSE_SECONDS,
  speechRunInputs,
  speechAlignDbFor,
  finalizeSpeechRun,
} = await import('../src/director/speechRuns.js');

// --- A. the beat ---------------------------------------------------------------

describe('A. speechRunInputs (the B5 beat)', () => {
  test('a pause lands after every non-final nextShow clip, nowhere else', () => {
    const { inputs, pauses } = speechRunInputs(
      ['/a/open.wav', '/b/intro.wav', '/c/next.wav', '/d/close.wav'],
      ['open', 'intro', SPEECH_PAUSE_AFTER_SLOT, 'close'],
      '/pause.wav'
    );
    assert.deepEqual(inputs, ['/a/open.wav', '/b/intro.wav', '/c/next.wav', '/pause.wav', '/d/close.wav']);
    assert.equal(pauses, 1);
  });

  test('continuous patter (open into intro, handoff into weather) stays spliced', () => {
    const { inputs, pauses } = speechRunInputs(
      ['/a/open.wav', '/b/intro.wav'],
      ['open', 'intro'],
      '/pause.wav'
    );
    assert.deepEqual(inputs, ['/a/open.wav', '/b/intro.wav']);
    assert.equal(pauses, 0);
  });

  test('a FINAL nextShow clip gets no trailing pause (nothing follows in the run)', () => {
    const { inputs, pauses } = speechRunInputs(['/a/next.wav'], [SPEECH_PAUSE_AFTER_SLOT], '/pause.wav');
    assert.deepEqual(inputs, ['/a/next.wav']);
    assert.equal(pauses, 0);
  });

  test('a null pausePath degrades to the plain splice (the beat is presentation, never a dependency)', () => {
    const { inputs, pauses } = speechRunInputs(
      ['/a/next.wav', '/b/close.wav'],
      [SPEECH_PAUSE_AFTER_SLOT, 'close'],
      null
    );
    assert.deepEqual(inputs, ['/a/next.wav', '/b/close.wav']);
    assert.equal(pauses, 0);
  });

  test('two nextShow clips in one run each earn their beat', () => {
    const { inputs, pauses } = speechRunInputs(
      ['/a/next.wav', '/b/x.wav', '/c/next.wav', '/d/close.wav'],
      [SPEECH_PAUSE_AFTER_SLOT, 'recap', SPEECH_PAUSE_AFTER_SLOT, 'close'],
      '/pause.wav'
    );
    assert.equal(pauses, 2);
    assert.equal(inputs.filter((p) => p === '/pause.wav').length, 2);
  });

  test('the pinned constants', () => {
    assert.equal(SPEECH_PAUSE_AFTER_SLOT, 'live:nextShow');
    assert.equal(SPEECH_PAUSE_SECONDS, 0.7);
  });
});

// --- B. the alignment math -------------------------------------------------------

describe('B. speechAlignDbFor (the B4 math)', () => {
  test('quiet speech gets the full positive correction onto the music target', () => {
    // -22 LUFS measured, -16 target, gain 1 -> +6.0 dB (exactly at the clamp)
    assert.equal(speechAlignDbFor(-22), 6.0);
  });

  test('the positive side clamps at maxGainDb (no limiter in the speech path)', () => {
    assert.equal(speechAlignDbFor(-30), 6.0);
  });

  test('loud speech quiets down to the target (negative side never clamps)', () => {
    assert.equal(speechAlignDbFor(-10), -6.0);
    assert.equal(speechAlignDbFor(-4), -12.0);
  });

  test('on-target speech takes zero (bytes air untouched)', () => {
    assert.equal(speechAlignDbFor(-16), 0.0);
  });

  test('djDrops.gain stays a taste OFFSET relative to the target, not a raw scalar', () => {
    // gain 1.3 = +2.28 dB above target: speech measured exactly at
    // (target + gainDb) lands on zero -- the offset shifts the goal line,
    // it does not fight the measurement.
    const hotTarget = -16 + 20 * Math.log10(1.3);
    assert.equal(speechAlignDbFor(hotTarget, { targetLufs: -16, maxGainDb: 6 }, 1.3), 0.0);
    // gain 0.5 = -6.02 dB -> even on-target speech airs quieter, per the knob.
    assert.equal(speechAlignDbFor(-16, { targetLufs: -16, maxGainDb: 6 }, 0.5), -6.0);
    // the offset rides the clamp too: a hot gain cannot push past maxGainDb.
    assert.equal(speechAlignDbFor(-30, { targetLufs: -16, maxGainDb: 6 }, 2), 6.0);
  });

  test('a broken gain config (zero, negative, NaN) is ignored, not fatal', () => {
    for (const broken of [0, -1, Number.NaN, 'abc', null]) {
      assert.equal(speechAlignDbFor(-22, { targetLufs: -16, maxGainDb: 6 }, broken), 6.0);
    }
  });

  test('one-decimal quantization (annotate-grade rounding)', () => {
    assert.equal(speechAlignDbFor(-16.55), 0.6); // 0.55 -> 0.6
    assert.equal(speechAlignDbFor(-16.54), 0.5); // 0.54 -> 0.5
  });
});

// --- C. finalizeSpeechRun through seams ------------------------------------------

function makeRunnerCalls() {
  const calls = [];
  const concatLists = [];
  // The fake writes REAL output bytes where the real ffmpeg would, so the
  // concat/rename/existsSync assertions see the world production sees. The
  // concat demuxer's list file is deleted by concatWavFiles' own finally, so
  // its content is captured AT CALL TIME.
  const run = async (file, args) => {
    calls.push({ file, args });
    if (args.includes('concat')) {
      concatLists.push(fs.readFileSync(args[args.indexOf('-i') + 1], 'utf8'));
    }
    fs.writeFileSync(args[args.length - 1], Buffer.from(`fake:${args[0]}`));
    return {};
  };
  return { calls, run, concatLists };
}

describe('C. finalizeSpeechRun (seams)', () => {
  const dir = () => path.join(config.dataDir, 'run');
  let nameSeq = 0;
  const makeName = () => path.join(dir(), `speech_${String(nameSeq++).padStart(3, '0')}.wav`);
  // The pause file is CACHED per occurrence dir -- between suite runs the
  // data dir persists, so tests that assert on generation must clear it.
  const clearPause = () => fs.rmSync(path.join(dir(), 'speech-pause.wav'), { force: true });
  const bakeCalls = (calls) => calls.filter((c) => c.args.some((a) => String(a).startsWith('volume=')));

  test('multi-clip run: pause generated, concat called with the beat inserted, bake in place', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    clearPause();
    const a = writeWav(path.join(dir(), 'next.wav'), 1);
    const b = writeWav(path.join(dir(), 'close.wav'), 1);
    const { calls, run, concatLists } = makeRunnerCalls();
    const measure = async () => ({ lufs: -20 });
    const out = await finalizeSpeechRun({
      files: [a, b],
      slots: [SPEECH_PAUSE_AFTER_SLOT, 'close'],
      occurrenceDir: dir(),
      makeName,
      measure,
      run,
    });
    assert.equal(out.aligned, true);
    assert.equal(out.pauses, 1);
    assert.equal(out.lufs, -20);
    assert.equal(out.amplify, 4.0);
    // 1) pause generation (anullsrc), 2) concat WITH the pause path, 3) bake.
    assert.ok(calls[0].args.join(' ').includes('anullsrc=duration=0.7'), 'pause generated at 0.7 s');
    const concatArgs = calls[1].args.join(' ');
    assert.ok(concatArgs.includes('-f') && concatArgs.includes('concat'), 'concat demuxer pass');
    const listContent = concatLists[0];
    assert.match(listContent, new RegExp(`${a.replace(/\//g, '\\/')}`));
    assert.match(listContent, /speech-pause\.wav/);
    assert.match(listContent, new RegExp(`${b.replace(/\//g, '\\/')}`));
    // The bake pass targets the tmp then the caller renames (speechRuns does).
    assert.ok(calls[2].args.includes('volume=4dB'), `bake carries +4.0 dB, got ${calls[2].args.join(' ')}`);
  });

  test('single cached clip needing a bake: occurrence-specific COPY, cache file untouched', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const cached = writeWav(path.join(dir(), 'cached-open.wav'), 1);
    const before = fs.readFileSync(cached);
    const { calls, run } = makeRunnerCalls();
    const measure = async () => ({ lufs: -24 });
    const out = await finalizeSpeechRun({
      files: [cached],
      slots: ['open'],
      occurrenceDir: dir(),
      makeName,
      measure,
      run,
    });
    assert.equal(out.aligned, true);
    assert.notEqual(out.path, cached, 'the aired path is the occurrence copy');
    assert.ok(/speech_\d{3}\.wav$/.test(out.path), `copy uses the occurrence naming, got ${out.path}`);
    assert.ok(fs.existsSync(out.path), 'the copy landed (renamed from tmp)');
    assert.deepEqual(fs.readFileSync(cached), before, 'the cached dj clip is byte-identical');
    assert.equal(bakeCalls(calls).length, 1);
  });

  test('on-target run: bytes air untouched, zero ffmpeg passes beyond the concat', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const a = writeWav(path.join(dir(), 'open.wav'), 1);
    const b = writeWav(path.join(dir(), 'intro.wav'), 1);
    const { calls, run } = makeRunnerCalls();
    const measure = async () => ({ lufs: -16 });
    const out = await finalizeSpeechRun({
      files: [a, b],
      slots: ['open', 'intro'],
      occurrenceDir: dir(),
      makeName,
      measure,
      run,
    });
    assert.equal(out.aligned, false);
    assert.equal(out.amplify, 0);
    assert.equal(bakeCalls(calls).length, 0, 'no bake pass');
    assert.ok(calls.some((c) => c.args.includes('concat')), 'the splice still happens');
  });

  test('unmeasured run (ebur128 failure): airs as produced, never skipped', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const a = writeWav(path.join(dir(), 'x.wav'), 1);
    const b = writeWav(path.join(dir(), 'y.wav'), 1);
    const { calls, run } = makeRunnerCalls();
    const measure = async () => {
      throw new Error('no ffmpeg on the box');
    };
    const out = await finalizeSpeechRun({
      files: [a, b],
      slots: ['open', 'recap'],
      occurrenceDir: dir(),
      makeName,
      measure,
      run,
    });
    assert.equal(out.aligned, false);
    assert.equal(out.lufs, null);
    assert.ok(fs.existsSync(out.path), 'the concat still aired');
    assert.equal(bakeCalls(calls).length, 0);
  });

  test('bake failure: the run airs unaligned (skip-not-fail)', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const a = writeWav(path.join(dir(), 'z.wav'), 1);
    const failingRun = async (file, args) => {
      if (args.includes('volume=')) throw new Error('ffmpeg died');
      return {};
    };
    const measure = async () => ({ lufs: -20 });
    const out = await finalizeSpeechRun({
      files: [a],
      slots: ['close'],
      occurrenceDir: dir(),
      makeName,
      measure,
      run: failingRun,
    });
    assert.equal(out.aligned, false);
    assert.equal(out.path, a, 'the original airs');
    assert.equal(out.lufs, -20);
    assert.equal(out.amplify, 4.0);
  });

  test('pause generation failure: the run degrades to the plain splice', async () => {
    fs.mkdirSync(dir(), { recursive: true });
    clearPause();
    const a = writeWav(path.join(dir(), 'n.wav'), 1);
    const b = writeWav(path.join(dir(), 'c.wav'), 1);
    const partialRun = async (file, args) => {
      if (args.join(' ').includes('anullsrc')) throw new Error('cannot synth silence');
      fs.writeFileSync(args[args.length - 1], Buffer.from('fake'));
      return {};
    };
    const measure = async () => ({ lufs: -16 });
    const out = await finalizeSpeechRun({
      files: [a, b],
      slots: [SPEECH_PAUSE_AFTER_SLOT, 'close'],
      occurrenceDir: dir(),
      makeName,
      measure,
      run: partialRun,
    });
    assert.equal(out.pauses, 0, 'no beat inserted');
    assert.ok(fs.existsSync(out.path));
  });
});

// --- D. REAL ffmpeg forensics ------------------------------------------------------

describe('D. speechRuns against REAL ffmpeg', { skip: SKIP_FFMPEG }, () => {
  async function durationOf(file) {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ]);
    return Number.parseFloat(stdout);
  }

  // A dj/live clip in the REAL speech codec contract (24 kHz mono s16 -- the
  // normalize step every provider output goes through). The writeWav fixture
  // is 8 kHz and would break the concat demuxer's same-codec requirement
  // against the 24 kHz pause -- production clips are all 24 kHz, so the
  // forensics must be too.
  async function makeSpeechClip(dir, name, seconds, extraFilters = []) {
    const file = path.join(dir, name);
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`,
      ...(extraFilters.length ? ['-af', extraFilters.join(',')] : []),
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le',
      file,
    ]);
    return file;
  }

  test('the pause file is 0.7 s of real silence in the speech codec', async () => {
    const dir = path.join(config.dataDir, 'real');
    fs.mkdirSync(dir, { recursive: true });
    const pause = path.join(dir, 'speech-pause.wav');
    fs.rmSync(pause, { force: true });
    const a = await makeSpeechClip(dir, 'n.wav', 1);
    const b = await makeSpeechClip(dir, 'c.wav', 1);
    const out = await finalizeSpeechRun({
      files: [a, b],
      slots: [SPEECH_PAUSE_AFTER_SLOT, 'close'],
      occurrenceDir: dir,
      makeName: () => path.join(dir, 'run.wav'),
      measure: async () => ({ lufs: -16 }),
    });
    assert.equal(out.pauses, 1);
    const d = await durationOf(pause);
    assert.ok(Math.abs(d - 0.7) < 0.05, `pause duration ~0.7 s, got ${d}`);
    // The pause is silent: volumedetect on it must find no signal.
    const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-i', pause, '-af', 'volumedetect', '-f', 'null', '-']);
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    assert.ok(mean && Number.parseFloat(mean[1]) <= -70, `true silence, mean ${mean?.[1]}`);
  });

  test('the beat is in the aired bytes: run with the pause is ~0.7 s longer than without', async () => {
    const dir = path.join(config.dataDir, 'real-beat');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const a = await makeSpeechClip(dir, 'n.wav', 1);
    const b = await makeSpeechClip(dir, 'c.wav', 1);
    const measure = async () => ({ lufs: -16 });
    const withBeat = await finalizeSpeechRun({
      files: [a, b], slots: [SPEECH_PAUSE_AFTER_SLOT, 'close'],
      occurrenceDir: dir, makeName: () => path.join(dir, 'with.wav'), measure,
    });
    const noBeat = await finalizeSpeechRun({
      files: [a, b], slots: ['recap', 'close'],
      occurrenceDir: dir, makeName: () => path.join(dir, 'without.wav'), measure,
    });
    const dWith = await durationOf(withBeat.path);
    const dWithout = await durationOf(noBeat.path);
    assert.ok(
      Math.abs(dWith - dWithout - SPEECH_PAUSE_SECONDS) < 0.06,
      `beat adds ~0.7 s (with ${dWith}, without ${dWithout})`
    );
  });

  test('the bake measurably moves the file (a hot run quiets toward the target)', async () => {
    const dir = path.join(config.dataDir, 'real-bake');
    fs.mkdirSync(dir, { recursive: true });
    // volume=4 puts the clip ~6+ dB ABOVE the -16 target, so the real
    // analyzeTrack + real bake must land a NEGATIVE correction (speech that
    // is too hot gets quiets, the direction DJ speech never had before).
    const src = await makeSpeechClip(dir, 'loud.wav', 2, ['volume=4']);
    const out = await finalizeSpeechRun({
      files: [src],
      slots: ['close'],
      occurrenceDir: dir,
      makeName: () => path.join(dir, 'aligned.wav'),
    });
    assert.equal(out.aligned, true);
    assert.ok(out.amplify < 0, `expected a negative correction, got ${out.amplify}`);
    // Forensics: the aired copy really is quieter than the source.
    const levelOf = async (file) => {
      const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
      return Number.parseFloat(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)[1]);
    };
    const before = await levelOf(src);
    const after = await levelOf(out.path);
    assert.ok(
      before - after >= Math.abs(out.amplify) - 1.5,
      `the bake moved the level by ~${out.amplify} dB (before ${before}, after ${after})`
    );
  });
});
