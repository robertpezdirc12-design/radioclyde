import fs from 'node:fs';
import { config } from '../config/index.js';

const HARD_CAP = 200;

function readAiredEntries() {
  try {
    return fs
      .readFileSync(config.paths.airedHistoryFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return []; // nothing aired yet since deploy
  }
}

// Raw entries (with ratingKey) for server-side analysis that must NOT go
// through getRecentHistory's listener-facing projection -- currently the
// studio diagnostics repeat-detector, which groups by ratingKey.
export { readAiredEntries };

// history/aired.jsonl is append-only chronological (oldest first), written
// by plex/scrobbleTrack.js at real track-start -- unlike producer/history.js's
// played.jsonl, which is written at production time and isn't safe to show a
// listener as "what's played".
export function getRecentHistory(limit = 50) {
  // Clamp BOTH ways: the old Math.min(limit, HARD_CAP) let limit=0 through as
  // slice(-0) === slice(0) (the WHOLE ledger) and negative limits as
  // slice(-n)-style truncation -- either bypassed the cap and dumped the
  // entire aired.jsonl per request. 0 now honestly means "no entries".
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), HARD_CAP)) : 50;
  const entries = readAiredEntries();
  const recent = safeLimit > 0 ? entries.slice(-safeLimit).reverse() : [];
  return recent.map((e) => ({
    artist: e.artist,
    title: e.title,
    album: e.album,
    showId: e.showId,
    playedAt: e.playedAt,
    artUrl: e.ratingKey ? `/api/art/${e.ratingKey}` : null,
  }));
}
