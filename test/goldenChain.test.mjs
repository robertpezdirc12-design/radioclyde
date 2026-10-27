// Val 29 "zlata veriga" (golden chain): ONE dynamic end-to-end pin of the
// single deterministic pipeline. The no-AI guardrail (noAiModels.test.mjs)
// pins the architecture STATICALLY (imports and file absence); every Val 28
// layer has its own unit test (autocueHead/tail, fenceposts, speechRuns,
// djTransitions). What nothing pins is the WIRING between them through the
// real entry points -- exactly where a rewrite like Val 28's breaks things
// quietly (a renamed export, a dropped await, an index read before the scan
// writes it). This file runs the actual chain a station runs every day:
//
//   music WAVs (crafted regimes) -> runAutocueScan (the scheduler's measure
//   job) -> generateFillerPlaylist (fallback air, BEFORE any show history
//   exists -- the filler excludes recently-played) -> generateScript (the
//   producer entry, REAL brief on disk) -> directShow (the director entry,
//   voice mode "none" so speech honestly skips) -> checkPrehodi (doctor #19,
//   the on-air truth about measured transitions).
//
// Four crafted tracks, one per Val 28 regime, each asserted on the FINAL
// artifacts (script.md structure, playlist.m3u annotate lines, doctor's
// coverage verdict) -- not on the units that produced them:
//   - "Gradual Build" -- 8 s cubic fade-in head at 0.3 volume -> measured
//     fade-in 2.5-4.0 s + liq_dissolve (deep ambient build-in)
//   - "Cold Slam" -- loud constant head (ffmpeg's quiet `sine` source
//     boosted with volume=6, a clipped near-square wave) -> 0.5 s soften +
//     liq_sweep (integrated loudness clears the -9.5 LUFS sweep bar)
//   - "Long Goodbye" -- 12 s cubic fade-out tail -> liq_cross_duration +
//     liq_washout (epic wind-down)
//   - "Plain Middle" -- 3 s linear fade-in head, hard end -> the 2 s default
//     fade-in, no flags (the byte-identical pre-feature behavior)
//
// Everything is offline-deterministic by construction: quiz content comes
// from the LOCAL corpus (Rubrike: kviz -- feeds.js maps kviz->quiz and never
// touches the network for it), trivia/weather/sport are NOT requested in the
// brief, lyrics prefetch is off without a config.lyrics block, and the
// fencepost coin is seeded showId|date. Requires ffmpeg+ffprobe (guarded --
// the same skip pattern as autocueHead.test.mjs; the whole chain is
// meaningless without the measurement passes).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

const execFileAsync = promisify(execFile);

const HAS_FFMPEG = (() => {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
    } catch {
      return false;
    }
  }
  return true;
})();

const REPO = repoRoot();
const dataDir = path.join(REPO, 'data', 'test-golden-chain');
// The library ROOT is <dataDir>/music; the tracks live in music/rock/ --
// the subdirectory name is the genre (localLibrary.js: a file sitting
// DIRECTLY in a configured root gets no folder genre).
const musicRoot = path.join(dataDir, 'music');
const musicDir = path.join(musicRoot, 'rock');

// The full autoRadio block (a shallow top-level merge -- the fixture default
// carries localDirs: [], which would make the library invisible).
setupTestConfig('golden-chain', {
  autoRadio: {
    enabled: true,
    stationName: 'Test Station',
    music: { source: 'local', localDirs: [musicRoot] },
    rules: { artistCooldownHours: 3 },
    voice: { mode: 'none' },
  },
});

// ---------------------------------------------------------------------------
// The fixture station: music library, jingle, roster, schedule, brief.
// Written BEFORE the first src/ import so module-load config picks it up.
// ---------------------------------------------------------------------------

fs.mkdirSync(musicDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'jingles'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'show-descriptions'), { recursive: true });

const TRACKS = [
  // file stem -> the ffmpeg -af chain. 60 s each: long enough that the head
  // pass (-t 20) and tail pass (-sseof -20) each decode their full window
  // inside a stable regime (fade or body, never both windows colliding).
  // NOTE: ffmpeg's `sine` source is quiet (measured ~-21.6 LUFS integrated)
  // -- the cold slam needs volume=6 to clear the sweep bar (lufs >= -9.5):
  // a clipped near-square wave, which ebur128 handles fine and the ear
  // would call "an assault", i.e. exactly the regime liq_sweep exists for.
  { stem: 'Marolt - Gradual Build', af: 'volume=0.3,afade=t=in:st=0:d=8:curve=cub' },
  { stem: 'Klinec - Cold Slam', af: 'volume=6' },
  { stem: 'Zupan - Long Goodbye', af: 'afade=t=in:st=0:d=3:curve=tri,afade=t=out:st=48:d=12:curve=cub' },
  { stem: 'Vodopivec - Plain Middle', af: 'afade=t=in:st=0:d=3:curve=tri' },
];

