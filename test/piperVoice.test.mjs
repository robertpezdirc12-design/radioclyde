// Tests for the piper1-gpl voice layer (P3 #15): auto/piperVoice.js -- the
// single source of truth shared by auto/voice.js (on-air piper provider),
// pre-generate-clips.mjs and server/voiceStatus.js.
//
// Layers, mirroring how the feature is built:
//   A. pure resolution math: voice KEY (piper1-gpl style, resolves to
//      <dataDir>/<key>.onnx) vs .onnx PATH (old rhasspy-piper style,
//      resolves against cwd), persona overrides, exact argv for
//      `python3 -m piper` -- the flags are identical for both runtime
//      generations (verified from piper1-gpl v1.8.0 source, 2026-10-24),
//   B. the ensure/download contract: piper1-gpl NEVER auto-downloads, so
//      ensurePiperVoice owns the one-time piper.download_voices fetch
//      (skippable via piperAutoDownload=false with an actionable error),
//   C. end-to-end through synthesizeNoModelSpeech with a STUBBED python
//      runner writing real WAV bytes -- the real ffmpeg normalize runs and
//      the temp-file cleanup must hold on success AND failure (the
//      audit 2026-10-24 regression),
//   D. LIVE piper1-gpl synthesis behind PIPER_LIVE=1 (downloads the real
//      ~63 MB Slovenian voice on first run; skipped honestly otherwise).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { setupTestConfig, repoRoot, writeWav } from './fixtures.mjs';

const TEST_DIR = path.join(repoRoot(), 'data', 'test-piperVoice');
const PIPER_DIR = path.join(TEST_DIR, 'piper');

setupTestConfig('piperVoice', {
  autoRadio: {
    enabled: true,
    stationName: 'Test Station',
    music: { source: 'local', localDirs: [] },
    rules: { artistCooldownHours: 3 },
    voice: {
      mode: 'piper',
      defaultPiperVoice: 'sl_SI-artur-medium',
      piperDataDir: PIPER_DIR,
      personas: {
        elena: { piperVoice: 'voices/elena-custom.onnx', piperSpeaker: 1 },
        ana: { piperVoice: '/abs/path/ana.onnx' },
      },
    },
  },
});

const { config } = await import('../src/config/index.js');
const { resolvePiperVoice, buildPiperArgs, ensurePiperVoice, synthesizePiper, isPiperVoiceKey, PIPER_DEFAULT_MODEL } = await import('../src/auto/piperVoice.js');
const { synthesizeNoModelSpeech } = await import('../src/auto/voice.js');
const { piperStatus } = await import('../src/server/voiceStatus.js');

function resetVoiceCfg() {
  config.autoRadio.voice.defaultPiperVoice = 'sl_SI-artur-medium';
  config.autoRadio.voice.piperDataDir = PIPER_DIR;
  delete config.autoRadio.voice.piperAutoDownload;
  delete config.autoRadio.voice.piperTimeoutMs;
  delete config.autoRadio.voice.piperDownloadTimeoutMs;
}

// Minimal WAV-header reader for assertions on normalized output.
function readWavHeader(file) {
  const b = fs.readFileSync(file);
  return {
    riff: b.subarray(0, 4).toString('ascii'),
    wave: b.subarray(8, 12).toString('ascii'),
    channels: b.readUInt16LE(22),
    sampleRate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
    bytes: b.length,
  };
}

const neverRun = async () => { throw new Error('runner must not be called'); };

