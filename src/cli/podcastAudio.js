#!/usr/bin/env node
// Markec Podkast AUDIO CLI (P5 #2) -- ista epizoda kot podcast-gen, plus
// ZVOK: [pogovor] vrstice izgovori Piper (isti glas kot živa oddaja),
// glasbene vrstice vzame iz realnih knjižnih datotek in vse sešije v
// podcast MP3 (44.1 kHz stereo, 128 kbps) z vgrajenimi poglavji.
//
//   npm run podcast-audio
//       Današnja epizoda: --genre=rock, dve skladbi iz knjižnice, piper
//       govor. Zapiše <dataDir>/podcasts/<datum>-markec-podkast.mp3 +
//       -poglavja.txt + posodobljen načrt .json (blok "audio" z resničnimi
//       zamiki poglavij).
//
//   npm run podcast-audio -- --date=2026-10-25 --genre=metal --tracks=3 --persona=markec --out=/tmp/x
//
// Skip-not-fail: vrstica brez zvoka (piper napaka, skladba brez datoteke --
// npr. Plex vir) se pošteno preskoči in belei v načrtu; epizoda je lahko
// tudi samo-govorna. Če ne pride skozi NIČ, je to poštena napaka (exit 1).
// Zahteva: piper1-gpl (pip install piper-tts) + glas v dataDir/piper
// (ali pot v configu) + ffmpeg z libmp3lame.
import fs from 'node:fs';
import path from 'node:path';
import { ensureConfig, gatherCandidates, podcastCount, podcastDate, podcastOutDir, parseArgs } from './podcastCommon.js';

const args = parseArgs(process.argv.slice(2));
ensureConfig();
const { config } = await import('../config/index.js');
const { PODCAST_ID, buildPodcastEpisode, writePodcastEpisode } = await import('../auto/podcast.js');
const { synthesizePodcastEpisodeAudio } = await import('../auto/podcastAudio.js');

const timezone = config.weather?.timezone ?? 'UTC';
const date = await podcastDate(args, timezone);
const genre = String(args.genre ?? 'rock');
const count = podcastCount(args);
const persona = String(args.persona ?? 'markec');
const outDir = podcastOutDir(args, config);

const candidates = await gatherCandidates(genre);
const episode = buildPodcastEpisode({
  date,
  tracks: candidates,
  count,
  station: config.autoRadio?.stationName ?? 'Radio Markec',
});
const { jsonPath } = writePodcastEpisode(episode, outDir);

const audio = await synthesizePodcastEpisodeAudio(episode, { outDir, persona });

// Plan JSON gets the real audio truth: file, measured seconds, per-piece
// offsets (chapter marks) and the honest skip list. Content-compare write --
// rerunning without changes never touches the file's mtime.
const plan = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
plan.audio = {
  file: audio.mp3Path,
  seconds: audio.seconds,
  persona,
  pieces: audio.pieces.map((p) => ({ kind: p.kind, slot: p.slot, title: p.title, seconds: p.seconds, startMs: p.startMs, endMs: p.endMs })),
  skipped: audio.skipped,
};
const planJson = JSON.stringify(plan, null, 2) + '\n';
if (fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, 'utf8') !== planJson) {
  fs.writeFileSync(jsonPath, planJson);
}

console.log(`${episode.title} -- ${episode.date} (zvok: ~${audio.seconds} s, ${audio.pieces.length} delov, zrno ${episode.seed})`);
for (const p of audio.pieces) {
  const mm = Math.floor(p.startMs / 60000);
  const ss = String(Math.floor((p.startMs % 60000) / 1000)).padStart(2, '0');
  console.log(`  ${mm}:${ss} [${p.kind}] ${p.title}`);
}
for (const s of audio.skipped) console.log(`  PRESKOČENO [${s.kind}] ${s.title} -- ${s.reason}`);
console.log(`  mp3:      ${audio.mp3Path}`);
console.log(`  poglavja: ${audio.chaptersPath}`);
console.log(`  načrt:    ${jsonPath}`);