const abs = (stem) => path.join(musicDir, `${stem}.wav`);

if (HAS_FFMPEG) {
  for (const { stem, af } of TRACKS) {
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60'];
    if (af) args.push('-af', af);
    args.push('-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', abs(stem));
    await execFileAsync('ffmpeg', args);
  }
  // The show jingle: 3 s of a different tone so it is audibly not music.
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
    '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(dataDir, 'jingles', 'on_air.wav'),
  ]);
}

// The roster (Val 28: prompts.json is a pure persona directory -- the brief's
// **Personas:** names must all be keys here or parseScript rejects the script).
fs.writeFileSync(
  path.join(dataDir, 'prompts.json'),
  JSON.stringify({ personas: { elena: {}, ryan: {} } }, null, 2)
);

// station.json: one Monday show. The description path is dataDir-relative
// (the same convention the station writer records); the station jingle is
// optional and its file exists, so the director bakes its fade-out copy.
fs.writeFileSync(
  path.join(dataDir, 'station.json'),
  JSON.stringify(
    {
      station: { name: 'Zlata Veriga', jingle: 'jingles/on_air.wav' },
      schedule: {
        monday: [
          {
            id: 'gold',
            startTime: '08:00',
            durationMinutes: 6,
            description: 'show-descriptions/gold.md',
          },
        ],
      },
    },
    null,
    2
  )
);

// The brief: quiz via the LOCAL corpus (Rubrike: kviz -- kviz->quiz mapping,
// zero network), no weather/sport/obzorje/trivia so the whole chain is
// offline-deterministic. Genre comes from the parent directory name (rock).
fs.writeFileSync(
  path.join(dataDir, 'show-descriptions', 'gold.md'),
  [
    '# 📻 Zlata veriga',
    '',
    '**Personas:** elena, ryan',
    '**Segments:** quiz',
    '',
    'Rubrike: kviz',
    '',
    '## Description',
    '',
    'Deterministični koncert iz zaloge -- ena sama cev, brez modelov.',
    '',
    '## Track Selection',
    '',
    '- genre: rock',
    '- Don\'t repeat the same artist in a single show.',
    '',
  ].join('\n')
);

// ---------------------------------------------------------------------------
// The chain. Imported AFTER the fixture station exists on disk.
// ---------------------------------------------------------------------------

const SHOW = { id: 'gold', weekday: 'monday', date: '2026-10-26', timeKey: '08-00' };

const { runAutocueScan } = await import('../src/scheduler/autocueScan.js');
const { generateFillerPlaylist } = await import('../src/scheduler/generateFillerPlaylist.js');
const { generateScript } = await import('../src/producer/generateScript.js');
const { directShow } = await import('../src/director/index.js');
const { checkPrehodi } = await import('../src/auto/doctor.js');
const { decideFenceposts } = await import('../src/producer/fenceposts.js');
const { config } = await import('../src/config/index.js');
const { parseScript } = await import('../src/script/format.js');

const state = {};