describe('piper voice resolution', () => {
  test('voice KEY default resolves to <dataDir>/<key>.onnx', () => {
    const r = resolvePiperVoice(null);
    assert.equal(r.model, 'sl_SI-artur-medium');
    assert.equal(r.isKey, true);
    assert.equal(r.dataDir, PIPER_DIR);
    assert.equal(r.modelPath, path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'));
  });

  test('relative .onnx PATH persona resolves against repo cwd (old style)', () => {
    const r = resolvePiperVoice('elena');
    assert.equal(r.model, 'voices/elena-custom.onnx');
    assert.equal(r.isKey, false);
    assert.equal(r.modelPath, path.join(repoRoot(), 'voices', 'elena-custom.onnx'));
  });

  test('absolute .onnx PATH persona stays as-is', () => {
    const r = resolvePiperVoice('ana');
    assert.equal(r.model, '/abs/path/ana.onnx');
    assert.equal(r.isKey, false);
    assert.equal(r.modelPath, '/abs/path/ana.onnx');
  });

  test('unknown persona falls through to the station default', () => {
    const r = resolvePiperVoice('marko');
    assert.equal(r.model, 'sl_SI-artur-medium');
    assert.equal(r.isKey, true);
  });

  test('isPiperVoiceKey: only .onnx names are paths, case-insensitive', () => {
    assert.equal(isPiperVoiceKey('sl_SI-artur-medium'), true);
    assert.equal(isPiperVoiceKey('voices/sl_SI-artur-medium.onnx'), false);
    assert.equal(isPiperVoiceKey('/opt/voice.ONNX'), false);
    assert.equal(isPiperVoiceKey(null), true);
  });

  test('built-in default keeps the old path form (zero-config boxes unchanged)', () => {
    assert.equal(PIPER_DEFAULT_MODEL, 'voices/sl_SI-artur-medium.onnx');
  });
});

describe('piper argv', () => {
  test('key mode passes --data-dir and the raw key as -m', () => {
    const args = buildPiperArgs({ model: 'sl_SI-artur-medium', isKey: true, dataDir: '/d', textFile: '/t.txt', outPath: '/o.wav', speaker: null });
    assert.deepEqual(args, ['-m', 'piper', '-m', 'sl_SI-artur-medium', '--data-dir', '/d', '-f', '/o.wav', '--input-file', '/t.txt']);
  });

  test('path mode has no --data-dir; speaker is appended as string', () => {
    const args = buildPiperArgs({ model: '/m.onnx', isKey: false, dataDir: '/d', textFile: '/t.txt', outPath: '/o.wav', speaker: 1 });
    assert.deepEqual(args, ['-m', 'piper', '-m', '/m.onnx', '-f', '/o.wav', '--input-file', '/t.txt', '--speaker', '1']);
  });
});

describe('ensurePiperVoice (piper1-gpl downloads are explicit)', () => {
  test('existing key file: no download call', async () => {
    resetVoiceCfg();
    fs.mkdirSync(PIPER_DIR, { recursive: true });
    fs.writeFileSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), 'dummy');
    await ensurePiperVoice(resolvePiperVoice(null), { runner: neverRun });
  });

  test('missing key + piperAutoDownload=false: actionable error, no download', async () => {
    resetVoiceCfg();
    config.autoRadio.voice.piperAutoDownload = false;
    fs.rmSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), { force: true });
    await assert.rejects(
      () => ensurePiperVoice(resolvePiperVoice(null), { runner: neverRun }),
      (err) => {
        assert.match(err.message, /piper\.download_voices/);
        assert.match(err.message, /sl_SI-artur-medium/);
        assert.match(err.message, new RegExp(PIPER_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      }
    );
    delete config.autoRadio.voice.piperAutoDownload;
  });

  test('missing key + auto-download: one download_voices call, then resolves', async () => {
    resetVoiceCfg();
    fs.rmSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), { force: true });
    const calls = [];
    const runner = async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      fs.writeFileSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), 'downloaded');
    };
    await ensurePiperVoice(resolvePiperVoice(null), { runner });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ['-m', 'piper.download_voices', 'sl_SI-artur-medium', '--data-dir', PIPER_DIR]);
    assert.equal(calls[0][2].timeout, 600_000);
  });

  test('download reports success but file still missing: honest error', async () => {
    resetVoiceCfg();
    fs.rmSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), { force: true });
    const runner = async () => { /* downloads nothing */ };
    await assert.rejects(() => ensurePiperVoice(resolvePiperVoice(null), { runner }), /still missing/);
  });

  test('missing .onnx PATH: early honest error instead of piper traceback', async () => {
    resetVoiceCfg();
    await assert.rejects(
      () => ensurePiperVoice(resolvePiperVoice('elena'), { runner: neverRun }),
      /model file not found: .*elena-custom\.onnx/
    );
  });

  test('existing .onnx PATH: resolves without any call', async () => {
    resetVoiceCfg();
    const p = path.join(repoRoot(), 'voices', 'elena-custom.onnx');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'dummy');
    try {
      await ensurePiperVoice(resolvePiperVoice('elena'), { runner: neverRun });
    } finally {
      fs.rmSync(p, { force: true });
    }
  });
});

