// Tests for P5 #2 podcast audio synthesis (src/auto/podcastAudio.js):
//   A. buildFfmpegArgs: pinned argv with chapters, plain fallback without,
//   B. buildChaptersMetadata: ffmetadata header + chapter blocks in ms,
//   C. happy path: air-order pieces, real offset math, plan-ready output,
//   D. skip-not-fail: one piper line failing -> honest skip, episode still
//      assembles; ALL failing -> honest error (empty MP3 is a lie),
//   E. music without a file (Plex) -> talk-only episode with skipped list,
//   F. ffmpeg fallback: chapters break the encode -> retry plain succeeds,
//   G. probeDurationSeconds: number passes, garbage throws.
// Piper + ffmpeg are ALWAYS injected (voiceRunner / processRunner) -- the
// live path is the operator CLI, covered by the smoke script.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

// Path-form voice (old style) -> ensurePiperVoice only checks fs.existsSync.
// The voice path MUST go in via overrides: src/config/index.js re-parses
// config.json at import time, so post-setup mutations to the returned object
// never reach the modules.
const fakeVoicePath = path.join(repoRoot(), 'data', 'test-podcast-audio', 'piper', 'sl_SI-artur-medium.onnx');

const config = setupTestConfig('podcast-audio', {
  autoRadio: {
    enabled: true,
    stationName: 'Radio Markec',
    music: { source: 'local', localDirs: [] },
    voice: { mode: 'none', defaultPiperVoice: fakeVoicePath }, // podcast calls piper DIRECTLY, not via station mode
  },
});

fs.mkdirSync(path.dirname(fakeVoicePath), { recursive: true });
fs.writeFileSync(fakeVoicePath, 'fake-onnx-bytes');

const { buildPodcastEpisode } = await import('../src/auto/podcast.js');
const {
  synthesizePodcastEpisodeAudio,
  buildFfmpegArgs,
  buildChaptersMetadata,
  probeDurationSeconds,
} = await import('../src/auto/podcastAudio.js');

const POOL = [
  { ratingKey: 'a2', artist: 'Queen', title: 'Another One Bites the Dust', album: 'The Game', year: 1980, durationMs: 215_000 },
  { ratingKey: 'b1', artist: 'Pankrti', title: 'Lepi in bežec', album: 'Pankrti', year: 1978, durationMs: 185_000 },
  { ratingKey: 'c1', artist: 'AC/DC', title: 'Highway to Hell', album: 'Highway to Hell', year: 1979, durationMs: 207_000 },
];

function tmpOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-audio-'));
}

// -- stubs --------------------------------------------------------------

// Fakes piper: writes plausible WAV bytes where -f points; can fail for
// specific segment paths (match) to exercise skip-not-fail.
function stubVoiceRunner({ failMatch = null } = {}) {
  return async (_cmd, args) => {
    const fIndex = args.indexOf('-f');
    const outPath = fIndex !== -1 ? args[fIndex + 1] : null;
    if (!outPath) throw new Error('stub: no -f in piper args');
    if (failMatch && outPath.includes(failMatch)) throw new Error('stub: piper blew up');
    fs.writeFileSync(outPath, Buffer.from('RIFFfake-wav'));
    return { stdout: '', stderr: '' };
  };
}

// Fakes ffprobe (returns duration from a per-basename map) and ffmpeg
// (writes the output file given as the last argv entry).
function stubProcessRunner({ durations = {}, failFfmpegWithChapters = false } = {}) {
  let ffmpegCalls = 0;
  const runner = async (cmd, args) => {
    if (cmd === 'ffprobe') {
      const file = args[args.length - 1];
      const base = path.basename(file);
      if (!(base in durations)) throw new Error(`stub: no duration for ${base}`);
      return { stdout: `${durations[base]}\n`, stderr: '' };
    }
    if (cmd === 'ffmpeg') {
      ffmpegCalls++;
      const hasMetadata = args.includes('-map_metadata');
      if (failFfmpegWithChapters && ffmpegCalls === 1 && hasMetadata) {
        throw new Error('stub: exotic ffmpeg chokes on ffmetadata');
      }
      fs.writeFileSync(args[args.length - 1], Buffer.from('ID3fake-mp3'));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`stub: unexpected command ${cmd}`);
  };
  runner.ffmpegCalls = () => ffmpegCalls;
  return runner;
}

function musicMap(files) {
  return (track) => files[track.ratingKey] ?? null;
}

function makeEpisode() {
  return buildPodcastEpisode({ date: '2026-10-25', tracks: POOL });
}

// -----------------------------------------------------------------------

