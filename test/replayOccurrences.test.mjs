// Tests for Paket C2 (Val 22, docs/programming-research.md §5) -- replay /
// ponovitve: a day-list entry { type: "replay", sourceDate, sourceTimeKey? }
// occupies a real slot and airs the EXISTING episode. The matrix:
//   A. materializeReplayOccurrence (src/scheduler/replayMaterializer.js):
//      happy-path copy + replayOf stamp, default vs explicit sourceTimeKey,
//      template-vs-override source lineup, honest no-ops for every
//      missing/corrupt-source shape, idempotency (inode pin).
//   B. scheduleScripts.js skip: STRUCTURAL (the skip precedes the script.md
//      check) + BEHAVIORAL (a replay inside the script horizon produces no
//      script.md/error.json/ledger at all).
//   C. scheduleDirect.js routing: STRUCTURAL for both entry points
//      (checkAndTriggerDirect: playlist marker -> replay -> script.md;
//       rebuildIncompleteOccurrences: replay -> materialize, not direct)
//      + BEHAVIORAL (checkAndTriggerDirect materializes a live replay).
//   D. schedulePrewarmAudio.js skip: STRUCTURAL.
//   E. scrobbleTrack.js replay stamp: BEHAVIORAL through the exported
//      recordNowPlaying (the extract route -- see the note in group E).
//   F. stationWriter replay validation (public API): accepted/rejected
//      shapes + updateOccurrence id-change stripping.
//   G. played.jsonl untouched: the first-air-stat guarantee.
//   H. the operator-rescue CLI, as a real child process.
//
// setupTestConfig runs BEFORE every dynamic import (config.json is read once
// at module load) -- the honestOffline.test.mjs discipline. No network, no
// ffmpeg, no real audio: a "directed source episode" is a playlist.m3u with
// two fake absolute media paths + a context.json -- the isDirected contract
// (updateNowPlaying.js) and nothing more.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('replay-occurrences', {});

const { config } = await import('../src/config/index.js');
const { materializeReplayOccurrence } = await import('../src/scheduler/replayMaterializer.js');
const {
  occurrenceDir,
  weekdayKey,
  dateFromKey,
  dateKey,
  addCalendarDays,
  timeKey,
  loadSchedule,
} = await import('../src/scheduler/scheduleUtil.js');
const { replaceDaySchedule, updateOccurrence } = await import('../src/scheduler/stationWriter.js');
// Importing scrobbleTrack.js runs its module-level main() -- which no-ops
// honestly without a file-path argv (radio.liq always passes one on the real
// station), so the import is safe from a test process. What we want from it
// is the exported recordNowPlaying.
const { recordNowPlaying } = await import('../src/plex/scrobbleTrack.js');
const { checkAndTriggerScripts } = await import('../src/scheduler/scheduleScripts.js');
const { checkAndTriggerDirect } = await import('../src/scheduler/scheduleDirect.js');

// ---------------------------------------------------------------------------
// Scratch fixtures
// ---------------------------------------------------------------------------
const STATION_PATH = config.paths.stationFile;
const RUNNING_DIR = config.paths.runningDir;

// 2026-10-19 is a Monday (2026-10-26, the research doc's own date, is the
// Monday exactly one week later). Every weekday below is DERIVED from its
// date through the production helpers, so these fixtures can never drift
// from the running/<weekday>/ layout the station actually writes.
const SRC_DATE = '2026-10-19'; // a real PAST Monday (stationWriter: not future)
const SRC_WEEKDAY = weekdayKey(dateFromKey(SRC_DATE));
const REPLAY_DATE = '2026-10-21'; // the Wednesday of the same week
const REPLAY_WEEKDAY = weekdayKey(dateFromKey(REPLAY_DATE));
const SHOW_ID = 'vecerni';
const OTHER_SHOW_ID = 'jutranji';

// Two fake absolute media paths -- a playlist is just lines to the
// materializer (it copies bytes; it never resolves them).
const MEDIA_A = path.join(config.dataDir, 'library', 'fake-a.mp3');
const MEDIA_B = path.join(config.dataDir, 'library', 'fake-b.mp3');
const PLAYLIST_PRIMARY = `${MEDIA_A}\n${MEDIA_B}\n`;
// Reversed order: PROOF of which source occurrence was copied when the
// source date carries two episodes of the same show.
const PLAYLIST_SECONDARY = `${MEDIA_B}\n${MEDIA_A}\n`;
const SOURCE_CONTEXT = { durationSeconds: 123, persona: 'elena', trackCount: 2, mode: 'auto' };

