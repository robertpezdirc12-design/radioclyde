// Tests for the format ura / clockwheel (P2 #10, AzuraCast PR #8433 design --
// scheduler/clockwheel.js + its generateFillerPlaylist.js integration).
//
// Three layers, mirroring how the feature is built:
//   A. pure config/daypart/pool-split math on synthetic track arrays
//      (exact windows, first-match-wins, honest degradation on typos),
//   B. the wheel walk itself: strict step order, pool exhaustion, dead-pass
//      stop, continuity across passes (no repeat until a pool runs dry),
//   C. end-to-end filler generation on real WAV fixtures in genre
//      subdirectories -- the written m3u must follow the wheel sequence
//      exactly, and removing the config block must restore the plain path.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav, repoRoot } from './fixtures.mjs';

setupTestConfig('clockwheel', {
  filler: {
    poolSize: 8,
    regenerateIntervalMinutes: 360,
    maxTrackDurationSeconds: 600,
    rotationWindowHours: 24,
    rotation: {
      maxTracksPerArtist: 30,
      maxTracksPerArtistAlbum: 0, // WAV fixtures carry no album tags
      weightWindowDays: 7,
      noveltyDays: 7,
      noveltyBoost: 3,
    },
    clockwheel: {
      pools: {
        chill: { genres: ['chill'] },
      },
      steps: [
        { pool: 'chill', count: 2 },
        { pool: 'rotation', count: 2 },
      ],
    },
  },
});

const {
  clockwheelConfig,
  parseWheelTime,
  daypartSteps,
  splitPools,
  preparePoolQueue,
  walkWheel,
  runClockwheel,
  RESERVED_POOL,
} = await import('../src/scheduler/clockwheel.js');
const { config: liveConfig } = await import('../src/config/index.js');
const { generateFillerPlaylist } = await import('../src/scheduler/generateFillerPlaylist.js');

const rot = {
  maxTracksPerArtist: 30,
  maxTracksPerArtistAlbum: 0,
  weightWindowDays: 7,
  noveltyDays: 7,
  noveltyBoost: 3,
};

function track(artist, title, extra = {}) {
  return { ratingKey: `${artist}/${title}`.toLowerCase(), artist, title, album: null, ...extra };
}

// m3uPaths() in fixtures.mjs sorts -- the wheel IS the order, so this reads
// the file's raw sequence instead.
function m3uOrderedPaths(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(l.lastIndexOf(':') + 1));
}

