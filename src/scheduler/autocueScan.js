#!/usr/bin/env node
// Scheduler job: walk the station's music library and loudness-analyze every
// file the index hasn't seen yet (lib/autocue.js -- offline ffmpeg ebur128
// passes). The scan budget (maxAnalyzePerRun) spreads a first-ever sweep of
// a big library across job ticks instead of blocking one tick for an hour;
// afterwards the job is a no-op listing until a file changes on disk.
//
// Deliberately NOT touching speech/jingle/imaging audio: those are produced
// at fixed loudness out-of-band (director/tts.js, docs/imaging-layer.md) and
// must stay outside library measurement -- only annotateTrackEntry's music
// tracks carry liq_amplify.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { fetchAllTracksAny } from '../auto/librarySource.js';
import { toLocalPath } from '../plex/musicLibrary.js';
import { analyzeMissing, loudnessSettings } from '../lib/autocue.js';

const log = createLogger('station');

// Same container list as imagingPlaylists.js: the clip producers and the
// library hold the same kind of files.
const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav'];

// Same resolution rule as generateFillerPlaylist.js's trackLocalPath: local
// library tracks carry localPath directly, Plex tracks keep the config-mapped
// conversion.
function trackLocalPath(t) {
  return t.localPath ?? toLocalPath(t.plexPath);
}

export async function runAutocueScan() {
  const all = await fetchAllTracksAny();
  const paths = [];
  const seen = new Set();
  for (const t of all) {
    let p;
    try {
      p = trackLocalPath(t);
    } catch {
      continue; // unmappable Plex path -- the filler playlist skips those too
    }
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (!AUDIO_EXTENSIONS.includes(path.extname(p).toLowerCase())) continue;
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch {
      continue; // library row pointing at an absent file -- not a scan target
    }
    paths.push(p);
  }

  const summary = await analyzeMissing(paths, {
    maxAnalyzePerRun: Math.max(1, config.autocue?.maxAnalyzePerRun ?? 100),
    settings: loudnessSettings(),
  });
  log(
    `Autocue scan: ${summary.total} library file(s) -- analyzed ${summary.analyzed}, ` +
      `unchanged ${summary.skipped}, failed ${summary.failed}` +
      (summary.clamped ? `, gain-clamped ${summary.clamped} (see maxGainDb)` : '')
  );
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutocueScan().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
