#!/usr/bin/env node
// Markec Podkast CLI (P5 #1) -- zgradi in zapiši eno 5-minutno epizodo
// (glasba-klepet-glasba-smeh) iz realne glasbene knjižnice. Modul
// (src/auto/podcast.js) je čist; tukaj je samo izbor virov, zastavice in
// izpis -- ista delitev kot themedShows.js.
//
//   npm run podcast-gen
//       Današnja epizoda: --genre=rock, dve skladbi iz knjižnice, en fakt
//       iz offline korpusa, zajebant skripta. Zapiše <dataDir>/podcasts/
//       <datum>-markec-podkast.md + .json (idempotentno: enak klic ne
//       prepiše datotek).
//
//   npm run podcast-gen -- --date=2026-10-25 --genre=metal --tracks=3 --out=/tmp/x
//
// Skip-not-fail obrobje: prazen žanr = poštena slovenska napaka (exit 1),
// manjkajoč fakt = epizoda s smešnim pogovorom namesto zgodovinskega.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(repoRoot, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`config.json not found at ${configPath}. Copy config.example.json to config.json and fill in real values.`);
  process.exit(1);
}

const argv = parseArgs(process.argv.slice(2));
const { config } = await import('../config/index.js');
const { currentLocalDateString } = await import('../director/weather.js');
const { fetchCandidateTracksAny, listGenreTagsAny } = await import('../auto/librarySource.js');
const { PODCAST_ID, buildPodcastEpisode, writePodcastEpisode, renderPodcastScript } = await import('../auto/podcast.js');

const timezone = config.weather?.timezone ?? 'UTC';
const date = /^\d{4}-\d{2}-\d{2}$/.test(String(argv.date ?? ''))
  ? argv.date
  : currentLocalDateString(timezone);
const genre = String(argv.genre ?? 'rock');
const count = Number.isFinite(parseInt(argv.tracks, 10)) ? Math.max(1, parseInt(argv.tracks, 10)) : 2;
const outDir = argv.out
  ? path.resolve(String(argv.out))
  : path.join(config.dataDir, 'podcasts');

let candidates = [];
try {
  candidates = await fetchCandidateTracksAny({ genre });
} catch (err) {
  // local library THROWS on a zero-match genre; Plex returns [] -- either
  // way the operator gets the honest message plus what tags DO exist
  let hint = '';
  try {
    const tags = await listGenreTagsAny();
    hint = tags.length > 0 ? ` Razpoložljive oznake: ${tags.join(', ')}.` : '';
  } catch {
    // hint is optional
  }
  console.error(`Napaka pri poizvedbi po knjižnici: ${err.message.split('\n')[0]}${hint}`);
  process.exit(1);
}

if (candidates.length === 0) {
  let tags = [];
  try {
    tags = await listGenreTagsAny();
  } catch {
    // hint is optional -- fail without it rather than hiding the main error
  }
  console.error(
    `V knjižnici ni skladb z žanrom "${genre}".` + (tags.length > 0 ? ` Razpoložljive oznake: ${tags.join(', ')}.` : '')
  );
  process.exit(1);
}

const episode = buildPodcastEpisode({ date, tracks: candidates, count, station: config.autoRadio?.stationName ?? 'Radio Markec' });
const { mdPath, jsonPath } = writePodcastEpisode(episode, outDir);

console.log(`${episode.title} -- ${episode.date} (~${Math.round(episode.estimatedSeconds / 60)} min, zrno ${episode.seed})`);
for (const t of episode.tracks) console.log(`  glasba: ${t.artist} -- ${t.title}`);
console.log(`  fakt:   ${episode.fact ? episode.fact.slice(0, 70) + (episode.fact.length > 70 ? '...' : '') : 'brez (smeh namesto zgodovine)'}`);
console.log(`  skripta: ${mdPath}`);
console.log(`  načrt:   ${jsonPath}`);
if (argv.print) process.stdout.write(renderPodcastScript(episode) + '\n');
