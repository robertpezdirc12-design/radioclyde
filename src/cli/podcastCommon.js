// Skupno obeh podkast CLI-jev (podcastGen.js, podcastAudio.js): izbor
// kandidatov iz knjižnice s pošteno napako, datum in izhodna mapa. Vse,
// kar NI čista matematika podcast.js/podcastAudio.js -- branje configa,
// knjižnice in razčlemba zastavic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.js';

// Fetches candidate tracks for a genre. Throws the honest Slovenian error
// (with the tags that DO exist as a hint) -- this is the shape the shared
// pipeline (auto/podcastPipeline.js, studio gumb) can safely await; the CLI
// wrapper below turns it into console.error + exit 1.
async function genreHint(listGenreTagsAny) {
  try {
    const tags = await listGenreTagsAny();
    return tags.length > 0 ? ` Razpoložljive oznake: ${tags.join(', ')}.` : '';
  } catch {
    return ''; // hint is optional -- main error carries the truth anyway
  }
}

export async function fetchCandidatesOrThrow(genre) {
  const { fetchCandidateTracksAny, listGenreTagsAny } = await import('../auto/librarySource.js');
  let candidates;
  try {
    candidates = await fetchCandidateTracksAny({ genre });
  } catch (err) {
    throw new Error(`Napaka pri poizvedbi po knjižnici: ${err.message.split('\n')[0]}${await genreHint(listGenreTagsAny)}`);
  }
  if (candidates.length === 0) {
    throw new Error(`V knjižnici ni skladb z žanrom "${genre}".${await genreHint(listGenreTagsAny)}`);
  }
  return candidates;
}

// CLI wrapper: same messages, same exit 1 -- but via the throwing core, so
// the CLI and the studio button can never drift apart in WHAT they say.
export async function gatherCandidates(genre) {
  try {
    return await fetchCandidatesOrThrow(genre);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// --date=YYYY-MM-DD or the station's local today (weather timezone contract).
export async function podcastDate(argv, timezone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(argv.date ?? ''))) return argv.date;
  // Lokalni YYYY-MM-DD iz lib/time.js (edelna implementacija) -- NE
  // currentLocalDateString, ki govorí "Saturday, October 24" za žive vrstice.
  // Ta vrstica je bila tiholeci bug: podcast-gen brez --date je vrgel
  // validacijo datuma vse od P5 #1.
  const { toLocalISOString } = await import('../lib/time.js');
  return toLocalISOString(new Date(), timezone).slice(0, 10);
}

export function podcastCount(argv, fallback = 2) {
  const parsed = parseInt(argv.tracks, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

export function podcastOutDir(argv, config) {
  // parseArgs pozna samo --key=value: gole `--out <mapa>` pusti out=true in
  // "mapo" kot pozicijski -- kar bi path.resolve("true") poslal v <repo>/true.
  // Poštena napaka takoj, ne tihočepač direktorij "true".
  if (argv.out === true) {
    throw new Error('--out potrebuje vrednost v obliki --out=<mapa> (z enačajem, npr. --out=/tmp/podkasti).');
  }
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
