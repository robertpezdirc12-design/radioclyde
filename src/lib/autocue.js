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
//   - Tail pass (ending-aware crossfade sizing, the SUB/WAVE mechanism from
//     worklog 4-a item 4): after a successful loudness pass the scan runs ONE
//     more ffmpeg pass over the last 20 s (-sseof -20, ebur128 momentary
//     series) and stores tail:{windMs,fade,lufsDrop} on the same entry. At
//     read time crossfadeAnnotate() derives liq_cross_duration ("8.0".."12.0")
//     for measured FADE-OUT tails only; director/playlist.js stamps it on the
//     m3u and radio.liq's cross_stamps turns it into explicit start/end
//     override keys. Backwards compatibility: entries WITHOUT a tail (written
//     before this pass existed) are never stamped, and the mtimeMs+size skip
//     means old entries never gain a tail without re-analysis -- full
//     re-stamp = delete dataDir/autocue_index.json and let the scan rebuild.
//   - Head pass (Val 28 B1, the mirror of the tail pass): ONE more ffmpeg pass
//     over the FIRST 20 s (-t 20 input-side) and stores head:{riseMs,gradual,
//     lufsRise}. At read time fadeInAnnotate() derives liq_fade_in for the
//     measured regimes only: a GRADUAL intro (a >= 3 s build starting >= 16.5
//     dB under the body) gets 2.5-4.0 s -- the measured rise IS the canvas,
//     clamped to the band; a COLD attack (level arrives within 500 ms)
//     gets a short 0.5 s soften; everything in between (and every unmeasured
//     or malformed entry) stays null so director/playlist.js's 2 s default
//     stands -- the same pass-through contract as liq_amplify. The point is
//     not the absolute values but the VARIETY: one fixed 2 s fade on every
//     track regardless of how the track actually begins is the most robotic
//     seam a station can ship.
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
// The optional {runner} is a TEST SEAM (canned-stderr injection) shared with
// analyzeTail/analyzeMissing; production callers pass nothing and get the
// real execFileAsync with byte-identical discipline (timeout/maxBuffer/
// windowsHide).
export async function analyzeTrack(filePath, { runner } = {}) {
  const run = runner ?? execFileAsync;
  const { stderr } = await run(
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

// --- Tail pass (ending-aware crossfade sizing) -----------------------------
//
// SUB/WAVE provenance (worklog 4-a item 4, verdict STEALABLE-WITH-FFMPEG-ONLY):
// their analyze_worker computes, over the last 20 s of the file, loud = p95 of
// RMS frames, a wind-down start at the last frame >= 0.6*loud, and
// ending='fade' iff the mean RMS of the last 1.5 s < 0.15*loud AND the
// wind-down spans >= 3 s. Here the same thresholds are applied to the ebur128
// MOMENTARY series (LUFS), using the dB equivalents of the amplitude gates:
// 0.6 amplitude = 4.44 dB below the body, 0.15 amplitude = 16.5 dB below.
const TAIL_WINDOW_SECONDS = 20; // -sseof window; shorter files decode whole
const TAIL_LOUD_PERCENTILE = 0.95; // p95 of the momentary series
const WIND_DOWN_DROP_DB = 4.44; // 0.6 amplitude ~= -4.44 dB (thr_hi = 0.6*loud)
const WIND_MIN_MS = 3000; // wind_span >= 3.0 s
const TAIL_MEAN_SECONDS = 1.5; // end_level = mean of the last 1.5 s
const FADE_DROP_DB = 16.5; // 0.15 amplitude ~= -16.5 dB (end_level < 0.15*loud)
const MOMENTARY_FLOOR_LUFS = -60.0; // digital silence prints ~= -159/-163 on 7.x
// Read-time sizing (SUB/WAVE mix.ts endingCrossSecondsFor): a shallow
// tail-drop (3 dB) trims toward the 8 s floor, a deep drop (12 dB) keeps the
// full wind-down ride.
const FADE_DROP_SHALLOW_DB = 3;
const FADE_DROP_DEEP_DB = 12;
const CROSS_SECONDS_MIN = 8;
const CROSS_SECONDS_MAX = 12;

// Per-line parser for the ebur128 momentary series. The 7.x frame line is
//   [Parsed_ebur128_0 @ 0x...] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7 ...
// (no colon after t; no space before M when the value is wide -- ffmpeg pads
// to a fixed width, so both "M:-120.7" and "M: -41.7" occur); older builds
// printed "t: 0.0999773: ... M: -18.5". The regex anchors on the only
// invariant -- a t: timestamp and the momentary M: on the SAME line -- which
// banner and Summary lines never carry (measured on ffmpeg 7.1.5). -inf and
// everything below -60 LUFS floors to the silence floor; result sorted by t.
export function parseEbur128Momentary(stderr) {
  const points = [];
  for (const line of String(stderr).split('\n')) {
    const m = line.match(/t:\s*(\d+(?:\.\d+)?).*?M:\s*(-?\d+(?:\.\d+)?|-inf)/);
    if (!m) continue;
    const t = Number.parseFloat(m[1]);
    if (!Number.isFinite(t)) continue;
    let v = m[2] === '-inf' ? MOMENTARY_FLOOR_LUFS : Number.parseFloat(m[2]);
    if (!Number.isFinite(v) || v < MOMENTARY_FLOOR_LUFS) v = MOMENTARY_FLOOR_LUFS;
    points.push({ t, m: v });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

// Linear-interpolation percentile (the same convention SUB/WAVE's numpy
// percentile uses): idx = (n-1)*p between the two neighbouring sorted values.
function percentileLin(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// {windMs, fade, lufsDrop} from a (sorted) momentary series:
//  - endIdx = last strictly-above-floor index: trailing digital silence is
//    padding around the ending, not the ending itself (SUB/WAVE measure the
//    silence-trimmed end).
//  - windMs = t[endIdx] - t[k], k = last index <= endIdx with M >= p95-4.44.
//  - tailMean = mean of the final 1.5 s OF THE TRIMMED ENDING (indices
//    <= endIdx only) -- an unbounded mean would let digital padding inflate
//    lufsDrop (pinned by the paddedColdSeries test: drop must stay 0).
//  - fade iff windMs >= 3000 AND tailMean < p95-16.5.
//  - lufsDrop = max(0, p95 - tailMean), rounded to 0.1 dB.
//  - all-silent window -> zeros; empty series throws (callers count it).
export function tailMetrics(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('tailMetrics: empty momentary series');
  }
  const p95 = percentileLin(points.map((p) => p.m), TAIL_LOUD_PERCENTILE);
  let endIdx = -1;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].m > MOMENTARY_FLOOR_LUFS) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { windMs: 0, fade: false, lufsDrop: 0 };
  const windThreshold = p95 - WIND_DOWN_DROP_DB;
  let k = -1;
  for (let i = endIdx; i >= 0; i -= 1) {
    if (points[i].m >= windThreshold) {
      k = i;
      break;
    }
  }
  const windMs = k === -1 ? 0 : Math.round((points[endIdx].t - points[k].t) * 1000);
  const cutoff = points[endIdx].t - TAIL_MEAN_SECONDS;
  let sum = 0;
  let n = 0;
  for (let i = endIdx; i >= 0 && points[i].t >= cutoff; i -= 1) {
    sum += points[i].m;
    n += 1;
  }
  const tailMean = sum / n; // n >= 1: endIdx's own point always qualifies
  const fade = windMs >= WIND_MIN_MS && tailMean < p95 - FADE_DROP_DB;
  const lufsDrop = Math.round(Math.max(0, p95 - tailMean) * 10) / 10;
  return { windMs, fade, lufsDrop };
}

// One tail pass: decode the last TAIL_WINDOW_SECONDS seconds and collect the
// ebur128 momentary series. DEVIATION from the brief (measured on this box,
// ffmpeg 7.1.5): the brief's exact `ebur128=metadata=1` prints ZERO frame
// lines on ffmpeg >= 6.1 (0 vs 200 with explicit framelog=info -- metadata
// mode disables frame logging), so the filter carries framelog=info, which
// is a no-op default on older builds. Same execFileAsync error contract as
// analyzeTrack: any ffmpeg failure rejects and the caller counts it.
export async function analyzeTail(filePath, { runner } = {}) {
  const run = runner ?? execFileAsync;
  const { stderr } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-sseof',
      `-${TAIL_WINDOW_SECONDS}`,
      '-i',
      filePath,
      '-filter_complex',
      'ebur128=metadata=1:framelog=info',
      '-f',
      'null',
      '-',
    ],
    { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER, windowsHide: true }
  );
  const points = parseEbur128Momentary(stderr);
  if (points.length === 0) {
    throw new Error('ebur128 tail pass produced no momentary frames');
  }
  return tailMetrics(points);
}