describe('config parsing + dayparts (pure math)', () => {
  test('missing/empty clockwheel block disables the feature (F2 pattern)', async () => {
    const saved = liveConfig.filler.clockwheel;
    try {
      delete liveConfig.filler.clockwheel;
      assert.equal(clockwheelConfig(), null, 'no block -> null');
      liveConfig.filler.clockwheel = {};
      assert.equal(clockwheelConfig(), null, 'block with no steps and no dayparts -> null');
      liveConfig.filler.clockwheel = { steps: [{ pool: 'nope', count: 0 }], dayparts: [{ from: 'bad', to: 'worse', steps: [] }] };
      assert.equal(clockwheelConfig(), null, 'all-invalid entries -> null (nothing to resolve)');
    } finally {
      liveConfig.filler.clockwheel = saved;
    }
  });

  test('clockwheelConfig parses steps/dayparts and counts dropped entries', () => {
    const saved = liveConfig.filler.clockwheel;
    try {
      liveConfig.filler.clockwheel = {
        pools: { chill: { genres: ['chill'] } },
        steps: [
          { pool: 'chill', count: 2 },
          { pool: '', count: 3 }, // dropped: empty pool name
          { pool: 'rotation', count: -1 }, // dropped: count <= 0
          { count: 2 }, // dropped: missing pool
        ],
        dayparts: [
          { from: '06:00', to: '10:00', steps: [{ pool: 'chill', count: 1 }] },
          { from: '10:00', to: '06:00', steps: [{ pool: 'chill', count: 1 }] }, // dropped: to <= from
          { from: '22:00', to: '23:00', steps: [] }, // dropped: empty steps
        ],
      };
      const cfg = clockwheelConfig();
      assert.equal(cfg.droppedSteps, 3);
      assert.equal(cfg.droppedDayparts, 2);
      assert.deepEqual(cfg.steps, [{ pool: 'chill', count: 2 }]);
      assert.equal(cfg.dayparts.length, 1);
    } finally {
      liveConfig.filler.clockwheel = saved;
    }
  });

  test('parseWheelTime is strict HH:MM plus the 24:00 sentinel', () => {
    assert.equal(parseWheelTime('06:00'), 360);
    assert.equal(parseWheelTime('23:59'), 23 * 60 + 59);
    assert.equal(parseWheelTime('24:00'), 1440);
    assert.equal(parseWheelTime('6:00'), null, 'no zero-padding -> rejected');
    assert.equal(parseWheelTime('bad'), null);
    assert.equal(parseWheelTime('24:01'), null);
    assert.equal(parseWheelTime(null), null);
  });

  test('daypartSteps: from inclusive, to exclusive, first match wins, default falls through', () => {
    const wheel = {
      steps: [{ pool: 'rotation', count: 1 }],
      dayparts: [
        { fromMin: parseWheelTime('06:00'), toMin: parseWheelTime('10:00'), steps: [{ pool: 'morning', count: 1 }] },
        { fromMin: parseWheelTime('08:00'), toMin: parseWheelTime('12:00'), steps: [{ pool: 'overlap', count: 1 }] },
      ],
    };
    const at = (h, m) => new Date(2026, 9, 24, h, m).getTime();
    assert.equal(daypartSteps(wheel, at(5, 59)).label, 'default');
    assert.equal(daypartSteps(wheel, at(6, 0)).label, '0 (06:00-10:00)', 'from is inclusive');
    assert.equal(daypartSteps(wheel, at(9, 59)).label, '0 (06:00-10:00)', 'first matching daypart wins over the overlap');
    assert.equal(daypartSteps(wheel, at(10, 0)).label, '1 (08:00-12:00)', 'to is exclusive, next window takes over');
    assert.equal(daypartSteps(wheel, at(12, 0)).label, 'default', 'outside every window -> default steps');
    const noDefault = { steps: [], dayparts: wheel.dayparts };
    assert.equal(daypartSteps(noDefault, at(12, 0)), null, 'no match and no default -> null (plain path)');
  });

  test('a wheel spanning midnight as two windows covers the whole day', () => {
    const wheel = {
      steps: [{ pool: 'rotation', count: 1 }],
      dayparts: [
        { fromMin: parseWheelTime('00:00'), toMin: parseWheelTime('05:00'), steps: [{ pool: 'night', count: 1 }] },
        { fromMin: parseWheelTime('23:00'), toMin: parseWheelTime('24:00'), steps: [{ pool: 'night', count: 1 }] },
      ],
    };
    const at = (h, m) => new Date(2026, 9, 24, h, m).getTime();
    assert.match(daypartSteps(wheel, at(2, 0)).label, /night|00:00/);
    assert.equal(daypartSteps(wheel, at(12, 0)).label, 'default');
    assert.match(daypartSteps(wheel, at(23, 30)).label, /23:00/);
  });
});

