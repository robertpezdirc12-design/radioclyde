// Local-folder music library -- the no-Plex fallback source. Recursively
// scans configured directories for audio files, reads their real tags
// (title/artist/album/year/genre/duration) with music-metadata, and shapes
// each result exactly like plex/tracks.js's trackFromMetadata output so
// buildTrackQueue(), the director, and the scrobble path all consume it
// unchanged. ratingKey is a stable hash of the absolute file path, so
// history-based repeat exclusion keeps working across restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

const DEFAULT_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aiff', '.aif'];

// Deep enough for artist/album/track layouts; guarded so symlink loops or
// pathological trees can't hang the scan.
const MAX_SCAN_DEPTH = 8;

export function localMusicDirs() {
  const dirs = config.autoRadio?.music?.localDirs ?? [];
  return dirs.filter((d) => {
    if (!fs.existsSync(d)) {
      log(`NOTE: localDirs entry "${d}" does not exist -- skipping.`);
      return false;
    }
    return true;
  });
}

function audioExtensions() {
  const exts = config.autoRadio?.music?.audioExtensions;
  return (exts?.length ? exts : DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());
}

function ratingKeyForFile(absolutePath) {
  return crypto.createHash('sha1').update(absolutePath).digest('hex').slice(0, 12);
}

// Music-metadata parses only header chunks; an unreadable/corrupt file is
// skipped with a note rather than failing the whole library.
async function readTrackMeta(filePath) {
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(filePath, { duration: true });
    const common = meta.common ?? {};
    const format = meta.format ?? {};
    const title = common.title ?? guessTitleFromFilename(filePath) ?? path.basename(filePath, path.extname(filePath));
    // Track artists first (compilation-friendly, same reasoning as
    // trackFromMetadata's originalTitle-first check), album/directory artist
    // as fallback; filename "Artist - Title" as the last resort.
    const artist =
      common.artists?.[0] ?? common.artist ?? common.albumartist ?? guessArtistFromFilename(filePath) ?? 'Unknown Artist';
    // Genre: prefer audio tags, but fall back to the parent directory name
    // (e.g. music/folk/...) so libraries without tags still get a usable genre.
    // Also merge in the directory name so selection by genre works even when
    // tags are missing or say something generic like "Soundtrack".
    // A file sitting DIRECTLY in a configured library root gets no folder
    // genre: its parent directory is the library folder itself (e.g. "music"),
    // which is a storage name, not a genre (audit 2026-10-24 test finding).
    const parentDir = path.dirname(filePath);
    const dirGenre = localMusicDirs().some((d) => path.resolve(d) === path.resolve(parentDir))
      ? null
      : path.basename(parentDir);
    const tagGenres = Array.isArray(common.genre) ? common.genre : (common.genre ? [common.genre] : []);
    const genres = [...new Set([dirGenre, ...tagGenres].filter(Boolean))];
    return {
      title,
      artist,
      album: common.album ?? null,
      year: common.year ?? null,
      genre: genres,
      durationMs: Math.round((format.duration ?? 0) * 1000) || null,
    };
  } catch (err) {
    log(`NOTE: could not parse "${filePath}": ${err.message}`);
    return null;
  }
}

function guessArtistFromFilename(filePath) {
  const base = stripLeadingTrackNumber(path.basename(filePath, path.extname(filePath)));
  const m = /^\s*(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? m[1].trim() : null;
}

// "03 - Artist - Title" / "01_Artist_Title": a leading 1-3 digit track number
// plus separator belongs to neither artist nor title. Separator must be -/._
// (not a bare space) so names like "99 Luftballons - Song" keep "99" in the
// artist where it belongs.
function stripLeadingTrackNumber(base) {
  return base.replace(/^\s*\d{1,3}\s*[-._)]\s*/, '');
}