const annotateFields = (line) => {
  // "annotate:k="v",...:/abs/path" -> { k: v } + the bare path.
  const m = /^annotate:([^:]*):(.*)$/.exec(line);
  if (!m) return null;
  const fields = {};
  for (const pair of m[1].split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { fields, filePath: m[2] };
};

describe('zlata veriga (golden chain)', { skip: HAS_FFMPEG ? false : 'ffmpeg/ffprobe not available on this box' }, () => {

  test('A. the autocue scan measures all four regimes into the index', async () => {
    const summary = await runAutocueScan();
    assert.equal(summary.total, 4, `total files seen: ${JSON.stringify(summary)}`);
    assert.equal(summary.analyzed, 4, 'every fixture is new to the index');
    assert.equal(summary.failed, 0, 'no measurement failures');
    assert.equal(summary.headFailed, 0, 'no head-pass failures');
    assert.equal(summary.tailFailed, 0, 'no tail-pass failures');

    const indexPath = path.join(dataDir, 'autocue_index.json');
    assert.ok(fs.existsSync(indexPath), 'the side index is on disk');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const { stem } of TRACKS) {
      assert.ok(index.tracks[abs(stem)], `${stem} is indexed by absolute path`);
    }

    const gradual = index.tracks[abs('Marolt - Gradual Build')];
    assert.ok(gradual.head?.gradual === true, 'gradual build head is classified gradual');
    assert.ok(gradual.head.riseMs >= 3000, `riseMs ${gradual.head.riseMs} >= 3000`);
    assert.ok(gradual.head.lufsRise >= 10, `lufsRise ${gradual.head.lufsRise} >= 10 (dissolve bar)`);
    assert.ok(gradual.tail?.fade !== true, 'its tail is a hard end -- dissolve stays a pure head gesture');

    const cold = index.tracks[abs('Klinec - Cold Slam')];
    assert.ok(cold.head.riseMs <= 500, `riseMs ${cold.head.riseMs} <= 500 (cold attack)`);
    assert.ok(cold.lufs >= -9.5, `lufs ${cold.lufs} >= -9.5 (sweep loudness bar)`);

    const goodbye = index.tracks[abs('Zupan - Long Goodbye')];
    assert.ok(goodbye.tail?.fade === true, 'long fade-out tail is classified as a fade');
    assert.ok(goodbye.tail.windMs >= 6000, `windMs ${goodbye.tail.windMs} >= 6000 (washout bar)`);
    assert.ok(goodbye.tail.lufsDrop >= 10, `lufsDrop ${goodbye.tail.lufsDrop} >= 10`);

    const plain = index.tracks[abs('Vodopivec - Plain Middle')];
    assert.ok(plain.head.riseMs > 500 && plain.head.riseMs < 3500, `riseMs ${plain.head.riseMs} in the middle band`);
    assert.ok(plain.head.gradual !== true, 'a 3 s linear lead-in is not a deep build');
    assert.ok(plain.tail?.fade !== true, 'hard end, no crossfade stamp');
  });

  test('B. the filler playlist (before any show history) carries the measured stamps', async () => {
    // Runs BEFORE generateScript on purpose: the filler excludes
    // recently-played tracks, and this fixture has no history YET -- after
    // the show records its plays, all four tracks would be excluded and the
    // filler would come out empty (honest, but useless for this pin).
    await generateFillerPlaylist();

    const fillerPath = path.join(dataDir, 'filler.m3u');
    assert.ok(fs.existsSync(fillerPath), 'filler.m3u is on disk');
    const lines = fs.readFileSync(fillerPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    assert.equal(lines.length, 4, 'the whole (tiny) library is the pool');
    const byStem = new Map(
      lines.map((line) => {
        const parsed = annotateFields(line);
        assert.ok(parsed, `every filler line is annotated: ${line}`);
        return [path.basename(parsed.filePath, '.wav'), parsed.fields];
      })
    );
    assert.ok(byStem.get('Marolt - Gradual Build').liq_dissolve === '1', 'filler: dissolve stamped');
    assert.ok(byStem.get('Klinec - Cold Slam').liq_sweep === '1', 'filler: sweep stamped');
    const goodbye = byStem.get('Zupan - Long Goodbye');
    assert.ok(goodbye.liq_washout === '1', 'filler: washout stamped');
    assert.ok(goodbye.liq_cross_duration, 'filler: cross duration stamped');
    state.fillerPath = fillerPath;
  });

  test('C. generateScript: real brief -> script + sidecars + the fencepost contract', async () => {
    const { markdown, runDir, tracks } = await generateScript({ ...SHOW });

    // Val 28's "sidecar always" promise: the director's sidecar-first load
    // never needs the Plex fallback for scripts produced after the switch.
    for (const f of ['script.md', 'transcript.json', 'tracks.json', 'context.json']) {
      assert.ok(fs.existsSync(path.join(runDir, f)), `${f} written`);
    }
    assert.equal(tracks.length, 4, 'the whole rock pool is the show');
    for (const t of tracks) {
      assert.equal(t.ratingKey, sha1Path(t.localPath ?? t.plexPath), 'ratingKey = sha1(path).slice(0,12)');
    }

    // (runDir and the sidecar names are already asserted above.)

    // The director's parse opts exactly: personas from the roster, track
    // durations from the sidecar map (without it every track falls back to
    // the ~3.5 min placeholder and a 4-track show "runs 15 min").
    const knownRatingKeys = new Map(tracks.map((t) => [t.ratingKey, t]));
    const parsed = parseScript(markdown, { requiredDurationMinutes: 6, knownRatingKeys });
    assert.ok(parsed.ok, `script validates clean: ${parsed.issues?.join(' | ')}`);
    // A "runs short" warning is honest for 60 s fixture tracks and does not
    // block directing (the director logs it as a NOTE -- D proves it); a
    // "well over" issue WOULD block, and ok===true already covers that.
    assert.ok(!parsed.warnings?.some((w) => /well over/.test(w)), `no overruns: ${parsed.warnings?.join(' | ')}`);
    const segs = parsed.segments;
    const trackIdx = segs.map((s, i) => (s.type === 'track' ? i : -1)).filter((i) => i >= 0);
    assert.equal(trackIdx.length, 4, 'four track segments');

    const slotsBetween = (i) => {
      const end = trackIdx[i + 1];
      const slice = end == null ? segs.slice(trackIdx[i] + 1) : segs.slice(trackIdx[i] + 1, end);
      return slice.filter((s) => s.type === 'dj' || s.type === 'live').map((s) => s.slot ?? s.kind);
    };

    // The fencepost contract, predicted with the same seed discipline the
    // builder uses (seedFor({showId, date, slot:'fenceposts'}) =
    // `${showId}|${date}|none|fenceposts`) -- the B-block pattern from
    // fenceposts.test.mjs, applied to a script produced by the REAL entry.
    const map = decideFenceposts({
      seed: `${SHOW.id}|${SHOW.date}|none|fenceposts`,
      trackCount: 4,
      hasQuiz: true,
      hasWeather: false,
    });
    const quizIndex = 2; // Math.floor(4/2), the protected reveal boundary

    assert.ok(map.silentBoundaries.size >= 1, 'the fixture draw has at least one silent boundary');
    assert.ok(map.silentBoundaries.size <= Math.ceil(4 / 3), 'density cap ~1/3 holds');

    for (const b of map.silentBoundaries) {
      if (b === 3) {
        // The final boundary drops only the last recap; the show tail
        // (nextShow + close) always speaks.
        const tail = slotsBetween(3);
        assert.ok(!tail.includes('recap'), `final boundary ${b}: last recap dropped`);
        assert.ok(tail.includes('nextShow') && tail.includes('close'), 'the tail still speaks');
      } else {
        assert.deepEqual(slotsBetween(b), [], `boundary ${b} is pure back-to-back`);
      }
    }
    // Non-silent, non-quiz boundaries DO talk (intro or recap side).
    for (let b = 0; b <= 2; b += 1) {
      if (map.silentBoundaries.has(b) || b === quizIndex - 1 || b === quizIndex) continue;
      const spoken = [...slotsBetween(b), ...slotsBetween(b + 1)];
      assert.ok(spoken.length > 0, `non-silent boundary ${b} keeps its speech`);
    }
    // The protected quiz pair: both halves present around track #2.
    assert.ok(slotsBetween(quizIndex - 1).includes('quizIntro'), 'quiz question before the quiz track');
    assert.ok(slotsBetween(quizIndex).includes('quizReveal'), 'quiz answer after the quiz track');
    // Local corpus quiz content, not the legacy year-guess (the WAVs carry no
    // year tags -- the legacy template would render "leta undefined").
    const quizIntro = segs.find((s) => s.slot === 'quizIntro');
    assert.ok(!/\bundefined\b/.test(quizIntro.body), 'quiz content is real, not an undefined year');
  });

  test('D. directShow: playlist.m3u with the measured Val 28 stamps', async () => {
    await directShow({ ...SHOW });

    const occurrenceDir = path.join(dataDir, 'running', SHOW.weekday, SHOW.id, SHOW.date, SHOW.timeKey);
    const m3uPath = path.join(occurrenceDir, 'playlist.m3u');
    assert.ok(fs.existsSync(m3uPath), 'playlist.m3u written (the directed signal)');
    const lines = fs.readFileSync(m3uPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const entries = lines.map(annotateFields);
    assert.ok(entries.every(Boolean), 'every playlist line is annotated');

    const byStem = new Map(entries.map((e) => [path.basename(e.filePath, '.wav'), e]));
    assert.equal(entries.length, 5, 'jingle + four tracks (voice "none" honestly skips speech)');
    assert.ok(!entries.some((e) => e.fields.source_tag === 'speech'), 'no speech entries with voice mode none');

    // --- the crown jewels: the measured regimes on the FINAL artifact ---
    const build = byStem.get('Marolt - Gradual Build').fields;
    const buildFade = Number(build.liq_fade_in);
    assert.ok(buildFade >= 2.5 && buildFade <= 4.0, `gradual build fade-in ${buildFade} in [2.5, 4.0]`);
    assert.equal(build.liq_dissolve, '1', 'dissolve stamped on the deep build');
    assert.equal(build.liq_sweep, undefined, 'no sweep on a gradual head');
    assert.equal(build.liq_washout, undefined, 'no washout on a hard tail');
    assert.ok(build.liq_amplify, 'R128 correction stamped');

    const slam = byStem.get('Klinec - Cold Slam').fields;
    assert.equal(slam.liq_fade_in, '0.5', 'cold attack gets the half-second soften');
    assert.equal(slam.liq_sweep, '1', 'sweep stamped on the loud cold start');
    assert.equal(slam.liq_dissolve, undefined);
    assert.equal(slam.liq_washout, undefined);
    assert.equal(slam.liq_cross_duration, undefined, 'hard end, no crossfade');

    const goodbye = byStem.get('Zupan - Long Goodbye').fields;
    assert.equal(goodbye.liq_washout, '1', 'washout stamped on the epic wind-down');
    const cross = Number(goodbye.liq_cross_duration);
    assert.ok(cross >= 8 && cross <= 12, `cross duration ${cross} in [8, 12]`);
    assert.equal(goodbye.liq_fade_in, '2', 'middle-band head keeps the 2 s default');

    const plain = byStem.get('Vodopivec - Plain Middle').fields;
    assert.equal(plain.liq_fade_in, '2', 'the unmeasured-middle default, byte-identical');
    assert.ok(plain.liq_amplify, 'loudness still measured and corrected');
    assert.equal(plain.liq_dissolve, undefined);
    assert.equal(plain.liq_sweep, undefined);
    assert.equal(plain.liq_washout, undefined);
    assert.equal(plain.liq_cross_duration, undefined);

    // The jingle entry: baked fade-out copy in the occurrence dir, jingle
    // annotation shape (no fade override, no dj field).
    const jingle = entries.find((e) => e.fields.source_tag === 'jingle');
    assert.ok(jingle, 'the jingle leads the playlist');
    assert.ok(jingle.filePath.startsWith(occurrenceDir), 'the played copy is the rendered one');
    assert.equal(jingle.fields.liq_fade_in, undefined, 'jingles carry no fade-in override');

    // The director's own records: live text resolved, rating keys merged.
    assert.ok(fs.existsSync(path.join(occurrenceDir, 'live-segments.json')), 'live-segments.json written');
    assert.ok(fs.existsSync(path.join(dataDir, 'track_ratingkeys.json')), 'rating-key map merged');
  });

  test('E. doctor prehodi: the on-air file reads back as measured', async () => {
    // The last link: the same check the CLI doctor runs (#19), pointed at
    // the filler this chain generated. An OK here means the m3u that
    // Liquidsoap actually airs carries measured transitions -- the whole
    // point of Val 28. The counts live in the detail string ("3/4 vnosi
    // ... washout 1 · dissolve 1 · sweep 1") -- the finding model has no
    // numeric fields, so the regex IS the interface.
    const result = await checkPrehodi({ fillerPath: state.fillerPath, readFileImpl: fs.promises.readFile });
    assert.equal(result.status, 'ok', `prehodi verdict: ${result.status} -- ${result.detail}`);
    const m = /(\d+)\/(\d+)/.exec(result.detail);
    assert.ok(m, `detail carries the measured/total counts: ${result.detail}`);
    assert.equal(Number(m[2]), 4, 'four filler entries total');
    assert.ok(Number(m[1]) >= 3, `at least three measured (detail: ${result.detail})`);
    assert.match(result.detail, /washout 1 · dissolve 1 · sweep 1/, 'one of each crafted effect');
  });
});

// The local-library ratingKey convention (sha1 of the absolute path, first
// 12 hex chars) -- replicated here so the assertion is independent of the
// library module itself.
function sha1Path(p) {
  return createHash('sha1').update(p).digest('hex').slice(0, 12);
}
