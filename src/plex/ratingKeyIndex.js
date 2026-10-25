// Sidecar index the on_track scrobble hook depends on: m3u files carry plain
// filesystem paths with no Plex ratingKey, so director/index.js/
// scheduler/generateFillerPlaylist.js record the path->ratingKey mapping here
// at the same point they already resolve it, and scrobbleTrack.js looks it
// up when Liquidsoap reports a path at playback time.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { withLock } from '../lib/lock.js';

function readMap() {
  // Fail-open: this multi-MB map is written by the scheduler process and
  // read by every detached scrobbleTrack process, so a reader CAN land on a
  // torn file no matter how carefully the writer swaps it -- a torn map means
  // one segment's now-playing/scrobble lookup misses and the track is
  // honestly treated as "no known ratingKey" (jingle/speech path). The next
  // successful write self-heals it, which is strictly better than throwing
  // and losing that segment's ledger/now-playing work entirely.
  try {
    return JSON.parse(fs.readFileSync(config.paths.trackRatingKeysPath, 'utf8'));
  } catch {
    return {};
  }
}

export async function mergeTrackRatingKeys(entries) {
  await withLock(config.paths.trackRatingKeysLockPath, () => {
    const map = readMap();
    for (const [localPath, ratingKey] of entries) {
      map[localPath] = String(ratingKey);
    }
    // Atomic tmp-<pid>+rename, the same swap every cross-process-read file
    // in this repo uses (pollsStore/requestsStore/streamsLiqWriter): a plain
    // writeFileSync of a multi-MB map is exactly the window in which a
    // detached scrobbleTrack reader catches the file half-written.
    const tmp = `${config.paths.trackRatingKeysPath}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(config.paths.trackRatingKeysPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, config.paths.trackRatingKeysPath);
  });
}

export function lookupRatingKey(localPath) {
  return readMap()[localPath] ?? null;
}