// --- Head pass (Val 28 B1, entry-aware fade-in sizing) ---------------------
//
// The tail pass measures how a track ENDS so the crossfade can ride its
// wind-down; this one measures how it BEGINS so the fade.in wrapper (which
// radio.liq applies on BOTH 2.2.4 and 2.4.6 -- it is one of the few ungated
// operators) can stop using one fixed 2 s for everything. Same measurement
// machinery (ebur128 momentary series over a 20 s window), same thresholds
// mirrored onto the first 20 s instead of the last:
//   - startIdx = first strictly-above-floor index: leading digital silence is
//     padding around the entry, not the entry itself.
//   - riseMs = time from startIdx to the first index >= p95-4.44 (the level
//     ARRIVING -- the mirror of the wind-down).
//   - startMean = mean of the first 1.5 s OF THE TRIMMED START (indices
//     >= startIdx only), so digital padding cannot deflate it.
//   - gradual iff riseMs >= 3000 AND startMean < p95-16.5 (a real quiet build
//     into the body). Cold iff riseMs <= 500 (the level is simply THERE).
const HEAD_WINDOW_SECONDS = 20; // -t input-side window; shorter files decode whole
const HEAD_MEAN_SECONDS = 1.5; // mirror of TAIL_MEAN_SECONDS
const COLD_RISE_MAX_MS = 500; // level arrives this fast -> hard attack
const FADE_SECONDS_GRADUAL_MIN = 2.5;
const FADE_SECONDS_GRADUAL_MAX = 4.0;

