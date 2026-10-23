#!/usr/bin/env node
// Imaging layer: short produced clips layered over the main program by
// liquidsoap/radio.liq -- station IDs (overlay at the top of the hour), timed
// stingers (delay()-gated), and an emergency bed below the program sources.
//
// This module only maintains the three .m3u files those Liquidsoap sources
// read (same now_playing.m3u/filler.m3u contract as everything else: Node
// writes playlists, Liquidsoap watches them). The clip audio itself is
// produced out-of-band (TTS / ffmpeg) into config.paths.imaging{Id,Stinger,
// Emergency}Dir -- see docs/imaging-layer.md. A missing or empty directory
// writes an empty .m3u, which makes that playlist source fallible-empty, so
// the layer simply becomes unavailable on air: every imaging layer degrades
// to "behaves exactly as before this feature existed", never to silence.
//
// Deliberately does NOT call recordPlayed() or touch the filler rotation
// ledger (scheduler/fillerRotation.js) -- imaging clips are neither music
// library tracks nor show content, and they must never shrink or pollute
// the pools those systems manage. Scrobbling also doesn't apply: entries
// carry an explicit liq_fade_in="0" and are speech-family clips, and
// scrobbleTrack.js's ratingKey index has no entry for them (it treats
// unknown paths as skips, same as DJ speech today).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

// Same default list as autoRadio's music.audioExtensions -- imaging clips are
// produced with the same tooling, so the same containers show up here. Exact
// match on the extension, case-insensitive, files only (no recursive scan:
// one flat directory per layer keeps "what's on air" auditable at a glance).
const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav'];

// Imaging clips are speech-family audio (IDs, stingers, emergency bed), so
// they get the explicit "0" hard-cut annotate, exactly like DJ speech in
// director/playlist.js -- they must never be faded by radio.liq's fade.in
// fallback either way, but being explicit keeps the file self-describing.
function entryLine(filePath) {
  return `annotate:liq_fade_in="0":${filePath}`;
}

// Pure: absolute paths of audio files directly inside dir, sorted for stable
// output (playlist order doesn't matter -- radio.liq randomizes -- but stable
// files mean the watch-reload only fires when the SET of clips actually
// changed, not on every rescan).
export function buildImagingEntries(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { entries: [], dirMissing: true };
  }
  const entries = names
    .filter((name) => {
      if (!AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase())) return false;
      try {
        return fs.statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => path.join(dir, name));
  return { entries, dirMissing: false };
}

function writeImagingPlaylistFile(entries, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const content = entries.length ? entries.map(entryLine).join('\n') + '\n' : '';
  fs.writeFileSync(outPath, content);
}

// Writes all three layer playlists. Returns a plain summary object so tests
// (and any future Diagnostics surface) can assert on counts without parsing
// logs: { id: {count, dirMissing, path}, stingers: {...}, emergency: {...} }.
export function writeImagingPlaylists() {
  const layers = [
    { name: 'id', dir: config.paths.imagingIdDir, outPath: config.paths.imagingIdPath },
    { name: 'stingers', dir: config.paths.imagingStingerDir, outPath: config.paths.imagingStingerPath },
    { name: 'emergency', dir: config.paths.imagingEmergencyDir, outPath: config.paths.imagingEmergencyPath },
  ];
  const summary = {};
  for (const { name, dir, outPath } of layers) {
    const { entries, dirMissing } = buildImagingEntries(dir);
    writeImagingPlaylistFile(entries, outPath);
    summary[name] = { count: entries.length, dirMissing, path: outPath };
    if (dirMissing) {
      log(`Imaging: ${dir} missing -> empty ${outPath} (layer unavailable on air, station unaffected)`);
    } else {
      log(`Imaging: ${entries.length} clip(s) -> ${outPath}`);
    }
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeImagingPlaylists();
}
