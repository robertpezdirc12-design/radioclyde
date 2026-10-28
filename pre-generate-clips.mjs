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
import { currentLocalDateString } from './src/director/weather.js';

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
  // Val 33 (dnevni profili govora): blockKey null -- predgenerirani klipi so
  // BREZ ČASA dneva (postaja-level imaging zveni enako ob šesti uri in ob
  // polnoči; dnevni tempo je življenje DJ-jevih segmentov, ne tega orodja).
  await synthesizePiper(text, rawFile, null, { blockKey: null });
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

// Val 28 A2: the three station-level clips render through the STATION'S own
// pools (templates.js stationOpen/stationClose/stationHandoff -- the same
// relaxed register and the same config.autoRadio.templates overrides as every
// other spoken surface) instead of three hardcoded texts that aired verbatim
// on every show. Seed carries the LOCAL DATE, so a re-run of the script the
// next day draws the next variant; the sidecar .txt remembers which text the
// wav on disk actually speaks, so a same-day re-run is a no-op and an owner
// pool edit re-synthesizes. Filenames stay frozen (general_open.wav ...) --
// voice.js's resolver, voiceStatus.js and the studio UI pin them.
const generalClips = [
  { name: 'open', slot: 'stationOpen' },
  { name: 'close', slot: 'stationClose' },
  { name: 'handoff_weather', slot: 'stationHandoff' },
];
const generalDateKey = currentLocalDateString(config.weather?.timezone ?? 'UTC');
for (const clip of generalClips) {
  const seed = `general|${clip.name}|${generalDateKey}`;
  const text = renderSlot(clip.slot, { values: { station: stationName() }, seed });
  const outFile = path.join(OUT_DIR, `general_${clip.name}.wav`);
  const sidecar = `${outFile}.txt`;
  let spokenPreviously = null;
  try {
    spokenPreviously = fs.readFileSync(sidecar, 'utf8');
  } catch {
    // first run after Val 28 (or a fresh install): no sidecar yet
  }
  if (fs.existsSync(outFile) && spokenPreviously === text) {
    continue; // same date, same pool draw -> the wav already speaks this text
  }
  await synthesize(text, outFile);
  fs.writeFileSync(sidecar, text);
  console.log(`Generated: ${path.basename(outFile)}`);
  count++;
}

console.log(`\nTotal generated: ${count} clips`);
console.log(`Output directory: ${OUT_DIR}`);