// parseShowBrief's exact header contract (the nextShowAnnounce.test.mjs
// brief fixture shape): stationWriter's id validation only needs the file to
// EXIST, but real-shaped briefs keep the scratch station honest.
function writeBriefs() {
  const dir = config.paths.showDescriptionsDir;
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, title, personas] of [
    ['vecerni.md', 'Večerni maraton', 'ryan'],
    ['jutranji.md', 'Jutranji z Eleno', 'elena'],
  ]) {
    fs.writeFileSync(
      path.join(dir, file),
      [`# ${title}`, '', ...(personas ? [`**Personas:** ${personas}`, ''] : []), '## Description', '', `${title} -- testni brief.`, ''].join('\n')
    );
  }
}
writeBriefs();

function writeStation(schedule) {
  fs.writeFileSync(
    STATION_PATH,
    JSON.stringify({ station: { name: 'Test Station', neverPlay: { keywords: [], artists: [] } }, schedule }, null, 2)
  );
}

// The default scratch station: the source date's effective lineup carries
// TWO episodes of the same show (08:00 + 20:00) -- both the default
// sourceTimeKey resolution and the explicit-pick case key off this.
function writeSourceOverrideStation() {
  writeStation({
    dates: {
      [SRC_DATE]: [
        { id: SHOW_ID, startTime: '08:00', durationMinutes: 60, description: `show-descriptions/${SHOW_ID}.md` },
        { id: SHOW_ID, startTime: '20:00', durationMinutes: 60, description: `show-descriptions/${SHOW_ID}.md` },
      ],
    },
  });
}
writeSourceOverrideStation();

// A fake DIRECTED source occurrence: playlist.m3u + context.json, exactly the
// isDirected contract -- nothing more is needed for a rebroadcast.
function writeSourceOccurrence(date, tk, { playlist = PLAYLIST_PRIMARY, context = SOURCE_CONTEXT } = {}) {
  const dir = occurrenceDir(weekdayKey(dateFromKey(date)), SHOW_ID, date, tk);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playlist.m3u'), playlist);
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context));
  return dir;
}
writeSourceOccurrence(SRC_DATE, '08-00');
writeSourceOccurrence(SRC_DATE, '20-00', { playlist: PLAYLIST_SECONDARY });

// The replay entry as a day-list occurrence (the stationWriter-validated
// shape; the materializer itself only reads type/sourceDate/sourceTimeKey/id).
function replayEntry(overrides = {}) {
  return {
    id: SHOW_ID,
    startTime: '10:00',
    durationMinutes: 60,
    description: `show-descriptions/${SHOW_ID}.md`,
    type: 'replay',
    sourceDate: SRC_DATE,
    ...overrides,
  };
}