describe('buildFfmpegArgs', () => {
  test('pinned argv: inputs, concat filter, metadata input, mp3 encode', () => {
    const argv = buildFfmpegArgs({
      inputs: ['a.wav', 'b.mp3', 'c.wav'],
      chaptersFile: '/out/poglavja.txt',
      outPath: '/out/epizoda.mp3',
    });
    assert.equal(argv[0], '-y');
    // every input is its own -i, in air order
    for (const [i, input] of ['a.wav', 'b.mp3', 'c.wav'].entries()) {
      assert.equal(argv[1 + i * 2], '-i');
      assert.equal(argv[2 + i * 2], input);
    }
    assert.match(argv[argv.indexOf('-filter_complex') + 1], /^\[0:a\]\[1:a\]\[2:a\]concat=n=3:v=0:a=1\[out\]$/);
    assert.ok(argv.includes('[out]'));
    // chapters ride an -i AFTER all audio inputs (BEFORE output options --
    // the ffmpeg parse rule the live run taught us); -map_metadata points at it
    assert.equal(argv[7], '-i');
    assert.equal(argv[8], '/out/poglavja.txt');
    const metaIndex = argv.indexOf('-map_metadata');
    assert.equal(argv[metaIndex + 1], '3');
    assert.ok(metaIndex > argv.indexOf('-map'), 'metadata input is declared before output options');
    // encode contract + output last
    for (const flag of ['-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2']) assert.ok(argv.includes(flag), flag);
    assert.equal(argv[argv.length - 1], '/out/epizoda.mp3');
  });

  test('chaptersFile null -> plain fallback, no metadata input', () => {
    const argv = buildFfmpegArgs({ inputs: ['a.wav'], chaptersFile: null, outPath: '/o/x.mp3' });
    assert.ok(!argv.includes('-map_metadata'));
    assert.ok(!argv.includes('/out/poglavja.txt'));
    assert.ok(!argv.some((a, i) => a === '-i' && i > 0 && argv[i + 1]?.endsWith('.txt')));
    assert.match(argv[argv.indexOf('-filter_complex') + 1], /concat=n=1/);
    assert.equal(argv[argv.length - 1], '/o/x.mp3');
  });
});

describe('buildChaptersMetadata', () => {
  test('ffmetadata header + one chapter per piece with ms offsets', () => {
    const md = buildChaptersMetadata({
      station: 'Radio Markec',
      date: '2026-10-25',
      pieces: [
        { title: 'Otvoritev', startMs: 0, endMs: 6100 },
        { title: 'Naznanilo skladbe', startMs: 6100, endMs: 12000 },
      ],
    });
    assert.match(md, /^;FFMETADATA1/);
    assert.match(md, /title=Markec Podkast -- 2026-10-25/);
    assert.match(md, /artist=Radio Markec/);
    assert.match(md, /\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=0\nEND=6100\ntitle=1\. Otvoritev/);
    assert.match(md, /START=6100\nEND=12000\ntitle=2\. Naznanilo skladbe/);
  });
});

describe('probeDurationSeconds', () => {
  test('parses ffprobe output', async () => {
    const runner = async () => ({ stdout: '3.25\n', stderr: '' });
    assert.equal(await probeDurationSeconds('/x/y.wav', runner), 3.25);
  });

  test('garbage or empty duration throws honestly', async () => {
    await assert.rejects(
      () => probeDurationSeconds('/x/y.wav', async () => ({ stdout: 'N/A\n', stderr: '' })),
      /veljavnega trajanja/
    );
  });
});

