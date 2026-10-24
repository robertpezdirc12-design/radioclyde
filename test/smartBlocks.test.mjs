// Tests for P3 #14 -- deterministic Smart Blocks (LibreTime's model, analysis
// §4.4). Four layers, mirroring how the feature is built:
//   A. config + block validation (closed vocabulary -- unknown criteria key,
//      unknown order, missing/ambiguous limit are operator-fixable errors),
//   B. pure ordering math (LibreTime's newest/oldest with year-nulls-last,
//      alphabetical sequential, popular via weightedShuffle),
//   C. expansion against a REAL local WAV library in genre folders: count /
//      minute limits, LibreTime's no-overflow default vs overflow:true,
//      shortfall honesty, recently-played exclusion, neverPlay bans,
//      cross-expansion exclusion,
//   D. the seams: brief "- smart block: <name>" line parsing and the
//      produce.js / studio-API wiring.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav, repoRoot } from './fixtures.mjs';

setupTestConfig('smart-blocks', {
  smartBlocks: [
    { name: 'petkov večer jazz', criteria: { genre: 'jazz' }, limit: { count: 3 }, order: 'sequential' },
    { name: 'nočni ambient', criteria: { genre: 'ambient' }, limit: { minutes: 0.05 }, order: 'sequential' },
    { name: 'nočni ambient preliv', criteria: { genre: 'ambient' }, limit: { minutes: 0.05 }, order: 'sequential', overflow: true },
    { name: 'dolgi minute', criteria: { genre: 'ambient' }, limit: { minutes: 30 }, order: 'random' },
  ],
});

const {
  smartBlocksConfig,
  findSmartBlock,
  validateSmartBlock,
  orderTracks,
  expandSmartBlock,
} = await import('../src/producer/smartBlocks.js');
const { config: liveConfig } = await import('../src/config/index.js');
const { produceTrackQueryDeterministic } = await import('../src/auto/briefQuery.js');

function track(artist, title, extra = {}) {
  return { ratingKey: `${artist}/${title}`.toLowerCase(), artist, title, album: null, ...extra };
}

// ---------------------------------------------------------------------------
// A. config + validation
// ---------------------------------------------------------------------------

describe('smartBlocksConfig + validateSmartBlock', () => {
  test('missing config block -> empty (F2 pattern)', async () => {
    const saved = liveConfig.smartBlocks;
    try {
      delete liveConfig.smartBlocks;
      assert.deepEqual(smartBlocksConfig(), []);
      liveConfig.smartBlocks = 'banana';
      assert.deepEqual(smartBlocksConfig(), [], 'non-array ignored with a logged warning');
    } finally {
      liveConfig.smartBlocks = saved;
    }
  });

  test('every misshapen block gets a specific, operator-fixable error', () => {
    assert.throws(() => validateSmartBlock({ criteria: { genre: 'x' }, limit: { count: 1 } }), /missing a "name"/);
    assert.throws(() => validateSmartBlock({ name: 'x', criteria: { bpm: 120 }, limit: { count: 1 } }),
      /unknown criteria key\(s\): bpm.*Allowed:/, 'a second selection dialect is refused, not silently narrowed');
    assert.throws(() => validateSmartBlock({ name: 'x', criteria: { excludeKeywords: ['live'] }, limit: { count: 1 } }),
      /no selection criteria/, 'exclusions narrow a selection, they are not one');
    assert.throws(() => validateSmartBlock({ name: 'x', criteria: { genre: 'x' }, limit: { count: 2, minutes: 3 } }),
      /exactly one limit/, 'ambiguous limit refused');
    assert.throws(() => validateSmartBlock({ name: 'x', criteria: { genre: 'x' }, limit: {} }),
      /exactly one limit/);
    assert.throws(() => validateSmartBlock({ name: 'x', criteria: { genre: 'x' }, limit: { count: 1 }, order: 'banana' }),
      /unknown order "banana"/);
    // Valid shape passes through with defaults filled in.
    const shape = validateSmartBlock({ name: 'x', criteria: { genre: 'x' }, limit: { count: 2 } });
    assert.equal(shape.order, 'random', "LibreTime's default order");
    assert.equal(shape.overflow, false, "LibreTime's default no-overflow");
  });
});

describe('findSmartBlock', () => {
  test('fold-equal lookup (diacritics + case), unknown -> null', () => {
    assert.equal(findSmartBlock('Petkov Večer Jazz').name, 'petkov večer jazz');
    assert.equal(findSmartBlock('petkov vecer jazz').name, 'petkov večer jazz', 'fold bridges č->c');
    assert.equal(findSmartBlock('neobstojeci'), null);
    assert.equal(findSmartBlock(''), null);
  });
});

// ---------------------------------------------------------------------------
// B. ordering (pure)
// ---------------------------------------------------------------------------