// Walks `root` and collects every file whose name passes `keep` -- used to
// prove that NO production side effect (script.md/error.json/...) ever
// appeared anywhere under running/.
function collectFiles(root, keep) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (keep(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// Comments only, no string literals containing "//": every pinned file below
// is safe for this crude strip (the honestOffline.test.mjs trick).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const srcOf = (rel) => stripComments(fs.readFileSync(path.join(repoRoot(), rel), 'utf8'));

// ---------------------------------------------------------------------------
// A. materializeReplayOccurrence
// ---------------------------------------------------------------------------
describe('A. materializeReplayOccurrence', () => {
  test('happy path: copies BOTH files into the target occurrence dir, keeps durationSeconds, stamps replay + replayOf', () => {
    const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '08-00' }), REPLAY_WEEKDAY, REPLAY_DATE, '10-00');
    assert.equal(ok, true);
    const target = occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '10-00');
    assert.equal(fs.readFileSync(path.join(target, 'playlist.m3u'), 'utf8'), PLAYLIST_PRIMARY, 'playlist bytes identical to the source');
    const ctx = JSON.parse(fs.readFileSync(path.join(target, 'context.json'), 'utf8'));
    assert.equal(ctx.durationSeconds, SOURCE_CONTEXT.durationSeconds, 'durationSeconds survives (loadOccurrence reads it, confirmOccurrenceStart re-anchors from it)');
    assert.equal(ctx.persona, 'elena', 'every other source field survives the spread');
    assert.equal(ctx.trackCount, 2);
    assert.equal(ctx.replay, true);
    assert.deepEqual(ctx.replayOf, { date: SRC_DATE, timeKey: '08-00' });
  });

  test('default sourceTimeKey = the FIRST occurrence of the show on sourceDate (two same-show entries -> the earlier one)', () => {
    const ok = materializeReplayOccurrence(replayEntry(), REPLAY_WEEKDAY, REPLAY_DATE, '11-00');
    assert.equal(ok, true);
    const target = occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '11-00');
    const ctx = JSON.parse(fs.readFileSync(path.join(target, 'context.json'), 'utf8'));
    assert.deepEqual(ctx.replayOf, { date: SRC_DATE, timeKey: '08-00' }, 'the 08:00 entry wins, not the 20:00 one');
    // PRIMARY (A,B) order is the 08-00 episode's playlist -- byte-level proof:
    assert.equal(fs.readFileSync(path.join(target, 'playlist.m3u'), 'utf8'), PLAYLIST_PRIMARY);
  });

  test('explicit sourceTimeKey picks the RIGHT episode (20-00, not the first)', () => {
    const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '20-00' }), REPLAY_WEEKDAY, REPLAY_DATE, '12-00');
    assert.equal(ok, true);
    const target = occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '12-00');
    const ctx = JSON.parse(fs.readFileSync(path.join(target, 'context.json'), 'utf8'));
    assert.deepEqual(ctx.replayOf, { date: SRC_DATE, timeKey: '20-00' });
    assert.equal(fs.readFileSync(path.join(target, 'playlist.m3u'), 'utf8'), PLAYLIST_SECONDARY, 'the SECONDARY (B,A) order proves the 20-00 episode was copied');
  });

  test('the source lineup may come from the weekday TEMPLATE too (a date override is not required)', () => {
    writeStation({
      [SRC_WEEKDAY]: [
        { id: SHOW_ID, startTime: '08:00', durationMinutes: 60, description: `show-descriptions/${SHOW_ID}.md` },
        { id: SHOW_ID, startTime: '20:00', durationMinutes: 60, description: `show-descriptions/${SHOW_ID}.md` },
      ],
    });
    try {
      const ok = materializeReplayOccurrence(replayEntry(), REPLAY_WEEKDAY, REPLAY_DATE, '16-00');
      assert.equal(ok, true);
      const ctx = JSON.parse(
        fs.readFileSync(path.join(occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '16-00'), 'context.json'), 'utf8')
      );
      assert.deepEqual(ctx.replayOf, { date: SRC_DATE, timeKey: '08-00' });
    } finally {
      writeSourceOverrideStation();
    }
  });

  test('missing source dir entirely -> honest no-op: falsy, NOTHING written (not even the target dir), no throw', () => {
    // sourceTimeKey pointing at a time nothing was ever directed at
    const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '23-59' }), REPLAY_WEEKDAY, REPLAY_DATE, '13-00');
    assert.equal(ok, false);
    assert.equal(
      fs.existsSync(occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '13-00')),
      false,
      'no partial dir left behind -- every validation precedes the mkdir'
    );
  });

  test('source dir without playlist.m3u (context only) -> honest no-op', () => {
    const srcDir = occurrenceDir(SRC_WEEKDAY, SHOW_ID, SRC_DATE, '09-00');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'context.json'), JSON.stringify(SOURCE_CONTEXT));
    const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '09-00' }), REPLAY_WEEKDAY, REPLAY_DATE, '14-00');
    assert.equal(ok, false);
    const target = occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '14-00');
    assert.equal(fs.existsSync(path.join(target, 'playlist.m3u')), false);
    assert.equal(fs.existsSync(path.join(target, 'context.json')), false);
  });

  test('source dir without context.json (playlist only) -> honest no-op', () => {
    const srcDir = occurrenceDir(SRC_WEEKDAY, SHOW_ID, SRC_DATE, '09-30');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'playlist.m3u'), PLAYLIST_PRIMARY);
    const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '09-30' }), REPLAY_WEEKDAY, REPLAY_DATE, '14-30');
    assert.equal(ok, false);
    const target = occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '14-30');
    assert.equal(fs.existsSync(path.join(target, 'playlist.m3u')), false);
    assert.equal(fs.existsSync(path.join(target, 'context.json')), false);
  });

  test('unparseable source context.json -> honest no-op (tolerant parse, the loadOccurrence doctrine)', () => {
    const srcDir = occurrenceDir(SRC_WEEKDAY, SHOW_ID, SRC_DATE, '09-45');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'playlist.m3u'), PLAYLIST_PRIMARY);
    fs.writeFileSync(path.join(srcDir, 'context.json'), '{not json');
    const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '09-45' }), REPLAY_WEEKDAY, REPLAY_DATE, '14-45');
    assert.equal(ok, false);
    assert.equal(fs.existsSync(occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '14-45')), false);
  });

  test('no occurrence of the show on the source date (default resolution) -> honest no-op', () => {
    writeStation({
      dates: {
        [SRC_DATE]: [{ id: OTHER_SHOW_ID, startTime: '08:00', durationMinutes: 60, description: `show-descriptions/${OTHER_SHOW_ID}.md` }],
      },
    });
    try {
      const ok = materializeReplayOccurrence(replayEntry(), REPLAY_WEEKDAY, REPLAY_DATE, '15-00');
      assert.equal(ok, false);
      assert.equal(fs.existsSync(occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '15-00')), false);
    } finally {
      writeSourceOverrideStation();
    }
  });

  test('a non-replay entry (hand-edited station.json defense) -> honest no-op, never a throw', () => {
    const ok = materializeReplayOccurrence(
      { id: SHOW_ID, startTime: '10:00', durationMinutes: 60 },
      REPLAY_WEEKDAY,
      REPLAY_DATE,
      '15-30'
    );
    assert.equal(ok, false);
    assert.equal(fs.existsSync(occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '15-30')), false);
  });

  test('idempotency: a second run over an already-materialized target is a no-op (no rewrite -- inode pin)', () => {
    const ok1 = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '08-00' }), REPLAY_WEEKDAY, REPLAY_DATE, '17-00');
    assert.equal(ok1, true);
    const playlistPath = path.join(occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '17-00'), 'playlist.m3u');
    const before = fs.statSync(playlistPath);
    const contentBefore = fs.readFileSync(playlistPath, 'utf8');
    const ok2 = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '08-00' }), REPLAY_WEEKDAY, REPLAY_DATE, '17-00');
    assert.equal(ok2, true, 'an already-materialized slot still reports "airable"');
    const after = fs.statSync(playlistPath);
    // A rewrite goes through tmp+rename, which REPLACES the file -- a NEW
    // inode. Same inode + same bytes = provably untouched.
    assert.equal(after.ino, before.ino, 'playlist.m3u was not rewritten');
    assert.equal(fs.readFileSync(playlistPath, 'utf8'), contentBefore);
  });
});