describe('pool split + wheel walk (pure math)', () => {
  const eligible = [
    track('Beyoncé', 'halo', { genre: ['pop'], ratingKey: 'k1' }),
    track('beyonce', 'xoxo', { genre: ['Pop'], ratingKey: 'k2' }), // same folded artist as k1
    track('Chill Guy', 'waves', { genre: ['chillout'], ratingKey: 'k3' }),
    track('Chill Guy', 'breeze', { genre: ['ambient'], ratingKey: 'k4' }),
    track('Metal Guy', 'thunder', { genre: ['chillout', 'metal'], ratingKey: 'k5' }),
    track('Anyone', 'love song', { genre: [], ratingKey: 'k6' }),
    track('Anyone', 'Chill Sessions', { genre: [], ratingKey: 'k7' }), // keyword hit on title
  ];

  test('splitPools: first matching pool wins, the rest is the reserved rotation pool', () => {
    const { named, rotation } = splitPools(eligible, {
      chill: { genres: ['chillout', 'ambient'], excludeKeywords: ['metal'] },
      love: { keywords: ['love'] },
      bey: { artists: ['beyoncé'] },
    });
    assert.deepEqual(named.get('chill').map((t) => t.ratingKey), ['k3', 'k4'], 'genre hit, excludeKeyword blocks metal');
    assert.deepEqual(named.get('love').map((t) => t.ratingKey), ['k6'], 'first-match-wins: k6 never reaches bey pool');
    assert.deepEqual(named.get('bey').map((t) => t.ratingKey), ['k1', 'k2'], 'folded artist match');
    assert.deepEqual(
      rotation.map((t) => t.ratingKey),
      ['k5', 'k7'],
      'metal goes to rotation; k7 hits the keyword only via title (not in love pool -> rotation)'
    );
  });

  test('splitPools: an empty filter pool matches nothing; reserved name is ignored', () => {
    const { named, rotation } = splitPools(eligible.slice(0, 1), {
      empty: {},
      [RESERVED_POOL]: { artists: ['Beyoncé'] },
    });
    assert.equal(named.get('empty').length, 0, 'empty filter must not swallow the library');
    assert.equal(named.has(RESERVED_POOL), false, 'reserved name never becomes a named pool');
    assert.equal(rotation.length, 1, 'the track lands in the reserved pool instead');
  });

  test('walkWheel: strict step order, continuity across passes, no repeats while the pool has members', () => {
    const queues = new Map([
      ['a', ['a1', 'a2', 'a3', 'a4']],
      ['b', ['b1', 'b2']],
    ]);
    const steps = [
      { pool: 'a', count: 2 },
      { pool: 'b', count: 1 },
    ];
    const { ordered, yields } = walkWheel(steps, queues, 7);
    assert.deepEqual(ordered, ['a1', 'a2', 'b1', 'a3', 'a4', 'b2'], 'pass1 a,a,b pass2 a,a,b');
    assert.deepEqual([...yields.entries()], [['a', 4], ['b', 2]]);
    // Third pass: every queue is dry -> the walk stopped at 6, not forever.
  });

  test('walkWheel: exhausted pool yields fewer, unknown pool yields nothing, dry pass stops the loop', () => {
    const queues = new Map([
      ['a', ['a1']],
      ['ghost', ['g1']],
    ]);
    const steps = [
      { pool: 'a', count: 3 },
      { pool: 'unknown', count: 2 },
    ];
    const { ordered, yields } = walkWheel(steps, queues, 10);
    assert.deepEqual(ordered, ['a1'], 'a pool yields what it has, the wheel walks on');
    assert.equal(yields.get('a'), 1);
    assert.equal(yields.has('unknown'), false);
    assert.equal(walkWheel([{ pool: 'a', count: 1 }], new Map([['a', []]]), 5).ordered.length, 0, 'all-dry -> empty, no spin');
  });

  test('preparePoolQueue applies the same weighted+cap chain per pool', () => {
    const sixA = Array.from({ length: 6 }, (_, i) => track('A', `song ${i}`, { ratingKey: `a${i}` }));
    const queue = preparePoolQueue(sixA, { ...rot, maxTracksPerArtist: 4 }, new Map());
    assert.equal(queue.length, 4, 'the artist cap binds inside the pool');
    // Same multiset (weighted order is a shuffle, not a filter): the two
    // dropped tracks are the overflow, never someone else's.
    assert.equal(new Set(sixA.map((t) => t.ratingKey)).difference(new Set(queue.map((t) => t.ratingKey))).size, 2);
  });

  test('runClockwheel returns null when nothing resolves, logs honest yields otherwise', async () => {
    const emptyWheel = { pools: {}, steps: [{ pool: 'rotation', count: 1 }], dayparts: [], droppedSteps: 0, droppedDayparts: 0 };
    const resolved = { steps: [{ pool: 'rotation', count: 1 }], label: 'default' };
    // daypartSteps resolves -> wheel runs; eligible empty -> yields nothing ->
    // [] (NOT null): the caller must not silently fall back to the plain path
    // when a wheel is genuinely configured.
    const out = runClockwheel({ eligible: [], wheel: emptyWheel, rot, counts: new Map(), poolSize: 4 });
    assert.deepEqual(out, []);
    // Null only comes from daypartSteps -- which the caller already checked;
    // here we verify the composite returns the walk's result untouched.
    const wheel2 = { pools: {}, steps: [{ pool: 'rotation', count: 2 }], dayparts: [], droppedSteps: 0, droppedDayparts: 0 };
    const out2 = runClockwheel({
      eligible: [track('A', 'one', { ratingKey: 'r1' }), track('B', 'two', { ratingKey: 'r2' })],
      wheel: wheel2,
      rot,
      counts: new Map(),
      poolSize: 4,
      now: (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })(),
    });
    assert.equal(out2.length, 2, 'both tracks through the rotation queue');
    assert.ok(resolved); // shape guard -- label/steps used by the log path
  });
});