// {riseMs, gradual, lufsRise} from a (sorted) momentary series. All-silent
// window -> zeros; empty series throws (callers count it) -- tailMetrics'
// contracts, mirrored.
export function headMetrics(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('headMetrics: empty momentary series');
  }
  const p95 = percentileLin(points.map((p) => p.m), TAIL_LOUD_PERCENTILE);
  let startIdx = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].m > MOMENTARY_FLOOR_LUFS) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return { riseMs: 0, gradual: false, lufsRise: 0 };
  const riseThreshold = p95 - WIND_DOWN_DROP_DB;
  let j = -1;
  for (let i = startIdx; i < points.length; i += 1) {
    if (points[i].m >= riseThreshold) {
      j = i;
      break;
    }
  }
  const riseMs = j === -1 ? 0 : Math.round((points[j].t - points[startIdx].t) * 1000);
  const cutoff = points[startIdx].t + HEAD_MEAN_SECONDS;
  let sum = 0;
  let n = 0;
  for (let i = startIdx; i < points.length && points[i].t <= cutoff; i += 1) {
    sum += points[i].m;
    n += 1;
  }
  const startMean = sum / n; // n >= 1: startIdx's own point always qualifies
  const gradual = riseMs >= WIND_MIN_MS && startMean < p95 - FADE_DROP_DB;
  const lufsRise = Math.round(Math.max(0, p95 - startMean) * 10) / 10;
  return { riseMs, gradual, lufsRise };
}