// ---------------------------------------------------------------------------
// B. scheduleScripts.js -- the skip that keeps first-air statistics alive
// ---------------------------------------------------------------------------
describe('B. scheduleScripts.js replay skip', () => {
  test('STRUCTURAL: the replay skip sits at the TOP of the loop, BEFORE the script.md existsSync check', () => {
    const src = srcOf('src/scheduler/scheduleScripts.js');
    const loopAt = src.indexOf('for (const { show, weekday, date } of scheduleUtil.upcomingOccurrences');
    const skipAt = src.indexOf("if (show.type === 'replay') continue;");
    const scriptAt = src.indexOf("fs.existsSync(path.join(showDateDir, 'script.md'))");
    assert.ok(loopAt !== -1, 'the upcomingOccurrences loop is present');
    assert.ok(skipAt !== -1, 'the replay skip is present');
    assert.ok(scriptAt !== -1, 'the script.md existsSync check is present');
    assert.ok(loopAt < skipAt, 'the skip is at the top of the loop');
    assert.ok(skipAt < scriptAt, 'the skip precedes the script.md check -- the first-air-statistics guarantee');
  });

  test('BEHAVIORAL: a replay inside the script horizon produces no script.md, no error.json, no ledger', async () => {
    // ~60min out: inside scriptLeadTimeMinutes (120) and past
    // minLeadTimeMinutes (30), so WITHOUT the skip this would queue a real
    // generateScript. Registered on TODAY's and TOMORROW's effective lineups
    // both -- whichever side of midnight now+60min lands on, the walker
    // (today + tomorrow candidates) finds it.
    const ahead = new Date(Date.now() + 60 * 60000);
    const startTime = `${String(ahead.getHours()).padStart(2, '0')}:${String(ahead.getMinutes()).padStart(2, '0')}`;
    const entry = replayEntry({ startTime });
    writeStation({
      dates: {
        [dateKey(new Date())]: [entry],
        [dateKey(addCalendarDays(new Date(), 1))]: [entry],
      },
    });
    try {
      await checkAndTriggerScripts();
      // Without the skip, generateScript mkdir's the dateDir and writes at
      // least error.json even when the pipeline then fails (the auto producer
      // over an empty localDirs library resolves zero tracks) -- so "no
      // production file anywhere under running/" is a real regression signal,
      // not a vacuous pass.
      const produced = collectFiles(RUNNING_DIR, (name) =>
        ['script.md', 'error.json', 'transcript.json', 'tracks.json'].includes(name)
      );
      assert.deepEqual(produced, [], 'no production side effects anywhere under running/');
      assert.equal(fs.existsSync(config.paths.historyFile), false, 'no played.jsonl -- the first-air ledger is untouched');
    } finally {
      writeSourceOverrideStation();
    }
  });
});