describe('synthesizePiper (stubbed python, real contract)', () => {
  test('happy path: exact argv, text file holds the text, temp cleaned', async () => {
    resetVoiceCfg();
    fs.mkdirSync(PIPER_DIR, { recursive: true });
    fs.writeFileSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), 'dummy');
    const outPath = path.join(TEST_DIR, 'open.wav');
    let seenArgs = null;
    const runner = async (cmd, args) => {
      seenArgs = args;
      const text = fs.readFileSync(args[args.indexOf('--input-file') + 1], 'utf8');
      assert.equal(text, 'Dober dan iz Radia Clyde.');
      writeWav(outPath, 1);
    };
    await synthesizePiper('Dober dan iz Radia Clyde.', outPath, null, { runner });
    assert.deepEqual(seenArgs, [
      '-m', 'piper', '-m', 'sl_SI-artur-medium', '--data-dir', PIPER_DIR,
      '-f', outPath, '--input-file', `${outPath}.piper-text.txt`,
    ]);
    assert.equal(fs.existsSync(`${outPath}.piper-text.txt`), false);
  });

  test('persona piperSpeaker reaches argv as string', async () => {
    resetVoiceCfg();
    const outPath = path.join(TEST_DIR, 'elena.wav');
    const elenaOnnx = path.join(repoRoot(), 'voices', 'elena-custom.onnx');
    fs.mkdirSync(path.dirname(elenaOnnx), { recursive: true });
    fs.writeFileSync(elenaOnnx, 'dummy');
    let seenArgs = null;
    const runner = async (cmd, args) => { seenArgs = args; writeWav(outPath, 1); };
    try {
      await synthesizePiper('Živijo.', outPath, 'elena', { runner });
    } finally {
      fs.rmSync(elenaOnnx, { force: true });
    }
    assert.ok(seenArgs.includes('--speaker'));
    assert.equal(seenArgs[seenArgs.indexOf('--speaker') + 1], '1');
    assert.ok(!seenArgs.includes('--data-dir'));
  });

  test('runner failure: error propagates, .piper-text.txt still cleaned (audit regression)', async () => {
    resetVoiceCfg();
    const outPath = path.join(TEST_DIR, 'fail.wav');
    await assert.rejects(
      () => synthesizePiper('Test.', outPath, null, { runner: async () => { throw new Error('boom'); } }),
      /boom/
    );
    assert.equal(fs.existsSync(`${outPath}.piper-text.txt`), false);
  });

  test('zero-byte output: honest "no audio" error, temp cleaned', async () => {
    resetVoiceCfg();
    const outPath = path.join(TEST_DIR, 'empty.wav');
    await assert.rejects(
      () => synthesizePiper('Test.', outPath, null, { runner: async (cmd, args) => { fs.writeFileSync(args[args.indexOf('-f') + 1], ''); } }),
      /no audio/
    );
    assert.equal(fs.existsSync(`${outPath}.piper-text.txt`), false);
  });
});