// The liq_fade_in seconds for a stored head, or null when the head is
// unmeasured, malformed, or in the moderate middle band (the default 2 s in
// director/playlist.js stands -- the same derive-at-read, pass-through
// contract as crossSecondsFor):
//   gradual: riseSec = clamp(riseMs/1000, 2.5, 4.0) -- the measured rise IS
//            the canvas; t = clamp01((lufsRise-3)/9), shallow rise trims
//            toward 2.5 s, deep rise keeps the full ride
//   cold:    a short fixed soften -- 0.5 s (linear, the fade.in default type)
//            on a hard attack; a deliberate cold-open riff keeps its snap
//   middle:  null -> the playlist default
export function fadeInSecondsFor(head) {
  if (!head || typeof head !== 'object') return null;
  if (!Number.isFinite(head.riseMs) || !Number.isFinite(head.lufsRise)) return null;
  if (head.gradual) {
    const riseSec = Math.min(FADE_SECONDS_GRADUAL_MAX, Math.max(FADE_SECONDS_GRADUAL_MIN, head.riseMs / 1000));
    const t = Math.min(
      1,
      Math.max(0, (head.lufsRise - FADE_DROP_SHALLOW_DB) / (FADE_DROP_DEEP_DB - FADE_DROP_SHALLOW_DB))
    );
    const secs = FADE_SECONDS_GRADUAL_MIN + (riseSec - FADE_SECONDS_GRADUAL_MIN) * t;
    return (Math.round(secs * 10) / 10).toFixed(1);
  }
  if (head.riseMs <= COLD_RISE_MAX_MS) return '0.5';
  return null;
}

// One head pass: decode the FIRST HEAD_WINDOW_SECONDS seconds (input-side
// -t stops the read early, so a 10-minute track costs the same as a 30 s
// one) and collect the same ebur128 momentary series. Same error contract as
// analyzeTail/analyzeTrack.
export async function analyzeHead(filePath, { runner } = {}) {
  const run = runner ?? execFileAsync;
  const { stderr } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-t',
      `${HEAD_WINDOW_SECONDS}`,
      '-i',
      filePath,
      '-filter_complex',
      'ebur128=metadata=1:framelog=info',
      '-f',
      'null',
      '-',
    ],
    { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER, windowsHide: true }
  );
  const points = parseEbur128Momentary(stderr);
  if (points.length === 0) {
    throw new Error('ebur128 head pass produced no momentary frames');
  }
  return headMetrics(points);
}