// ---------------------------------------------------------------------------
// C. scheduleDirect.js -- both routing points
// ---------------------------------------------------------------------------
describe('C. scheduleDirect.js replay routing', () => {
  test('STRUCTURAL: checkAndTriggerDirect routes playlist-marker -> replay materialize -> script.md, in that order', () => {
    const src = srcOf('src/scheduler/scheduleDirect.js');
    const fnAt = src.indexOf('export async function checkAndTriggerDirect');
    assert.ok(fnAt !== -1, 'checkAndTriggerDirect present');
    const body = src.slice(fnAt, src.indexOf('function findIncompleteOccurrences'));
    const playlistMarkerAt = body.indexOf("fs.existsSync(path.join(showOccurrenceDir, 'playlist.m3u'))");
    const replayAt = body.indexOf("show.type === 'replay'");
    const materializeAt = body.indexOf('materializeReplayOccurrence(show, weekday, date, timeKey)');
    const scriptAt = body.indexOf("path.join(showDateDir, 'script.md')");
    assert.ok(playlistMarkerAt !== -1, 'the playlist.m3u already-directed/already-materialized marker check is present');
    assert.ok(replayAt !== -1, 'the replay routing condition is present');
    assert.ok(materializeAt !== -1, 'the materializeReplayOccurrence call is present');
    assert.ok(scriptAt !== -1, 'the script.md requirement is present');
    assert.ok(playlistMarkerAt < replayAt, 'the already-materialized marker fires first (repeat ticks are free)');
    assert.ok(replayAt < materializeAt, 'the routing condition guards the materialize call');
    assert.ok(materializeAt < scriptAt, 'a replay is materialized INSTEAD of waiting for a script.md it never has');
  });

  test('STRUCTURAL: rebuildIncompleteOccurrences re-MATERIALIZES incomplete replays instead of re-directing them', () => {
    const src = srcOf('src/scheduler/scheduleDirect.js');
    const fnAt = src.indexOf('export async function rebuildIncompleteOccurrences');
    assert.ok(fnAt !== -1, 'rebuildIncompleteOccurrences present');
    const body = src.slice(fnAt);
    const replayAt = body.indexOf("show.type === 'replay'");
    const materializeAt = body.indexOf('materializeReplayOccurrence(show, weekday, date, timeKey)');
    const directAt = body.indexOf('await directOccurrence(');
    assert.ok(replayAt !== -1, 'the replay routing condition is present');
    assert.ok(materializeAt !== -1, 'the materializeReplayOccurrence call is present');
    assert.ok(directAt !== -1, 'the directOccurrence call is present');
    assert.ok(
      replayAt < materializeAt && materializeAt < directAt,
      'replay routing + the cheap copy sit before the directOccurrence path'
    );
  });

  test('STRUCTURAL: the import is wired (the routing would throw at boot without it)', () => {
    const src = srcOf('src/scheduler/scheduleDirect.js');
    assert.match(src, /import \{ materializeReplayOccurrence \} from '\.\/replayMaterializer\.js';/);
  });

  test('BEHAVIORAL: checkAndTriggerDirect materializes a replay occurrence inside the direct horizon', async () => {
    // ~8min out: inside directLeadTimeMinutes (15). The replay carries an
    // explicit sourceTimeKey so the source resolution needs no lineup read.
    const ahead = new Date(Date.now() + 8 * 60000);
    const startTime = `${String(ahead.getHours()).padStart(2, '0')}:${String(ahead.getMinutes()).padStart(2, '0')}`;
    const tk = timeKey(startTime);
    const entry = replayEntry({ startTime, sourceTimeKey: '08-00' });
    writeStation({
      dates: {
        [dateKey(new Date())]: [entry],
        [dateKey(addCalendarDays(new Date(), 1))]: [entry],
      },
    });
    try {
      await checkAndTriggerDirect();
      // The materialized occurrence lands on whichever of today/tomorrow
      // actually contains now+8min -- assert EXACTLY one slot got a playlist.
      const hit = [dateKey(new Date()), dateKey(addCalendarDays(new Date(), 1))]
        .map((d) => occurrenceDir(weekdayKey(dateFromKey(d)), SHOW_ID, d, tk))
        .filter((dir) => fs.existsSync(path.join(dir, 'playlist.m3u')));
      assert.equal(hit.length, 1, `exactly one materialized replay dir, got ${hit.length}`);
      assert.equal(fs.readFileSync(path.join(hit[0], 'playlist.m3u'), 'utf8'), PLAYLIST_PRIMARY);
      const ctx = JSON.parse(fs.readFileSync(path.join(hit[0], 'context.json'), 'utf8'));
      assert.deepEqual(ctx.replayOf, { date: SRC_DATE, timeKey: '08-00' });
    } finally {
      writeSourceOverrideStation();
    }
  });
});

