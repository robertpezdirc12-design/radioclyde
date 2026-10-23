// Filler rotation ledger -- the missing memory between filler.m3u
// regenerations. generateFillerPlaylist deliberately never records filler
// plays into played.jsonl (show-production history), so the recently-played
// pool that curated shows draw from stays untouched -- but that also meant
// NOTHING tracked what filler had aired: every regeneration re-drew from the
// same eligible pool (audited 2026-10-24: 12/12 identical tracks in two
// consecutive generations on a 12-track library), and Liquidsoap replays the
// same static file in between. On a library that fits in one playlist pass
// (~1 hour of audio) that is exactly the reported "songs repeat every hour".
//
// This ledger is filler-only state: scrobbleTrack.js appends one entry per
// filler segment it sees air (it already fires on every segment and can tell
// filler from show segments via the loaded occurrence's playlist), and
// generateFillerPlaylist excludes entries inside config.filler.rotationWindowHours
// (default 24h). Pools that would shrink below config.filler.poolSize are
// backfilled from the OLDEST ledger entries instead, so a small library keeps
// a full, rotating pool rather than decaying to nothing.
//
// Storage is a JSONL file (one JSON object per line) -- append-only writes
// from the per-segment scrobble processes never rewrite the file, so two
// concurrent scrobbles racing can only interleave whole lines (fs.appendFileSync
// of a single short line is effectively atomic on local filesystems) and a
// torn line is skipped, not fatal, on read.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

export function fillerLedgerPath() {
  return path.join(config.dataDir, 'history', 'filler-rotation.jsonl');
}

export function rotationWindowHours() {
  return config.filler?.rotationWindowHours ?? 24;
}

export function recordFillerPlays(entries) {
  if (!entries?.length) return;
  const file = fillerLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = entries
    .filter((e) => e && e.ratingKey != null)
    .map((e) =>
      JSON.stringify({
        ratingKey: String(e.ratingKey),
        playedAt: e.playedAt ?? new Date().toISOString(),
      })
    );
  if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n');
}

// Reads the ledger, dropping entries older than the rotation window and any
// torn/unparseable lines. Returns a Map ratingKey -> most recent playedAt (ms).
export function recentFillerPlays(windowHours = rotationWindowHours(), now = Date.now()) {
  const cutoff = now - windowHours * 60 * 60 * 1000;
  const recent = new Map();
  let lines = [];
  try {
    lines = fs.readFileSync(fillerLedgerPath(), 'utf8').split('\n');
  } catch {
    return recent; // no ledger yet -- nothing to exclude
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn line (e.g. interrupted append) -- skip, don't fail
    }
    const at = new Date(entry.playedAt).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    recent.set(String(entry.ratingKey), at);
  }
  return recent;
}

// Caps the ledger so it can't grow unbounded on a station that plays filler
// 24/7 -- keep the newest maxEntries records. Called opportunistically by
// recordFillerPlays's caller paths that already hold the full recent map.
export function pruneLedger(maxEntries = 5000) {
  const file = fillerLedgerPath();
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
    log(`fillerRotation: pruned ledger to ${kept.length} entries`);
  } catch (err) {
    log(`fillerRotation: prune failed (non-fatal): ${err.message}`);
  }
}