// The crossfade duration stamp for a stored tail, or null when the tail is
// not a fade (cold ending, all-silent window) or malformed. SUB/WAVE's
// endingCrossSecondsFor reduced to the ffmpeg-measurable inputs:
//   windSec = clamp(windMs/1000, 8, 12)  -- the measured wind-down IS the
//                                         canvas, clamped to the blend band
//   t = clamp01((lufsDrop - 3) / (12 - 3)) -- shallow drop trims toward 8 s,
//                                         deep drop keeps the full ride
//   secs = 8 + (windSec - 8) * t, 0.1-quantized
// HONEST OBSERVATION: with lufsDrop = tail-p95 - tailMean, fade=true implies
// drop > 16.5 dB, so t saturates at 1 and the stamp === windSec for every
// honestly-measured entry; the interpolation branch is unreachable from real
// measurements (kept for SUB/WAVE table fidelity and hand-edited index
// robustness -- the pure-math tests exercise it).
export function crossSecondsFor(tail) {
  if (!tail || typeof tail !== 'object') return null;
  if (!Number.isFinite(tail.windMs) || !Number.isFinite(tail.lufsDrop)) return null;
  if (!tail.fade) return null;
  const windSec = Math.min(CROSS_SECONDS_MAX, Math.max(CROSS_SECONDS_MIN, tail.windMs / 1000));
  const t = Math.min(
    1,
    Math.max(0, (tail.lufsDrop - FADE_DROP_SHALLOW_DB) / (FADE_DROP_DEEP_DB - FADE_DROP_SHALLOW_DB))
  );
  const secs = CROSS_SECONDS_MIN + (windSec - CROSS_SECONDS_MIN) * t;
  return (Math.round(secs * 10) / 10).toFixed(1);
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

// The liq_cross_duration annotate value for a track path, or null when the
// entry has no fade-out tail: cold endings, a failed tail pass, or an entry
// written before the tail pass existed (derive-at-read, same as amplify).
// radio.liq's cross_stamps consumes the stamp; unstamped tracks keep the
// dj_transition_buffer default.
export function crossfadeAnnotate(filePath) {
  const entry = autocueFor(filePath);
  if (!entry) return null;
  return crossSecondsFor(entry.tail);
}

// The liq_fade_in annotate value for a track path, or null when the entry
// has no head measurement (or sits in the moderate middle band) -- the
// playlist writer then stamps its own default. radio.liq's ungated fade.in
// wrappers read the per-entry override on BOTH 2.2.4 and 2.4.6, so this is
// the one seam of the Val 28 sonic work that is audible on today's box.
export function fadeInAnnotate(filePath) {
  const entry = autocueFor(filePath);
  if (!entry) return null;
  return fadeInSecondsFor(entry.head);
}

// --- Transition-effect rules (Val 28 D1) ------------------------------------
//
// The dormant DJ-effect layer (dj_transitions.liq: sweep / washout /
// dissolve) used to arm only by hand (stampTransitionFlags.js CLI). The
// playlist writers now stamp it AUTOMATICALLY, deterministically, from the
// SAME measurements the fade-in/crossfade sizing already uses -- nothing
// about the SEAM is a judgment call:
//
//   washout  on the ENDING track: an EPIC outro -- a measured fade tail
//            (tail.fade) that is both long (windMs >= 6 s) and deep
//            (lufsDrop >= 10 dB). The exp-fade + slapback echo is exactly
//            the gesture a big wind-down ending wants; a plain linear
//            crossfade already rides the shorter/shallower ones (via
//            crossSecondsFor).
//   dissolve on the INCOMING track: a deep ambient BUILD-IN -- a gradual
//            head (head.gradual) that is both long (riseMs >= 3.5 s) and
//            deep (lufsRise >= 10 dB). Four-comb early reflections under a
//            long quiet intro turn the build into a moment.
//   sweep    on the INCOMING track: a LOUD cold start -- the level arrives
//            as an attack (riseMs <= 500 ms) AND the track masters hot
//            (lufs >= -9.5). The filter-choke + surfacing dramatizes the
//            slam-in; a merely cold start of a normally-mastered track
//            stays plain (the 0.5 s fade-in soften is enough for it).
//
// Sparseness is the point: every threshold asks "is this seam a MOMENT?",
// and the honest default answer is no -- the plain linear crossfade (3.5 s,
// 8-12 s on measured tails) stays the workhorse seam. Unmeasured entries
// never get a flag (the same pass-through contract as liq_amplify).
const WASHOUT_MIN_WIND_MS = 6000;
const WASHOUT_MIN_DROP_DB = 10;
const DISSOLVE_MIN_RISE_MS = 3500;
const DISSOLVE_MIN_RISE_DB = 10;
const SWEEP_MIN_LUFS = -9.5; // hot master: a slam-in, not just a cold start

// Pure: the three boolean effect decisions from a track's own measurements
// (tail for the ending gesture, head+body level for the incoming ones).
// Malformed/partial entries contribute false -- never a guessed flag.
export function transitionFlagsFor(head, tail, lufs) {
  const flags = { washout: false, dissolve: false, sweep: false };
  if (tail && typeof tail === 'object' && tail.fade === true
    && Number.isFinite(tail.windMs) && Number.isFinite(tail.lufsDrop)
    && tail.windMs >= WASHOUT_MIN_WIND_MS && tail.lufsDrop >= WASHOUT_MIN_DROP_DB) {
    flags.washout = true;
  }
  if (head && typeof head === 'object' && head.gradual === true
    && Number.isFinite(head.riseMs) && Number.isFinite(head.lufsRise)
    && head.riseMs >= DISSOLVE_MIN_RISE_MS && head.lufsRise >= DISSOLVE_MIN_RISE_DB) {
    flags.dissolve = true;
  }
  if (head && typeof head === 'object'
    && Number.isFinite(head.riseMs) && head.riseMs <= COLD_RISE_MAX_MS
    && Number.isFinite(lufs) && lufs >= SWEEP_MIN_LUFS) {
    flags.sweep = true;
  }
  return flags;
}

// The transition-effect annotate fields for a track path (empty array when
// the entry is unmeasured or earns no effect). director/playlist.js's
// annotateTrackEntry -- the ONE writer both filler.m3u and show
// playlist.m3u go through -- appends these to every music entry, so the
// dormant 2.4.6 layer is armed by construction the moment the box upgrades.
export function transitionFlagAnnotate(filePath) {
  const entry = autocueFor(filePath);
  if (!entry) return [];
  const { washout, dissolve, sweep } = transitionFlagsFor(entry.head, entry.tail, entry.lufs);
  const fields = [];
  if (washout) fields.push('liq_washout="1"');
  if (dissolve) fields.push('liq_dissolve="1"');
  if (sweep) fields.push('liq_sweep="1"');
  return fields;
}

// Analyze every path whose (mtimeMs, size) differs from the index -- i.e.
// new files plus files replaced on disk -- up to maxAnalyzePerRun, so the
// first-ever sweep is spread across job ticks instead of blocking one tick
// for an hour on a big library. Writes the index atomically (tmp + rename,
// the same durability pattern as the other Node-written side files).
export async function analyzeMissing(paths, { maxAnalyzePerRun, settings, runner } = {}) {
  const max = Math.max(1, maxAnalyzePerRun ?? 100);
  const tracks = readIndexFresh();
  const next = { ...tracks };
  let analyzed = 0;
  let failed = 0;
  let skipped = 0;
  let clampedCount = 0;
  let tailFailed = 0;
  let headFailed = 0;
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
      const { lufs, peak } = await analyzeTrack(filePath, { runner });
      const { clamped } = amplifyDbFor(lufs, settings);
      if (clamped) clampedCount += 1;
      const entry = { mtimeMs: stat.mtimeMs, size: stat.size, lufs, peak, analyzedAt };
      // Tail pass runs AFTER a successful loudness pass: on tail failure the
      // entry is stored WITHOUT tail and tailFailed counts it -- loudness
      // never regresses because of the ending measurement (the next scan of
      // an unchanged file skips it, so the tail stays missing until the file
      // changes or the index is deleted).
      try {
        entry.tail = await analyzeTail(filePath, { runner });
      } catch (err) {
        tailFailed += 1;
        log(`Autocue: tail pass FAILED for ${filePath}: ${err.message}`);
      }
      // Head pass (Val 28 B1) rides the same non-fatal discipline: an entry
      // without a head simply keeps the playlist's default fade-in.
      try {
        entry.head = await analyzeHead(filePath, { runner });
      } catch (err) {
        headFailed += 1;
        log(`Autocue: head pass FAILED for ${filePath}: ${err.message}`);
      }
      next[filePath] = entry;
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
  return { analyzed, skipped, failed, total: paths.length, clamped: clampedCount, tailFailed, headFailed };
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
        const out = { file, lufs, peak, amplify, clamped, ...loudnessSettings() };
        // Tail/head passes are non-fatal here too (same contract as the
        // scan): a failed measurement surfaces as tailError/headError, never
        // as a lost loudness result.
        try {
          out.tail = await analyzeTail(file);
        } catch (err) {
          out.tailError = err.message;
        }
        try {
          out.head = await analyzeHead(file);
        } catch (err) {
          out.headError = err.message;
        }
        console.log(JSON.stringify(out));
      } catch (err) {
        console.log(JSON.stringify({ file, error: err.message }));
        process.exitCode = 1;
      }
    }
  })();
}