// ---------------------------------------------------------------------------
// D. schedulePrewarmAudio.js -- the explicit skip
// ---------------------------------------------------------------------------
describe('D. schedulePrewarmAudio.js replay skip (structural)', () => {
  test('the explicit replay skip sits at the top of the loop, before the script.md check', () => {
    const src = srcOf('src/scheduler/schedulePrewarmAudio.js');
    const loopAt = src.indexOf('for (const { show, weekday, date } of scheduleUtil.upcomingOccurrences');
    const skipAt = src.indexOf("if (show.type === 'replay') continue;");
    const scriptAt = src.indexOf("path.join(showDateDir, 'script.md')");
    assert.ok(loopAt !== -1, 'the upcomingOccurrences loop is present');
    assert.ok(skipAt !== -1, 'the replay skip is present');
    assert.ok(scriptAt !== -1, 'the script.md check is present');
    assert.ok(loopAt < skipAt, 'the skip is at the top of the loop (explicit beats implicit)');
    assert.ok(skipAt < scriptAt, 'the skip precedes the script.md check');
  });
});

// ---------------------------------------------------------------------------
// E. scrobbleTrack.js -- the replay stamp
// ---------------------------------------------------------------------------
describe('E. scrobbleTrack.js replay stamp (the extract route)', () => {
  // scrobbleTrack.js is a per-segment CLI (radio.liq's on_track hook) whose
  // full main() needs a track library + ratingKey index; scrobble.test.mjs's
  // harness covers the EXTERNAL scrobble module (broadcast/scrobble.js), not
  // this entry construction. So recordNowPlaying is EXPORTED (the
  // promoProducer.js test-seam precedent) and driven here directly with a
  // scratch state file -- behavioral, no logic extracted or re-implemented.
  const TRACK = { ratingKey: 'rk-42', artist: 'Artist', title: 'Song', album: 'Album', art: '/art.png', durationMs: 180000 };

  function writeNowPlayingState(state) {
    fs.writeFileSync(config.paths.nowPlayingStatePath, JSON.stringify(state));
  }
  function lastAiredLine() {
    return fs.readFileSync(config.paths.airedHistoryFile, 'utf8').trim().split('\n').at(-1);
  }

  test('state.replayOf -> replay:true in BOTH now_playing_track.json and aired.jsonl', () => {
    writeNowPlayingState({
      weekday: REPLAY_WEEKDAY,
      id: SHOW_ID,
      date: REPLAY_DATE,
      timeKey: '10-00',
      estimatedEndAt: 0,
      confirmed: true,
      replayOf: { date: SRC_DATE, timeKey: '08-00' },
    });
    recordNowPlaying(TRACK);
    const np = JSON.parse(fs.readFileSync(config.paths.nowPlayingTrackPath, 'utf8'));
    assert.equal(np.replay, true);
    assert.equal(JSON.parse(lastAiredLine()).replay, true);
  });

  test('no replayOf in state -> NO replay key anywhere; the entry shape is byte-identical to pre-C2', () => {
    writeNowPlayingState({
      weekday: REPLAY_WEEKDAY,
      id: SHOW_ID,
      date: REPLAY_DATE,
      timeKey: '10-00',
      estimatedEndAt: 0,
      confirmed: true,
    });
    recordNowPlaying(TRACK);
    const npRaw = fs.readFileSync(config.paths.nowPlayingTrackPath, 'utf8');
    assert.ok(!npRaw.includes('replay'), 'the key is dropped entirely (JSON.stringify drops undefined)');
    const np = JSON.parse(npRaw);
    assert.deepEqual(
      Object.keys(np).sort(),
      ['album', 'art', 'artist', 'durationMs', 'playedAt', 'ratingKey', 'showId', 'title'],
      'exactly the pre-C2 field set'
    );
    assert.ok(!lastAiredLine().includes('replay'), 'aired.jsonl stays pre-C2 shaped too');
  });

  test('no state file at all (first run ever) -> showId null, still no replay key', () => {
    fs.rmSync(config.paths.nowPlayingStatePath, { force: true });
    recordNowPlaying(TRACK);
    const np = JSON.parse(fs.readFileSync(config.paths.nowPlayingTrackPath, 'utf8'));
    assert.equal(np.showId, null);
    assert.equal('replay' in np, false);
  });
});