describe('orderTracks', () => {
  const pool = [
    track('B', 'beta', { year: 1990, album: 'zeta' }),
    track('A', 'alpha', { year: 2001, album: 'alpha' }),
    track('C', 'gamma', { year: null, album: 'mid' }),
  ];

  test('newest/oldest: chronological with year-nulls last in both directions', () => {
    assert.deepEqual(orderTracks(pool, 'newest').map((t) => t.title), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(orderTracks(pool, 'oldest').map((t) => t.title), ['beta', 'alpha', 'gamma'],
      'a missing year must not vanish to the front of oldest just because 0 < 1962');
  });

  test('sequential: fold-alphabetical artist -> album -> title', () => {
    const pool2 = [
      track('žagar', 'delta', { album: 'b' }),
      track('Zagar', 'alpha', { album: 'a' }),
      track('Ambient', 'x', { album: 'zz' }),
    ];
    assert.deepEqual(orderTracks(pool2, 'sequential').map((t) => t.title), ['x', 'alpha', 'delta'],
      'a < z, and ž/Z fold to the same artist group -- album then orders inside it');
  });

  test('random preserves the multiset (it is an order, not a filter)', () => {
    const out = orderTracks(pool, 'random');
    assert.equal(out.length, 3);
    assert.deepEqual([...out].map((t) => t.title).sort(), ['alpha', 'beta', 'gamma']);
  });

  test('popular: same multiset, weighted-shuffle order', () => {
    const realRandom = Math.random;
    try {
      Math.random = () => 0.5;
      const out = orderTracks(pool, 'popular');
      assert.equal(out.length, 3);
      assert.deepEqual(out.map((t) => t.title).sort(), ['alpha', 'beta', 'gamma']);
    } finally {
      Math.random = realRandom;
    }
  });
});

// ---------------------------------------------------------------------------
// C. expansion (real WAV library in genre folders)
// ---------------------------------------------------------------------------

describe('expandSmartBlock (end-to-end, real WAV library)', () => {
  const musicDir = path.join(liveConfig.dataDir, 'music-blocks');
  const jazzDir = path.join(musicDir, 'jazz');
  const ambientDir = path.join(musicDir, 'ambient');
  // 2-second WAVs; localLibrary derives genre from the immediate subdirectory
  // name and artist/title from "Artist - Title" filenames.
  for (let i = 1; i <= 4; i++) {
    writeWav(path.join(jazzDir, `Jazz Artist - Jazz Song ${i}.wav`), 2);
    writeWav(path.join(ambientDir, `Ambient Artist - Ambient Song ${i}.wav`), 2);
  }
  // one track that the neverPlay keyword ban will catch
  writeWav(path.join(jazzDir, 'Jazz Artist - Christmas Song.wav'), 2);
  if (!liveConfig.autoRadio.music.localDirs.includes(musicDir)) {
    liveConfig.autoRadio.music.localDirs = [musicDir];
    fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(liveConfig, null, 2));
  }
  // Station-wide neverPlay ban: the keyword rule must apply to blocks exactly
  // as it does to show queues (same isBannedTrack call).
  fs.writeFileSync(
    path.join(liveConfig.dataDir, 'station.json'),
    JSON.stringify({ station: { name: 'Test Station', neverPlay: { keywords: ['christmas'], artists: [] } } })
  );

  test('count limit + sequential order: exact take, folded order, bans applied', async () => {
    const result = await expandSmartBlock(findSmartBlock('petkov večer jazz'));
    assert.equal(result.tracks.length, 3, 'count limit fills exactly');
    assert.equal(result.poolSize, 4, '5 jazz fixtures minus the banned christmas track');
    assert.deepEqual(result.tracks.map((t) => t.title), ['Jazz Song 1', 'Jazz Song 2', 'Jazz Song 3'],
      'sequential order = alphabetical by title inside one artist');
    assert.equal(result.shortfall, null);
    assert.equal(result.targetMs, null, 'a count-limited block has no duration target');
    assert.equal(result.block.name, 'petkov večer jazz');
  });

  test('minute limit, no-overflow default: the crossing track is left out and a limitNote explains it', async () => {
    // 0.05 min = 3 s: one 2 s track fits, the next would cross to 4 s.
    const result = await expandSmartBlock(findSmartBlock('nočni ambient'));
    assert.equal(result.tracks.length, 1);
    assert.equal(result.estimatedMusicMs <= 3000, true, 'under the limit');
    assert.match(result.limitNote, /next track would have crossed/, 'LibreTime default documented, not silent');
    assert.equal(result.shortfall, null, 'by-design behavior is a note, not a failure');
  });

  test('overflow: true adds the crossing track, then stops', async () => {
    const result = await expandSmartBlock(findSmartBlock('nočni ambient preliv'));
    assert.equal(result.tracks.length, 2, 'the crossing track IS added');
    assert.equal(result.estimatedMusicMs > 3000, true, 'overflowed past the 3 s limit');
    assert.equal(result.limitNote, undefined);
    assert.equal(result.shortfall, null);
  });

  test('minute limit the pool cannot reach -> honest shortfall (not a silent short block)', async () => {
    const result = await expandSmartBlock(findSmartBlock('dolgi minute'));
    assert.equal(result.tracks.length, 4, 'everything eligible is taken');
    assert.equal(result.shortfall?.kind, 'minutes');
    assert.match(result.shortfall.note, /Pool exhausted/);
  });

  test('recently-played exclusion applies (same ledger the shows use)', async () => {
    const first = await expandSmartBlock(findSmartBlock('petkov večer jazz'));
    fs.mkdirSync(path.dirname(liveConfig.paths.historyFile), { recursive: true });
    const played = first.tracks.map((t) => ({ ratingKey: t.ratingKey, playedAt: new Date().toISOString() }));
    fs.writeFileSync(liveConfig.paths.historyFile, played.map((e) => JSON.stringify(e)).join('\n') + '\n');
    try {
      const second = await expandSmartBlock(findSmartBlock('petkov večer jazz'));
      const seen = new Set(played.map((e) => e.ratingKey));
      for (const t of second.tracks) {
        assert.equal(seen.has(String(t.ratingKey)), false, 'no recently-played track comes back');
      }
      assert.equal(second.poolSize, 4 - 3, 'pool reflects the exclusion');
      assert.equal(second.shortfall?.kind, 'count', 'cannot fill 3 of 1 remaining -- reported, not hidden');
    } finally {
      fs.rmSync(liveConfig.paths.historyFile, { force: true });
    }
  });

  test('excludeRatingKeys removes tracks (cross-block no-repeat plumbing)', async () => {
    const first = await expandSmartBlock(findSmartBlock('petkov večer jazz'));
    const exclude = new Set(first.tracks.map((t) => String(t.ratingKey)));
    const second = await expandSmartBlock(findSmartBlock('petkov večer jazz'), { excludeRatingKeys: exclude });
    assert.equal(second.tracks.length, 1, '4 eligible minus the 3 excluded');
    for (const t of second.tracks) assert.equal(exclude.has(String(t.ratingKey)), false);
  });

  test('a library query matching nothing is a specific error, not an empty block', async () => {
    await assert.rejects(
      () => expandSmartBlock({ name: 'prazno', criteria: { genre: 'polka' }, limit: { count: 2 } }),
      /No tracks in the local library match/
    );
  });

  test('criteria duration cutoffs apply on top of the station defaults', async () => {
    const result = await expandSmartBlock({
      name: 'kratki',
      criteria: { genre: 'jazz', maxTrackDurationSeconds: 1 },
      limit: { count: 4 },
    });
    assert.equal(result.tracks.length, 0, 'all fixtures are ~2 s -- everything is cut');
    assert.equal(result.shortfall?.kind, 'count');
  });
});

