// Skupno obeh podkast CLI-jev (podcastGen.js, podcastAudio.js): izbor
// kandidatov iz knjižnice s pošteno napako, datum in izhodna mapa. Vse,
// kar NI čista matematika podcast.js/podcastAudio.js -- branje configa,
// knjižnice in razčlemba zastavic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.js';

// Fetches candidate tracks for a genre and turns BOTH failure shapes (local
// library THROWS on zero matches, Plex returns []) into the same honest
// Slovenian error with the tags that DO exist -- exit 1, never a silent
// empty episode.
export async function gatherCandidates(genre) {
  const { fetchCandidateTracksAny, listGenreTagsAny } = await import('../auto/librarySource.js');
  let candidates = [];
  try {
    candidates = await fetchCandidateTracksAny({ genre });
  } catch (err) {
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
  return candidates;
}

// --date=YYYY-MM-DD or the station's local today (weather timezone contract).
export function podcastDate(argv, timezone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(argv.date ?? ''))) return argv.date;
  // dynamic import keeps the module leafy -- weather.js drags in config
  return import('../director/weather.js').then(({ currentLocalDateString }) => currentLocalDateString(timezone));
}

export function podcastCount(argv, fallback = 2) {
  const parsed = parseInt(argv.tracks, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

export function podcastOutDir(argv, config) {
  return argv.out ? path.resolve(String(argv.out)) : path.join(config.dataDir, 'podcasts');
}

export function ensureConfig() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const configPath = path.join(repoRoot, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`config.json not found at ${configPath}. Copy config.example.json to config.json and fill in real values.`);
    process.exit(1);
  }
  return repoRoot;
}

export { parseArgs };