describe('synthesizeNoModelSpeech end-to-end (stubbed piper, REAL ffmpeg)', () => {
  test('piper mode produces a normalized 24kHz/mono/16-bit wav, temps cleaned', async () => {
    resetVoiceCfg();
    const outPath = path.join(TEST_DIR, 'seg.wav');
    // Stub "python" writes a real 8kHz wav where piper output would land;
    // the real ffmpeg step must resample to the 24kHz codec contract.
    const runner = async (cmd, args) => writeWav(args[args.indexOf('-f') + 1], 1);
    const ok = await synthesizeNoModelSpeech({ persona: null, slot: 'open', text: 'Test.', outPath, runner });
    assert.equal(ok, true);
    const h = readWavHeader(outPath);
    assert.equal(h.riff, 'RIFF');
    assert.equal(h.wave, 'WAVE');
    assert.equal(h.sampleRate, 24000);
    assert.equal(h.channels, 1);
    assert.equal(h.bits, 16);
    assert.equal(fs.existsSync(`${outPath}.piper-src.wav`), false);
    assert.equal(fs.existsSync(`${outPath}.piper-text.txt`), false);
    assert.equal(fs.existsSync(`${outPath}.norm.wav`), false);
  });

  test('runner failure skips the segment honestly (returns false via provider error)', async () => {
    resetVoiceCfg();
    const outPath = path.join(TEST_DIR, 'seg2.wav');
    await assert.rejects(
      () => synthesizeNoModelSpeech({ persona: null, slot: 'open', text: 'Test.', outPath, runner: async () => { throw new Error('piper exploded'); } }),
      /piper exploded/
    );
    assert.equal(fs.existsSync(`${outPath}.piper-text.txt`), false);
  });
});

describe('voiceStatus reflects the shared resolution', () => {
  test('piperStatus(): key mode default + persona path modes', async () => {
    resetVoiceCfg();
    fs.rmSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), { force: true });
    const s = piperStatus();
    assert.equal(s.defaultVoice, 'sl_SI-artur-medium');
    assert.equal(s.isKey, true);
    assert.equal(s.dataDir, PIPER_DIR);
    assert.equal(s.modelPath, path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'));
    assert.equal(s.modelExists, false);
    assert.equal(s.pythonPath, 'python3');
    assert.equal(s.personas.elena.piperVoice, 'voices/elena-custom.onnx');
    assert.equal(s.personas.elena.isKey, false);
    assert.equal(s.personas.elena.modelExists, false);
    assert.equal(s.personas.ana.piperVoice, '/abs/path/ana.onnx');
    // After the one-time download the same status flips to exists.
    fs.writeFileSync(path.join(PIPER_DIR, 'sl_SI-artur-medium.onnx'), 'dummy');
    assert.equal(piperStatus().modelExists, true);
  });
});

describe('LIVE piper1-gpl synthesis (PIPER_LIVE=1; downloads ~63 MB on first run)', () => {
  const execFileAsync = promisify(execFile);

  test('real python + real sl_SI-artur-medium voice produce real Slovenian audio', async (t) => {
    if (process.env.PIPER_LIVE !== '1') {
      t.skip('set PIPER_LIVE=1 to run the real piper1-gpl synthesis (needs python + network on first run)');
      return;
    }
    try {
      await execFileAsync('python3', ['-m', 'piper', '--help']);
    } catch {
      t.skip('piper-tts is not installed for python3 (pip install piper-tts)');
      return;
    }
    resetVoiceCfg();
    // OWN data dir: the stub tests leave a tiny dummy .onnx in the shared
    // PIPER_DIR cache -- piper would happily load those 5 bytes and die. A
    // separate dir keeps the real ~63 MB voice cached across live runs
    // without ever touching the stub world.
    config.autoRadio.voice.piperDataDir = path.join(TEST_DIR, 'piper-live');
    const outPath = path.join(TEST_DIR, 'live.wav');
    await synthesizePiper('Dober dan iz Radia Clyde.', outPath, null);
    const h = readWavHeader(outPath);
    assert.equal(h.riff, 'RIFF');
    assert.equal(h.channels, 1);
    assert.ok(h.bytes > 10_000, `live synthesis suspiciously small: ${h.bytes} bytes`);
  });
});
