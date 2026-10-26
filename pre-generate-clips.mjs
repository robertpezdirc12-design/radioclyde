#!/usr/bin/env node
// Pre-generate Slovenian speech clips for all tracks in the music collection.
// Uses Piper TTS via the piper1-gpl runtime (piper-tts 1.8.0 on PyPI, the
// maintained successor of the archived rhasspy/piper) through the SHARED
// auto/piperVoice.js resolver -- the same voice config the on-air piper
// provider uses: autoRadio.voice.defaultPiperVoice (voice key like
// "sl_SI-artur-medium" -- downloaded once on first use -- or an .onnx path)
// with per-persona overrides. A missing voice fails with an actionable
// error instead of silently falling back to another voice.
// Output: data/pre-generated/<track_slug>_intro.wav and _recap.wav
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import { config } from './src/config/index.js';
import { synthesizePiper } from './src/auto/piperVoice.js';
import { renderSlot, stationName } from './src/auto/templates.js';

const execFileAsync = promisify(execFile);
const OUT_DIR = path.resolve(config.dataDir, 'pre-generated');

fs.mkdirSync(OUT_DIR, { recursive: true });

async function getTrackMeta(filePath) {
  try {
    const meta = await parseFile(filePath, { duration: true });
    const common = meta.common ?? {};
    const title = common.title ?? guessTitle(filePath) ?? path.basename(filePath, path.extname(filePath));
    const artist = common.artists?.[0] ?? common.artist ?? common.albumartist ?? guessArtist(filePath) ?? 'Unknown Artist';
    return { title, artist };
  } catch (e) {
    return { title: path.basename(filePath, path.extname(filePath)), artist: guessArtist(filePath) ?? 'Unknown Artist' };
  }
}

function guessArtist(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const m = /^\s*(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? m[1].trim() : null;
}

function guessTitle(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const m = /^\s*(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? m[2].trim() : null;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

async function synthesize(text, outFile) {
  const rawFile = `${outFile}.piper-src.wav`;
  await synthesizePiper(text, rawFile, null);
  const tmp = outFile + '.norm.wav';
  await execFileAsync('ffmpeg', ['-y', '-i', rawFile, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', tmp], { timeout: 60_000 });
  fs.renameSync(tmp, outFile);
  // The raw piper output is an intermediate -- normalized copy replaced it.
  fs.rmSync(rawFile, { force: true });
}

const audioFiles = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(mp3|ogg|wav|flac|m4a|opus)$/i.test(e.name)) audioFiles.push(f);
  }
}
walk(config.autoRadio?.music?.localDirs?.[0] ?? 'music');

let count = 0;
for (const filePath of audioFiles) {
  const { title, artist } = await getTrackMeta(filePath);
  const slug = slugify(`${artist}_${title}`);
  
  // Val 27: track clips render through the STATION'S template pools (the
  // same register, the same config.autoRadio.templates overrides) instead
  // of a hardcoded duplicate grammar. Seed is the track slug, so the clip
  // is deterministic per track (the file-existence check above already
  // depends on that). The three station-level clips below keep their own
  // no-show texts -- the open/close pools are show-shaped ({show}), and
  // these clips exist precisely for show-less music blocks.
  const introText = renderSlot('intro', {
    values: { artist, title, station: stationName() },
    seed: `preclip|${slug}|intro`,
  });
  const introFile = path.join(OUT_DIR, `${slug}_intro.wav`);
  if (!fs.existsSync(introFile)) {
    await synthesize(introText, introFile);
    console.log(`Generated: ${path.basename(introFile)}`);
    count++;
  }
  
  const recapText = renderSlot('recap', {
    values: { artist, title, station: stationName() },
    seed: `preclip|${slug}|recap`,
  });
  const recapFile = path.join(OUT_DIR, `${slug}_recap.wav`);
  if (!fs.existsSync(recapFile)) {
    await synthesize(recapText, recapFile);
    console.log(`Generated: ${path.basename(recapFile)}`);
    count++;
  }
}

const generalClips = [
  // Show-agnostic wording -- these files air on EVERY show in pregenerated
  // mode, so they must not name a specific show (audit 2026-10-24: the old
  // text said "oddaji Test All Music" on every single opening).
  { name: 'open', text: 'Dobrodošli na Radio Markec. Uživajte v glasbi.' },
  { name: 'close', text: 'S tem je oddaja zaključena. Do naslednjega srečanja!' },
  { name: 'handoff_weather', text: 'Poglejmo še, kakšno vreme nas čaka.' },
];
for (const clip of generalClips) {
  const outFile = path.join(OUT_DIR, `general_${clip.name}.wav`);
  if (!fs.existsSync(outFile)) {
    await synthesize(clip.text, outFile);
    console.log(`Generated: ${path.basename(outFile)}`);
    count++;
  }
}

console.log(`\nTotal generated: ${count} clips`);
console.log(`Output directory: ${OUT_DIR}`);