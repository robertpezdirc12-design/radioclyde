// Offline R128 loudness alignment for the music library -- the Node half of
// the "autocue" pattern (Moonbase59/autocue, AzuraCast #6252), reduced to
// what Liquidsoap 2.2.4-1+dev can actually act on.
//
// A full autocue writes per-file cue points, fades and a loudness correction
// as annotate metadata, which Liquidsoap operators then apply. Verified from
// the 2.2.4 and 2.2.5 source trees (docs/autocue-loudness.md has the verbatim
// evidence):
//   - amplify(override="liq_amplify", 1., s) parses " %f dB" values off the
//     frame metadata on BOTH 2.2.4 and 2.2.5 (amplify.ml is byte-identical
//     between the two), and is a pass-through (gain 1.0) when the metadata
//     is absent -- so the radio.liq wiring degrades to today's behavior for
//     any track without an index entry.
//   - NO operator on 2.2.4 reads liq_cue_in/out: the cue() operator and the
//     autocue.liq stdlib (with its metadata resolver) only exist from 2.2.5.
//     Writing cue fields here would be dead weight, so this module is
//     deliberately gain-only -- when the station ever upgrades to 2.2.5+,
//     enable_autocue_metadata() supplies cue/fade handling in one line and
//     this module needs no change.
//
// Design:
//   - scheduler/autocueScan.js (the job) walks the library and calls
//     analyzeMissing(): new/changed files get ONE ffmpeg ebur128 pass each
//     (integrated LUFS + true peak), stored in a JSON side index keyed by
//     absolute path, with mtimeMs+size so unchanged files are never
//     re-analyzed.
//   - Only lufs/peak are STORED -- amplify is DERIVED at read time from the
//     current config target (target - lufs, clamped to maxGainDb), so
//     retuning the target takes effect on the next playlist rewrite with no
//     re-analysis sweep.
//   - director/playlist.js's annotateTrackEntry() asks amplifyAnnotate()
//     for each track; tracks without an index entry annotate nothing, so a
//     station that has never run a scan behaves exactly as before this
//     feature existed (the repo's honest-degradation rule).
//   - The index is loaded through an mtime-checked cache: playlist writers
//     run in the same long-lived process as the scheduler job that refreshes
//     the file, and the cache must never serve a stale copy after the job's
//     rewrite.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

// ebur128 progress lines land on stderr every ~100ms; a 10-minute track is
// a few MB of text. maxBuffer is generous so a long analysis never dies with
// "maxBuffer exceeded" (the failure mode would look like "ffmpeg failed").
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const FFMPEG_MAX_BUFFER = 32 * 1024 * 1024;

// Integrated LUFS + true peak from ONE ffmpeg pass. Throws on any failure --
// the caller (analyzeMissing) counts failures and keeps the station running;
// annotate writers never see a half-parsed result.
export async function analyzeTrack(filePath) {
  const { stderr } = await execFileAsync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', filePath, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
    { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER, windowsHide: true }
  );
  // ebur128 prints per-window progress lines, then a final "Summary:" block;
  // only the summary holds the converged integrated value. Parse from the
  // LAST "Summary:" (defensive: a weird filename could theoretically end up
  // in a banner line that contains the word).
  const summaryAt = stderr.lastIndexOf('Summary:');
  if (summaryAt === -1) {
    throw new Error('ebur128 produced no Summary block');
  }
  const summary = stderr.slice(summaryAt);
  const lufs = matchNumber(summary, /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  if (lufs === null) {
    throw new Error('ebur128 summary missing integrated loudness (I)');
  }
  // True peak is informative (docs: it is WHY maxGainDb exists); a missing
  // value does not invalidate the analysis.
  const peak = matchNumber(summary, /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);
  return { lufs, peak };
}

