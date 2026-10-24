// Studio music library + rotation view (issue #2 section B.3: browse tracks
// and metadata, inspect recently played, expose duplicate/repeat warnings).
//
// Honesty notes the issue demands:
// - Library browsing works against the LOCAL scan (localLibrary.js). When the
//   station is running in Plex mode with no local dirs configured, the view
//   says exactly that instead of showing an empty library that would imply
//   "no music exists".
// - Repeat warnings are computed from the REAL aired history
//   (history/aired.jsonl) inside the configured rotation window -- the same
//   evidence the hourly-repeat audit used.
import { config } from '../config/index.js';
import { allLocalTracks, localMusicDirs } from '../auto/localLibrary.js';
import { getRecentHistory, readAiredEntries } from './historyApi.js';
import { repeatOffenders } from './diagnosticsUtil.js';
import { smartBlocksConfig, findSmartBlock, expandSmartBlock } from '../producer/smartBlocks.js';

// A full rescan reads tags of every file; on a big library that's seconds of
// disk IO. A short cache keeps the studio view snappy without ever serving
// results older than a minute -- and the scan itself is the same one the
// scheduler already runs, so nothing new is being trusted here.
const SCAN_CACHE_TTL_MS = 60 * 1000;
let scanCache = null; // { at, dirs, total, genres, tracks }
let scanPromise = null;

async function librarySnapshot() {
  if (scanCache && Date.now() - scanCache.at < SCAN_CACHE_TTL_MS) return scanCache;
  if (scanPromise) return scanPromise; // someone is already scanning -- ride their result
  scanPromise = (async () => {
    const dirs = localMusicDirs();
    const tracks = dirs.length ? await allLocalTracks() : [];
    const genres = new Set();
    for (const t of tracks) for (const g of t.genre ?? []) genres.add(g);
    return {
      at: Date.now(),
      dirs,
      total: tracks.length,
      genres: [...genres].sort(),
      // Sorted so the studio table is stable across polls; the full list is
      // capped by the route below, sorted rows make the cap predictable.
      tracks: tracks
        .map((t) => ({
          ratingKey: t.ratingKey,
          artist: t.artist,
          title: t.title,
          album: t.album ?? '',
          genres: t.genre ?? [],
          durationSeconds: t.durationMs ? t.durationMs / 1000 : null,
        }))
        .sort((a, b) => (a.artist ?? '').localeCompare(b.artist ?? '') || (a.title ?? '').localeCompare(b.title ?? '')),
    };
  })();
  try {
    // The cache-FILLING caller must resolve to the snapshot itself: the old
    // "finally { scanPromise = null } ... return scanPromise" shape returned
    // null to exactly that caller (the finally nulled the variable before the
    // trailing return read it) -- the first GET /api/library after boot or
    // TTL expiry answered 500 with a TypeError on snap.tracks.
    scanCache = await scanPromise;
    return scanCache;
  } finally {
    scanPromise = null;
  }
}

export function registerStudioLibraryApi(fastify) {
  fastify.get('/api/library', async (request) => {
    const search = String(request.query?.search ?? '').trim().toLowerCase();
    const limit = Math.min(parseInt(request.query?.limit ?? '500', 10) || 500, 2000);
    const snap = await librarySnapshot();
    const filtered = search
      ? snap.tracks.filter(
          (t) =>
            (t.artist ?? '').toLowerCase().includes(search) ||
            (t.title ?? '').toLowerCase().includes(search) ||
            (t.album ?? '').toLowerCase().includes(search)
        )
      : snap.tracks;
    return {
      source: snap.dirs.length ? 'local' : config.plex?.token ? 'plex' : 'none',
      note:
        snap.dirs.length === 0
          ? config.plex?.token
            ? 'Postaja je v Plex načinu -- brskalnik knjižnice prikazuje le lokalne mape (autoRadio.music.localDirs), ki jih ta postaja nima nastavljenih.'
            : 'Ni nastavljenih lokalnih glasbenih map (autoRadio.music.localDirs) -- knjižnica je prazna.'
          : null,
      localDirs: snap.dirs,
      total: snap.total,
      genres: snap.genres,
      tracks: filtered.slice(0, limit),
      filteredTotal: filtered.length,
    };
  });

  fastify.get('/api/rotation', async () => {
    const windowHours = config.filler?.rotationWindowHours ?? 24;
    const aired = readAiredEntries();
    return {
      windowHours,
      poolSize: config.filler?.poolSize ?? null,
      ledger: {
        note: 'Ledger predvajanja filtra (history/filler-rotation.jsonl) je zapisan ob vsaki predvajani skladbi v filltru.',
      },
      recentlyPlayed: getRecentHistory(50),
      offenders: repeatOffenders(aired, windowHours),
    };
  });

  // Smart Blocks (P3 #14, LibreTime model): the configured blocks plus a
  // live preview -- the exact deterministic expansion a show would get if it
  // referenced the block right now (same library + history + rules), so the
  // studio can sanity-check a block before any brief points at it.
  fastify.get('/api/smart-blocks', async () => {
    return {
      blocks: smartBlocksConfig().map((b) => ({
        name: b.name,
        criteria: b.criteria ?? {},
        limit: b.limit ?? null,
        order: b.order ?? 'random',
        overflow: b.overflow === true,
      })),
    };
  });

  fastify.get('/api/smart-blocks/:name/preview', async (request) => {
    const block = findSmartBlock(request.params.name);
    if (!block) {
      const available = smartBlocksConfig().map((b) => b.name).join(', ') || '(none defined)';
      return reply404(`No smart block named "${request.params.name}" (configured: ${available}).`);
    }
    const result = await expandSmartBlock(block);
    return {
      block: result.block,
      poolSize: result.poolSize,
      musicMs: result.estimatedMusicMs,
      targetMs: result.targetMs,
      shortfall: result.shortfall,
      limitNote: result.limitNote ?? null,
      tracks: result.tracks.map((t) => ({
        ratingKey: t.ratingKey,
        artist: t.artist,
        title: t.title,
        album: t.album ?? null,
        year: t.year ?? null,
        durationSeconds: t.durationMs ? t.durationMs / 1000 : null,
      })),
    };
  });
}

function reply404(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}