// ---------------------------------------------------------------------------
// F. stationWriter replay validation (public API)
// ---------------------------------------------------------------------------
describe('F. stationWriter replay validation (public API)', () => {
  function resetStation() {
    writeStation({});
  }

  test('a valid replay entry is accepted and persisted as-is (past sourceDate, explicit sourceTimeKey)', async () => {
    resetStation();
    const day = await replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', sourceTimeKey: '08-00' })]);
    assert.equal(day.length, 1);
    assert.equal(day[0].type, 'replay');
    assert.equal(day[0].sourceDate, SRC_DATE);
    assert.equal(day[0].sourceTimeKey, '08-00');
    // Persisted through the READ half:
    const stored = loadSchedule().monday.find((s) => s.id === SHOW_ID);
    assert.equal(stored.type, 'replay');
    assert.equal(stored.sourceDate, SRC_DATE);
    assert.equal(stored.sourceTimeKey, '08-00');
  });

  test('"rebroadcast" (the LibreTime word) is rejected -- only "replay" is the type', async () => {
    resetStation();
    await assert.rejects(
      () => replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', type: 'rebroadcast' })]),
      /Invalid occurrence type "rebroadcast"/
    );
  });

  test('a replay without sourceDate is rejected', async () => {
    resetStation();
    const { sourceDate, ...noSource } = replayEntry({ startTime: '20:00' });
    assert.equal(sourceDate, SRC_DATE); // prove the destructure removed the right key
    await assert.rejects(() => replaceDaySchedule('monday', [noSource]), /requires "sourceDate"/);
  });

  test('a FUTURE sourceDate is rejected (the source episode has not aired yet)', async () => {
    resetStation();
    const tomorrow = dateKey(addCalendarDays(new Date(), 1));
    await assert.rejects(
      () => replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', sourceDate: tomorrow })]),
      /is in the future/
    );
  });

  test('a malformed sourceTimeKey is rejected (HH-MM, not HH:MM)', async () => {
    resetStation();
    await assert.rejects(
      () => replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', sourceTimeKey: '10:30' })]),
      /Invalid sourceTimeKey "10:30"/
    );
  });

  test('a calendar-impossible sourceDate is rejected (2026-02-31 is not a real date)', async () => {
    resetStation();
    await assert.rejects(
      () => replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', sourceDate: '2026-02-31' })]),
      /not a real calendar date/
    );
  });

  test('updateOccurrence with an id CHANGE strips type/sourceDate/sourceTimeKey (the source points at the OLD show)', async () => {
    resetStation();
    await replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', sourceTimeKey: '08-00' })]);
    const day = await updateOccurrence('monday', '20-00', { id: OTHER_SHOW_ID });
    const moved = day.find((s) => s.id === OTHER_SHOW_ID);
    assert.equal(moved.type, undefined, 'type stripped on id change');
    assert.equal(moved.sourceDate, undefined, 'sourceDate stripped on id change');
    assert.equal(moved.sourceTimeKey, undefined, 'sourceTimeKey stripped on id change');
    // Persisted clean (loadSchedule re-reads the file from disk):
    const stored = loadSchedule().monday.find((s) => s.id === OTHER_SHOW_ID);
    assert.equal(stored.type, undefined);
    assert.equal(stored.sourceDate, undefined);
    assert.equal(stored.sourceTimeKey, undefined);
  });

  test('updateOccurrence WITHOUT an id change keeps the replay fields', async () => {
    resetStation();
    await replaceDaySchedule('monday', [replayEntry({ startTime: '20:00', sourceTimeKey: '08-00' })]);
    const day = await updateOccurrence('monday', '20-00', { durationMinutes: 90 });
    const kept = day.find((s) => s.id === SHOW_ID);
    assert.equal(kept.type, 'replay');
    assert.equal(kept.sourceDate, SRC_DATE);
    assert.equal(kept.sourceTimeKey, '08-00');
  });
});