// ---------------------------------------------------------------------------
// D. seams: brief parsing + produce.js / API wiring
// ---------------------------------------------------------------------------

describe('briefQuery seam', () => {
  test('"- smart block: <name>" resolves to the block and bypasses prose criteria', () => {
    const { query } = produceTrackQueryDeterministic({
      trackSelectionText: '## Track Selection\n- smart block: Petkov Večer Jazz\nNo genre that is soundtracks.',
      genreTags: ['Pop/Rock'],
    });
    assert.equal(query.smartBlock, 'Petkov Večer Jazz');
    assert.equal(query.genre, null, 'prose genre matching is bypassed for a block reference');
  });

  test('slovenian "pametni blok:" alias works', () => {
    const { query } = produceTrackQueryDeterministic({
      trackSelectionText: '- pametni blok: nocni-ambient',
      genreTags: [],
    });
    assert.equal(query.smartBlock, 'nocni-ambient');
  });

  test('a selection-less brief error mentions the smart block option', () => {
    assert.throws(
      () => produceTrackQueryDeterministic({ trackSelectionText: 'something atmospheric', genreTags: [] }),
      /smart block/
    );
  });
});

describe('wiring (structural)', () => {
  test('produce.js expands the block instead of the generic queue', () => {
    const produce = fs.readFileSync(path.join(repoRoot(), 'src', 'auto', 'produce.js'), 'utf8');
    assert.match(produce, /import \{ smartBlocksConfig, findSmartBlock, expandSmartBlock \} from '\.\.\/producer\/smartBlocks\.js'/);
    assert.match(produce, /if \(query\.smartBlock\)/);
    assert.match(produce, /expandSmartBlock\(block, \{ repeatWindowDays: brief\.repeatWindowDays \}\)/);
  });

  test('studio API exposes the block list and live preview', () => {
    const api = fs.readFileSync(path.join(repoRoot(), 'src', 'server', 'studioLibraryApi.js'), 'utf8');
    assert.match(api, /fastify\.get\('\/api\/smart-blocks'/);
    assert.match(api, /fastify\.get\('\/api\/smart-blocks\/:name\/preview'/);
  });

  test('queue.js exports neverPlayBans (single source of the ban-merge rule)', () => {
    const queue = fs.readFileSync(path.join(repoRoot(), 'src', 'producer', 'trackSelection', 'queue.js'), 'utf8');
    assert.match(queue, /export function neverPlayBans\(/);
  });
});