describe('synthesizePodcastEpisodeAudio', () => {
  test('happy path: air-order pieces (announcement + music), cumulative offsets, chapters written', async () => {
    const out = tmpOut();
    const files = { c1: '/music/acdc.mp3', b1: '/music/pankrti.mp3' }; // picked pair is c1+b1 (seed 2026-10-25)
    const processRunner = stubProcessRunner({
      durations: {
        '00-podcastOpen.wav': 5.0, // open
        '01-intro.wav': 2.0, // announcement 1
        'acdc.mp3': 10.0, // track 1
        '02-podcastChat.wav': 12.0, // chat
        '03-intro.wav': 2.0, // announcement 2
        'pankrti.mp3': 8.0, // track 2
        '04-podcastOutro.wav': 7.5, // outro
      },
    });
    const result = await synthesizePodcastEpisodeAudio(makeEpisode(), {
      outDir: out,
      voiceRunner: stubVoiceRunner(),
      processRunner,
      musicResolver: musicMap(files),
    });

    // air order: pogovor, naznanilo, glasba, pogovor, naznanilo, glasba, pogovor
    assert.deepEqual(result.pieces.map((p) => p.kind), ['pogovor', 'pogovor', 'glasba', 'pogovor', 'pogovor', 'glasba', 'pogovor']);
    assert.equal(result.pieces.filter((p) => p.slot === 'intro').length, 4, 'two announcements + two tracks carry the intro slot');
    assert.equal(result.pieces.length, 7);
    assert.equal(result.skipped.length, 0);

    // offsets are REAL sums of the probed durations
    assert.equal(result.pieces[0].startMs, 0);
    assert.equal(result.pieces[1].startMs, 5000);
    assert.equal(result.pieces[2].startMs, 7000);
    assert.equal(result.pieces[3].startMs, 17000);
    assert.equal(result.pieces[4].startMs, 29000);
    assert.equal(result.pieces[5].startMs, 31000);
    assert.equal(result.pieces[6].startMs, 39000);
    assert.equal(result.seconds, 5 + 2 + 10 + 12 + 2 + 8 + 7.5);

    // artifacts exist and the chapters carry every piece
    assert.ok(fs.existsSync(result.mp3Path));
    const chapters = fs.readFileSync(result.chaptersPath, 'utf8');
    for (const p of result.pieces) assert.match(chapters, new RegExp(`START=${p.startMs}\nEND=${p.endMs}`));
    assert.equal(result.ffmpegArgs[0], '-y');
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('default music resolver uses real localPath files', async () => {
    const out = tmpOut();
    const musicDir = path.join(config.dataDir, 'music-for-audio');
    fs.mkdirSync(musicDir, { recursive: true });
    const file = path.join(musicDir, 'acdc.mp3');
    fs.writeFileSync(file, 'fake-audio');
    const episode = buildPodcastEpisode({ date: '2026-10-25', tracks: POOL.map((t) => ({ ...t, localPath: t.ratingKey === 'c1' ? file : undefined })) });
    const processRunner = stubProcessRunner({ durations: { 'acdc.mp3': 3, '00-podcastOpen.wav': 1, '01-intro.wav': 1, '02-podcastChat.wav': 1, '03-intro.wav': 1, '04-podcastOutro.wav': 1 } });
    const result = await synthesizePodcastEpisodeAudio(episode, {
      outDir: out,
      voiceRunner: stubVoiceRunner(),
      processRunner,
    });
    assert.equal(result.pieces.filter((p) => p.kind === 'glasba').length, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /brez dostopne datoteke/);
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('skip-not-fail: one piper line dies -> honest skip, episode still assembles', async () => {
    const out = tmpOut();
    const processRunner = stubProcessRunner({
      durations: { '00-podcastOpen.wav': 5, '01-intro.wav': 2, 'acdc.mp3': 10, '03-intro.wav': 2, 'pankrti.mp3': 8, '04-podcastOutro.wav': 6 },
    });
    const result = await synthesizePodcastEpisodeAudio(makeEpisode(), {
      outDir: out,
      voiceRunner: stubVoiceRunner({ failMatch: '02-podcastChat' }),
      processRunner,
      musicResolver: musicMap({ c1: '/music/acdc.mp3', b1: '/music/pankrti.mp3' }),
    });
    assert.equal(result.pieces.length, 6);
    assert.deepEqual(result.pieces.map((p) => p.kind), ['pogovor', 'pogovor', 'glasba', 'pogovor', 'glasba', 'pogovor']);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].slot, 'podcastChat');
    assert.match(result.skipped[0].reason, /piper blew up/);
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('ALL failing -> honest error, no empty MP3 lie', async () => {
    const out = tmpOut();
    await assert.rejects(
      () =>
        synthesizePodcastEpisodeAudio(makeEpisode(), {
          outDir: out,
          voiceRunner: stubVoiceRunner({ failMatch: '.wav' }),
          processRunner: stubProcessRunner({}),
          musicResolver: () => null,
        }),
      /Noben segment ni bil sintetiziran/
    );
    assert.ok(!fs.existsSync(path.join(out, '2026-10-25-markec-podkast.mp3')));
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('ffmpeg fallback: chapters break the encode -> retry plain, still delivered', async () => {
    const out = tmpOut();
    const processRunner = stubProcessRunner({
      durations: { '00-podcastOpen.wav': 5, '01-intro.wav': 2, 'acdc.mp3': 10, '02-podcastChat.wav': 3, '03-intro.wav': 2, 'pankrti.mp3': 8, '04-podcastOutro.wav': 2 },
      failFfmpegWithChapters: true,
    });
    const result = await synthesizePodcastEpisodeAudio(makeEpisode(), {
      outDir: out,
      voiceRunner: stubVoiceRunner(),
      processRunner,
      musicResolver: musicMap({ c1: '/music/acdc.mp3', b1: '/music/pankrti.mp3' }),
    });
    assert.equal(processRunner.ffmpegCalls(), 2, 'one failed attempt + one plain retry');
    assert.ok(!result.ffmpegArgs.includes('-map_metadata'), 'delivered argv is the plain one');
    assert.ok(fs.existsSync(result.mp3Path));
    assert.ok(fs.existsSync(result.chaptersPath), 'sidecar stays on disk for the operator');
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('episode without lines -> honest error', async () => {
    await assert.rejects(() => synthesizePodcastEpisodeAudio({ lines: [] }, { outDir: tmpOut() }), /brez vrstic/);
  });
});