function guessTitleFromFilename(filePath) {
  const base = stripLeadingTrackNumber(path.basename(filePath, path.extname(filePath)));
  // "Artist - Title" pattern
  const m = /^\s*(.+?)\s+-\s+(.+)$/.exec(base);
  // Audit 2026-10-24: filename underscores are almost always stand-ins for
  // spaces (downloads, old rippers) -- surface them as spaces in the title.
  if (m) return m[2].replace(/_/g, ' ').trim();
  return null;
}

function* walk(dir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else if (entry.isFile()) yield full;
  }
}

async function scanLibrary() {
  const exts = new Set(audioExtensions());
  const dirs = localMusicDirs();
  const files = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (exts.has(path.extname(file).toLowerCase())) files.push(file);
    }
  }
  log(`localLibrary: scanning ${files.length} audio file(s) under ${dirs.length} director(ies)...`);
  const tracks = [];
  for (const file of files) {
    // Novelty signal for the rotation rules (scheduler/rotationRules.js):
    // "added to the library" for a local file is when it landed on disk
    // (mtime). No tags to read -- a stat per file is trivially cheap next
    // to the metadata parse below. A file that vanishes between readdir and
    // stat simply reads as "no signal"; readTrackMeta's parse will skip it.
    let addedAtMs = null;
    try {
      addedAtMs = fs.statSync(file).mtimeMs;
    } catch {
      /* raced away -- the metadata parse below reports it */
    }
    const meta = await readTrackMeta(file);
    if (!meta) continue;
    tracks.push({
      ratingKey: ratingKeyForFile(file),
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      year: meta.year,
      genre: meta.genre,
      // Fallback duration for files whose headers lie (common with some WAVs):
      // ~3.5min, same constant plex/tracks.js uses.
      durationMs: meta.durationMs ?? 210000,
      plexPath: file, // already a local path -- director uses localPath (below) instead of toLocalPath()
      localPath: file,
      ratingCount: null,
      art: null,
      addedAtMs,
    });
  }
  log(`localLibrary: ${tracks.length} track(s) with readable tags.`);
  return tracks;
}

// Scans are cheap for typical home libraries but not free -- one in-process
// cache per run keeps repeated queries (queue build + filler + previews)
// from re-reading every file. The cache is per-process by design: the
// scheduler restarts daily and the studio admin edits between restarts, so a
// fresh scan per process start matches the repo's existing
// "config/station.json read fresh" behavior closely enough for a PoC.
let cache = null;

export async function allLocalTracks() {
  if (!cache) cache = await scanLibrary();
  return cache;
}

function matchesQuery(track, { artist, genre, decade, albumKeyword, folder, artistList }) {
  const checks = [];
  if (artist) {
    checks.push((t) => fold(t.artist) === fold(artist));
  }
  if (genre) {
    checks.push((t) => (t.genre ?? []).some((g) => fold(g) === fold(genre)));
  }
  if (decade) {
    checks.push((t) => t.year != null && String(t.year - (t.year % 10)) === String(decade));
  }
  if (albumKeyword) {
    checks.push((t) => fold(t.album ?? '').includes(fold(albumKeyword)));
  }
  if (folder) {
    checks.push((t) => fold(t.plexPath).includes(fold(folder)));
  }
  if (artistList?.length) {
    const wanted = new Set(artistList.map(fold));
    checks.push((t) => wanted.has(fold(t.artist)));
  }
  if (checks.length === 0) return true;
  return checks.every((check) => check(track));
}

function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export async function fetchLocalCandidateTracks(query = {}) {
  const all = await allLocalTracks();
  const matched = all.filter((t) => matchesQuery(t, query));
  if (matched.length === 0) {
    throw new Error(
      `No tracks in the local library match the query (artist=${query.artist ?? '-'}, genre=${query.genre ?? '-'}, ` +
        `decade=${query.decade ?? '-'}, folder=${query.folder ?? '-'}). Local library has ${all.length} track(s).`
    );
  }
  return matched;
}

export async function localGenreTags() {
  const all = await allLocalTracks();
  return [...new Set(all.flatMap((t) => t.genre ?? []))].sort();
}
