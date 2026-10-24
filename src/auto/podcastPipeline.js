// EN cevovod za OBE vrati v isto resnico: CLI (podcast-gen / podcast-audio)
// in studijev gumb (studioPodcastApi.js). Izvlečen iz CLI-jev, da studio ne
// more narediti ničesar drugega kot CLI -- in obratno; idempotentnost,
// skip-not-fail in zapis plan .json so po dogovoru ENAKI iz obeh smeri.
// Strežniku varen: NIKOLI process.exit -- samo poštene napake (to rutino
// kliče tudi HTTP ruda, kjer bi exit ubil celoten strežnik).
import fs from 'node:fs';
import path from 'node:path';

export async function producePodcastEpisode({
  date,
  genre = 'rock',
  count = 2,
  persona = 'markec',
  outDir,
  synthesize = false,
} = {}) {
  const { config } = await import('../config/index.js');
  const { fetchCandidatesOrThrow } = await import('../cli/podcastCommon.js');
  const { buildPodcastEpisode, writePodcastEpisode } = await import('./podcast.js');
  // Lokalni dan v YYYY-MM-DD: toLocalISOString (lib/time.js) je EDELN izvoz --
  // weather.currentLocalDateString govori "Saturday, October 24" za žive
  // vrstice in bi tu pošteno vrgel validacijo datuma. Bug je bil ziv v CLI-ju
  // (podcast-gen BREZ --date) vse od P5 #1; prišel na plan šele z studio
  // gumbom, ki CLI zastavic ne prenaša.
  const { toLocalISOString } = await import('../lib/time.js');

  const day = date ?? toLocalISOString(new Date(), config.weather?.timezone).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    throw new Error(`Datum podkasta mora biti YYYY-MM-DD, dobljeno: "${day}".`);
  }

  const candidates = await fetchCandidatesOrThrow(genre);
  const episode = buildPodcastEpisode({
    date: day,
    tracks: candidates,
    count,
    station: config.autoRadio?.stationName ?? 'Radio Markec',
  });
  const { mdPath, jsonPath } = writePodcastEpisode(episode, outDir ?? path.join(config.dataDir, 'podcasts'));

  let audio = null;
  if (synthesize) {
    const { synthesizePodcastEpisodeAudio } = await import('./podcastAudio.js');
    audio = await synthesizePodcastEpisodeAudio(episode, { outDir: outDir ?? path.join(config.dataDir, 'podcasts'), persona });

    // Plan JSON dobi resnico zvoka: datoteka, izmerjene sekunde, zamiki
    // poglavij in pošten seznam preskočenih. Vsebinski primerjalni zapis --
    // ponovni zagon brez sprememb nikoli ne spremeni mtime datoteke.
    const plan = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    plan.audio = {
      file: audio.mp3Path,
      seconds: audio.seconds,
      persona,
      pieces: audio.pieces.map((p) => ({ kind: p.kind, slot: p.slot, title: p.title, seconds: p.seconds, startMs: p.startMs, endMs: p.endMs })),
      skipped: audio.skipped,
    };
    const planJson = JSON.stringify(plan, null, 2) + '\n';
    if (fs.readFileSync(jsonPath, 'utf8') !== planJson) fs.writeFileSync(jsonPath, planJson);
  }

  return { episode, mdPath, jsonPath, audio };
}
