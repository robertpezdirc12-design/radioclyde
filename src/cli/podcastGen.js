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
//   npm run podcast-audio   -- ISTA epizoda, plus Piper zvok (P5 #2)
//
// Skip-not-fail obrobje: prazen žanr = poštena slovenska napaka (exit 1),
// manjkajoč fakt = epizoda s smešnim pogovorom namesto zgodovinske.
import { ensureConfig, podcastCount, podcastDate, podcastOutDir, parseArgs } from './podcastCommon.js';

const argv = parseArgs(process.argv.slice(2));
ensureConfig();
const { config } = await import('../config/index.js');
const { renderPodcastScript } = await import('../auto/podcast.js');
const { producePodcastEpisode } = await import('../auto/podcastPipeline.js');

const timezone = config.weather?.timezone ?? 'UTC';
const date = await podcastDate(argv, timezone);
const genre = String(argv.genre ?? 'rock');
const count = podcastCount(argv);
const outDir = podcastOutDir(argv, config);

try {
  // Ista resnica kot studijev gumb: EN cevovod (auto/podcastPipeline.js), CLI
  // je samo zastavice + izpis. Poštena napaka = console.error + exit 1.
  var { episode, mdPath, jsonPath } = await producePodcastEpisode({ date, genre, count, outDir, synthesize: false });
} catch (err) {
  console.error(`Napaka: ${err.message}`);
  process.exit(1);
}

console.log(`${episode.title} -- ${episode.date} (~${Math.round(episode.estimatedSeconds / 60)} min, zrno ${episode.seed})`);
for (const t of episode.tracks) console.log(`  glasba: ${t.artist} -- ${t.title}`);
console.log(`  fakt:   ${episode.fact ? episode.fact.slice(0, 70) + (episode.fact.length > 70 ? '...' : '') : 'brez (smeh namesto zgodovine)'}`);
console.log(`  skripta: ${mdPath}`);
console.log(`  načrt:   ${jsonPath}`);
if (argv.print) process.stdout.write(renderPodcastScript(episode) + '\n');