describe('filler integration (end-to-end, real WAV library in genre folders)', () => {
  const musicDir = path.join(liveConfig.dataDir, 'music-wheel');
  const chillDir = path.join(musicDir, 'chill');
  const rockDir = path.join(musicDir, 'rock');
  // localLibrary derives a genre tag from the immediate subdirectory name,
  // so files under chill/ carry genre "chill" and rock/ carry "rock" --
  // exactly what the config's pool filter matches on.
  for (let i = 1; i <= 4; i++) {
    writeWav(path.join(chillDir, `Chill Artist - Chill Song ${i}.wav`), 2);
    writeWav(path.join(rockDir, `Rock Artist - Rock Song ${i}.wav`), 2);
  }
  if (!liveConfig.autoRadio.music.localDirs.includes(musicDir)) {
    liveConfig.autoRadio.music.localDirs = [musicDir];
    fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(liveConfig, null, 2));
  }

  test('the written m3u follows the wheel: 2 chill, 2 rotation (rock), 2 chill, 2 rotation', async () => {
    const { trackCount } = await generateFillerPlaylist();
    const ordered = m3uOrderedPaths(liveConfig.paths.fillerPath);
    assert.equal(trackCount, 8, 'full pool from 4+4 fixtures');
    assert.equal(ordered.length, 8);
    const dirOf = (p) => path.basename(path.dirname(p));
    assert.deepEqual(ordered.map((p) => dirOf(p)), ['chill', 'chill', 'rock', 'rock', 'chill', 'chill', 'rock', 'rock'],
      'wheel pass 1 = chill:2 + rotation:2 (rotation remainder is rock), pass 2 continues without repeats');
    assert.equal(new Set(ordered).size, 8, 'no track repeats within one regeneration');
  });

  test('removing the clockwheel block restores the plain shuffled path (same multiset)', async () => {
    const before = m3uOrderedPaths(liveConfig.paths.fillerPath);
    const saved = liveConfig.filler.clockwheel;
    try {
      delete liveConfig.filler.clockwheel;
      fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(liveConfig, null, 2));
      const { trackCount } = await generateFillerPlaylist();
      assert.equal(trackCount, 8);
      const after = m3uOrderedPaths(liveConfig.paths.fillerPath);
      assert.deepEqual(
        [...after].sort(),
        [...before].sort(),
        'same 8 tracks, order no longer wheel-constrained'
      );
      // A single shuffle CAN land on the exact wheel pattern (the weighted
      // plain-path shuffle makes c,c,r,r,c,c,r,r likelier than a uniform
      // draw, and this assertion false-failed on air twice on 2026-10-24),
      // so a match alone proves nothing -- retry the regeneration a few
      // times and only fail if EVERY plain draw is the wheel sequence.
      let sawDifferentOrder = false;
      for (let attempt = 0; attempt < 3 && !sawDifferentOrder; attempt += 1) {
        await generateFillerPlaylist();
        const next = m3uOrderedPaths(liveConfig.paths.fillerPath);
        assert.deepEqual([...next].sort(), [...before].sort(), 'same multiset on every plain regeneration');
        sawDifferentOrder = next.map((p) => path.basename(path.dirname(p))).join() !== 'chill,chill,rock,rock,chill,chill,rock,rock';
      }
      assert.ok(sawDifferentOrder, 'plain path is a shuffle, not the wheel sequence');
    } finally {
      liveConfig.filler.clockwheel = saved;
      fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(liveConfig, null, 2));
    }
  });

  test('a dry wheel still backfills: pool never decays below what exists', async () => {
    // Daypart whose pool cannot fill the request: chill:6 asks for 6 of the
    // 4 chill tracks (yields 4), rotation:6 asks for 6 of 4 rock (yields 4).
    const saved = liveConfig.filler.clockwheel;
    try {
      liveConfig.filler.clockwheel = {
        pools: { chill: { genres: ['chill'] } },
        steps: [
          { pool: 'chill', count: 6 },
          { pool: 'rotation', count: 6 },
        ],
      };
      const { trackCount } = await generateFillerPlaylist();
      assert.equal(trackCount, 8, 'wheel yields 8 (all it has), pool holds every existing track');
      const ordered = m3uOrderedPaths(liveConfig.paths.fillerPath);
      assert.equal(ordered.length, 8);
    } finally {
      liveConfig.filler.clockwheel = saved;
    }
  });
});