// ---------------------------------------------------------------------------
// G. played.jsonl untouched -- the first-air stat guarantee
// ---------------------------------------------------------------------------
describe('G. played.jsonl untouched (the first-air stat guarantee)', () => {
  test('a materialize pass never writes the production ledger (sentinel left byte-identical)', () => {
    // Only generateScript -> recordPlayed/recordAutoPlayedTracks writes
    // history/played.jsonl, and a replay never runs generateScript -- the
    // materializer has no path into this file at all.
    fs.mkdirSync(path.dirname(config.paths.historyFile), { recursive: true });
    fs.writeFileSync(config.paths.historyFile, '{"sentinel":"first-air ledger"}\n');
    try {
      const ok = materializeReplayOccurrence(replayEntry({ sourceTimeKey: '08-00' }), REPLAY_WEEKDAY, REPLAY_DATE, '18-00');
      assert.equal(ok, true);
      assert.equal(fs.readFileSync(config.paths.historyFile, 'utf8'), '{"sentinel":"first-air ledger"}\n');
    } finally {
      fs.rmSync(config.paths.historyFile, { force: true });
    }
  });

  test('and nothing in this whole file ever produced a script: no played.jsonl exists at exit', () => {
    assert.equal(fs.existsSync(config.paths.historyFile), false);
  });
});

// ---------------------------------------------------------------------------
// H. the operator-rescue CLI (real child process)
// ---------------------------------------------------------------------------
describe('H. operator-rescue CLI (real child process)', () => {
  const CLI = path.join(repoRoot(), 'src', 'scheduler', 'replayMaterializer.js');
  const runCli = (args) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });

  test('node src/scheduler/replayMaterializer.js <weekday> <showId> <date> <timeKey> materializes the slot, EXIT 0', () => {
    // The child finds the repo-root config.json this file's setupTestConfig()
    // wrote (the timezone.test.mjs child-process precedent), so it sees the
    // exact same scratch dataDir/station. The replay entry lives in a date
    // OVERRIDE (the C1+C2 integration) with NO explicit sourceTimeKey -- the
    // CLI exercises the default first-occurrence resolution end to end.
    writeStation({
      dates: {
        [SRC_DATE]: [
          { id: SHOW_ID, startTime: '08:00', durationMinutes: 60, description: `show-descriptions/${SHOW_ID}.md` },
          { id: SHOW_ID, startTime: '20:00', durationMinutes: 60, description: `show-descriptions/${SHOW_ID}.md` },
        ],
        [REPLAY_DATE]: [replayEntry({ startTime: '22:00' })],
      },
    });
    try {
      const res = runCli([REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '22-00']);
      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);
      assert.match(res.stdout, /materialized/);
      const target = occurrenceDir(REPLAY_WEEKDAY, SHOW_ID, REPLAY_DATE, '22-00');
      assert.equal(fs.readFileSync(path.join(target, 'playlist.m3u'), 'utf8'), PLAYLIST_PRIMARY);
      const ctx = JSON.parse(fs.readFileSync(path.join(target, 'context.json'), 'utf8'));
      assert.deepEqual(ctx.replayOf, { date: SRC_DATE, timeKey: '08-00' }, 'default resolution through the CLI too');
    } finally {
      writeSourceOverrideStation();
    }
  });

  test('missing arguments -> usage error, non-zero exit (honest no-ops stay EXIT 0)', () => {
    const res = runCli([]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Usage:/);
  });

  test('a no-op rescue (no such occurrence on that date) -> EXIT 0 with an honest log line', () => {
    const res = runCli([REPLAY_WEEKDAY, 'no-such-show', REPLAY_DATE, '23-00']);
    assert.equal(res.status, 0, `honest no-op must not fail the operator: ${res.stderr}`);
    assert.match(res.stdout, /nothing to materialize/);
  });
});
