// Listener sampling ledger -- the missing long-term memory of the stream
// audience. Icecast knows how many connections are open RIGHT NOW, but until
// now nothing kept that number over time, so "when do people actually tune
// in?", "did the schedule change move the audience?" and "do listeners walk
// out during a specific track?" were unanswerable. A scheduler job samples
// Icecast's public status page once per config.analytics.sampleIntervalMinutes
// (default 1min) and appends one JSONL line here; the studio Analytics view
// (server/studioAnalyticsApi.js + public/studio/js/analytics.js) charts the
// series and joins it with the real aired history for per-track impact
// (analytics/listenerImpact.js).
//
// Honesty rules (same standard as diagnosticsUtil.js): a failed sample is
// STORED as { listeners: null, error } -- a gap is data. Gaps are never
// silently skipped, never interpolated, and any count the UI shows came from
// an actual Icecast answer. Storage follows fillerRotation.js's append-only
// JSONL pattern: short appendFileSync lines are effectively atomic on local
// filesystems, concurrent writers can only interleave whole lines, and a
// torn line is skipped on read rather than crashing the reader.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { toLocalISOString } from '../lib/time.js';
import { getListenerCount } from '../icecast/listeners.js';

const log = createLogger('station');

export function samplesLedgerPath() {
  return config.paths.listenerSamplesFile;
}

// 43200 lines = 30 days at one sample per minute (~2.5 MB). The scheduler
// prunes opportunistically on every tick, so steady-state cost is a rare
// rewrite of the file, never an unbounded ledger.
export function maxLedgerEntries() {
  return config.analytics?.maxEntries ?? 43200;
}

// Records one sample right now. `getCount` is injectable so tests (and any
// future alternative source) can substitute the poller; production default
// is icecast/listeners.js's getListenerCount() against status-json.xsl.
// showId is joined from now_playing_track.json (written at each track start
// by scrobbleTrack.js) so per-show audience questions stay answerable later
// without changing the on-disk schema; it is null during spoken segments and
// before the first track since boot -- a truthful "unknown", not a guess.
export async function sampleOnce(getCount = getListenerCount) {
  const ts = toLocalISOString();
  let entry;
  try {
    const raw = await getCount();
    const listeners = Number(raw);
    if (!Number.isFinite(listeners)) {
      entry = { ts, listeners: null, error: 'Icecast returned a non-numeric listener count' };
    } else {
      entry = { ts, listeners };
    }
  } catch (err) {
    entry = { ts, listeners: null, error: err?.message ?? String(err) };
  }
  try {
    const np = JSON.parse(fs.readFileSync(config.paths.nowPlayingTrackPath, 'utf8'));
    entry.showId = np.showId ?? null;
  } catch {
    entry.showId = null;
  }
  const file = samplesLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

// Reads the ledger, dropping torn/unparseable lines and lines without a
// usable timestamp. Chronological order is not guaranteed after a prune
// rewrite races an append, so callers that need ordering sort here.
export function readSamples() {
  let lines = [];
  try {
    lines = fs.readFileSync(samplesLedgerPath(), 'utf8').split('\n');
  } catch {
    return []; // no ledger yet -- the truthful empty state
  }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn line -- skip, don't fail
    }
    const at = new Date(entry.ts).getTime();
    if (!Number.isFinite(at)) continue;
    out.push(entry);
  }
  return out.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// Caps the ledger at the newest maxEntries lines -- same shape and rationale
// as fillerRotation.js's pruneLedger.
export function pruneSamples(maxEntries = maxLedgerEntries()) {
  const file = samplesLedgerPath();
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return;
  }
  if (lines.length <= maxEntries) return;
  const kept = lines.slice(-maxEntries);
  try {
    fs.writeFileSync(file, kept.join('\n') + '\n');
    log(`listenerSamples: pruned ledger to ${kept.length} entries`);
  } catch (err) {
    log(`listenerSamples: prune failed (non-fatal): ${err.message}`);
  }
}

// Scheduler-facing tick (scheduler.js 'listener_sample' job): one sample
// plus opportunistic pruning. Never throws outwards -- every() already
// catches, but a clean return keeps the job log readable.
export async function sampleNow() {
  const entry = await sampleOnce();
  pruneSamples();
  if (entry.listeners === null) log(`listener sample: gap recorded (${entry.error})`);
  return entry;
}
