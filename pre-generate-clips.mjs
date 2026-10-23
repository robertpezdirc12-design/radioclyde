#!/usr/bin/env node
// Pre-generate Slovenian speech clips for all tracks in the music collection.
// Uses Piper TTS (free, local, natural Slovenian voice).
// Output: data/pre-generated/<track_slug>_intro.wav and _recap.wav
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';

const execFileAsync = promisify(execFile);
const PYTHON = process.platform === 'win32' ? 'C:/Program Files/Python311/python.exe' : 'python3';
const PIPER_MODEL = path.resolve('voices/sl_SI-artur-medium.onnx');
const OUT_DIR = path.resolve('data/pre-generated');

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
  const textFile = outFile + '.txt';
  fs.writeFileSync(textFile, text, 'utf8');
  try {
    await execFileAsync(PYTHON, ['-m', 'piper', '-m', PIPER_MODEL, '-f', outFile, '--input-file', textFile], { timeout: 120_000 });
  } finally {
    // Same cleanup guarantee as voice.js's piper provider (audit 2026-10-24):
    // failed synthesis must not leak the temp text file.
    fs.rmSync(textFile, { force: true });
  }
  const tmp = outFile + '.norm.wav';
  await execFileAsync('ffmpeg', ['-y', '-i', outFile, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', tmp], { timeout: 60_000 });
  fs.renameSync(tmp, outFile);
}

const audioFiles = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(mp3|ogg|wav|flac|m4a|opus)$/i.test(e.name)) audioFiles.push(f);
  }
}
walk('music');

let count = 0;
for (const filePath of audioFiles) {
  const { title, artist } = await getTrackMeta(filePath);
  const slug = slugify(`${artist}_${title}`);
  
  const introText = `Sledi ${title} izvajalca ${artist}.`;
  const introFile = path.join(OUT_DIR, `${slug}_intro.wav`);
  if (!fs.existsSync(introFile)) {
    await synthesize(introText, introFile);
    console.log(`Generated: ${path.basename(introFile)}`);
    count++;
  }
  
  const recapText = `To je bila skladba ${title} izvajalca ${artist}.`;
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
  { name: 'open', text: 'Dobrodošli na Radio Clyde. Uživajte v glasbi.' },
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