function matchNumber(text, regex) {
  const m = text.match(regex);
  if (!m) return null;
  const v = Number.parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

// Pure: the dB correction that puts a track measured at `lufs` on the station
// target, with the positive side clamped. Negative corrections are never
// clamped (quieting a loud master is always safe); positive ones are, because
// there is no limiter in the chain and boosting a hot master past 0 dBFS
// would clip through the MP3 encoder. Returns one-decimal values (annotate
// values are strings like "-2.3 dB"; amplify.ml's Scanf accepts one decimal).
export function amplifyDbFor(lufs, { targetLufs, maxGainDb } = loudnessSettings()) {
  const raw = targetLufs - lufs;
  const clamped = raw > maxGainDb;
  const amplify = Math.round((clamped ? maxGainDb : raw) * 10) / 10;
  return { amplify, clamped };
}

// Config access goes through one function so the defaults live in exactly
// one place; every caller passes an explicit settings object in tests.
export function loudnessSettings() {
  return {
    targetLufs: config.autocue?.targetLufs ?? -16,
    maxGainDb: config.autocue?.maxGainDb ?? 6,
  };
}

// --- Index ----------------------------------------------------------------

// In-process cache invalidated by the file's own mtime: the scheduler job
// rewrites the index while playlist writers (same process) are calling this
// on every now_playing/filler rewrite, so every read must see the CURRENT
// file without re-reading it on every track.
let cache = { mtimeMs: null, data: null };

function readIndexFresh() {
  let stat = null;
  try {
    stat = fs.statSync(config.paths.autocueIndexPath);
  } catch {
    cache = { mtimeMs: null, data: null };
    return {};
  }
  if (cache.data && cache.mtimeMs === stat.mtimeMs) return cache.data;
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(config.paths.autocueIndexPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.tracks && typeof parsed.tracks === 'object') {
      data = parsed.tracks;
    }
  } catch (err) {
    // A corrupt index degrades to "no analysis available" (pass-through
    // annotate), never to a playlist-writer crash. The next successful scan
    // rewrite replaces the file wholesale.
    log(`Autocue index unreadable (${err.message}) -- tracks play unaligned until the next scan`);
    data = {};
  }
  cache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

export function autocueFor(filePath) {
  const tracks = readIndexFresh();
  return tracks[filePath] ?? null;
}

// The annotate field for a track path, or null when the track has no
// analysis (annotateTrackEntry then omits liq_amplify entirely -- the
// pass-through contract with radio.liq).
export function amplifyAnnotate(filePath) {
  const entry = autocueFor(filePath);
  if (!entry || !Number.isFinite(entry.lufs)) return null;
  const { amplify } = amplifyDbFor(entry.lufs);
  return `${amplify.toFixed(1)} dB`;
}

// Analyze every path whose (mtimeMs, size) differs from the index -- i.e.
// new files plus files replaced on disk -- up to maxAnalyzePerRun, so the
// first-ever sweep is spread across job ticks instead of blocking one tick
// for an hour on a big library. Writes the index atomically (tmp + rename,
// the same durability pattern as the other Node-written side files).
export async function analyzeMissing(paths, { maxAnalyzePerRun, settings } = {}) {
  const max = Math.max(1, maxAnalyzePerRun ?? 100);
  const tracks = readIndexFresh();
  const next = { ...tracks };
  let analyzed = 0;
  let failed = 0;
  let skipped = 0;
  let clampedCount = 0;
  const analyzedAt = new Date().toISOString();

  for (const filePath of paths) {
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      failed += 1;
      continue;
    }
    const entry = tracks[filePath];
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
      skipped += 1;
      continue;
    }
    if (analyzed >= max) continue; // budget exhausted: leave for the next tick

    try {
      const { lufs, peak } = await analyzeTrack(filePath);
      const { clamped } = amplifyDbFor(lufs, settings);
      if (clamped) clampedCount += 1;
      next[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, lufs, peak, analyzedAt };
      analyzed += 1;
    } catch (err) {
      failed += 1;
      log(`Autocue: analysis FAILED for ${filePath}: ${err.message}`);
    }
  }

  if (analyzed > 0) {
    writeIndex({ version: 1, tracks: next });
    log(`Autocue: analyzed ${analyzed} file(s) -> ${config.paths.autocueIndexPath}`);
  }
  return { analyzed, skipped, failed, total: paths.length, clamped: clampedCount };
}

function writeIndex(doc) {
  const outPath = config.paths.autocueIndexPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, outPath);
  cache = { mtimeMs: fs.statSync(outPath).mtimeMs, data: doc.tracks };
}

// Standalone runnable: `node src/lib/autocue.js <file> [file...]` prints one
// JSON result per file -- the documented manual-verification path.
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node src/lib/autocue.js <audiofile> [audiofile...]');
    process.exit(2);
  }
  (async () => {
    for (const file of files) {
      try {
        const { lufs, peak } = await analyzeTrack(file);
        const { amplify, clamped } = amplifyDbFor(lufs);
        console.log(JSON.stringify({ file, lufs, peak, amplify, clamped, ...loudnessSettings() }));
      } catch (err) {
        console.log(JSON.stringify({ file, error: err.message }));
        process.exitCode = 1;
      }
    }
  })();
}
