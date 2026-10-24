// Studio gumb za podkast (P5 nadaljevanje po analizi vmesnikov): CLI-ja ne
// more klikniti iz brskalnika -- ta ruta pokliče ISTI cevovod
// (auto/podcastPipeline.js) kot `npm run podcast-audio`, zato studio in CLI
// ne moreta ustvariti dveh različnih resnic. Piše v <dataDir>/podcasts/ --
// to je dobrodelna ozka pisalna površina, enaka dogovoru kot ostali
// studievi pisalni konci (brifi, urnik, zahtevki).
//
// GET  /studio/api/podcast -- stanje: ali izdelava teče + zadnjih 10 epizod
//                             (isti sken kot javni /api/podcast)
// POST /studio/api/podcast -- izdelaj epizodo (privzeto današnjo; reuse, če
//                             že ima zvok, --force pa jo zavoljno prevzame).
//                             Piper + ffmpeg trajata desetine sekund -- odgovor
//                             je sinkron, zato sočasni klik dobi 409, ne dvema
//                             epizodama.
import path from 'node:path';
import { config } from '../config/index.js';
import { scanPodcastEpisodes } from './podcastApi.js';

export function registerStudioPodcastRoutes(fastify, { produce, podcastsDir = path.join(config.dataDir, 'podcasts'), scan = scanPodcastEpisodes } = {}) {
  let running = false;

  // Injectable produce: testi vdenejo lažnjaka; strežnik pa povlecče pravi
  // cevovod iz auto/podcastPipeline.js (dinamični uvoz -- proces start ostane
  // brez piper/ffmpeg knjižnic, dokler gumba ne klikne).
  const produceEpisode = produce ?? (async (body) => {
    const { producePodcastEpisode } = await import('../auto/podcastPipeline.js');
    return producePodcastEpisode({
      date: body?.date,
      genre: body?.genre ?? 'rock',
      count: body?.tracks ?? 2,
      persona: body?.persona ?? 'markec',
      outDir: podcastsDir,
      synthesize: true,
    });
  });

  fastify.get('/studio/api/podcast', () => {
    const episodes = scan(podcastsDir);
    return {
      running,
      lastEpisode: episodes[0] ?? null,
      episodes: episodes.slice(0, 10),
    };
  });

  fastify.post('/studio/api/podcast', async (request, reply) => {
    if (running) {
      return reply.code(409).send({ error: 'Izdelava podkasta že teče -- počakaj, da se konča (desetine sekund zvoka).' });
    }
    const body = request.body ?? {};
    running = true;
    try {
      // Reuse pošteno: današnja epizoda z zvokom na disku = že objavljena
      // resnica, je ne prevzamemo brez --force. Datum v telesu pa dovoli
      // "popravi včerajšnjo", enako kot CLI --date.
      if (!body.force && !body.date) {
        // Lokalni YYYY-MM-DD iz lib/time.js -- weather.currentLocalDateString
        // govori "Saturday, October 24" in bi reuse nikoli ne zadel.
        const { toLocalISOString } = await import('../lib/time.js');
        const today = toLocalISOString(new Date(), config.weather?.timezone).slice(0, 10);
        const existing = scan(podcastsDir).find((ep) => ep.date === today && ep.hasAudio);
        if (existing) {
          return {
            ok: true,
            reused: true,
            episode: { id: existing.id, date: existing.date, title: existing.title, seed: existing.seed },
            audio: { seconds: existing.seconds, file: existing.audioFile, pieces: existing.chapters?.length ?? 0 },
          };
        }
      }
      const { episode, audio } = await produceEpisode(body);
      return {
        ok: true,
        reused: false,
        episode: { id: episode.id, date: episode.date, title: episode.title, seed: episode.seed },
        audio: audio
          ? { seconds: audio.seconds, file: path.basename(audio.mp3Path), pieces: audio.pieces.length, skipped: audio.skipped.length }
          : null,
      };
    } catch (err) {
      // Poštena napaka do poslušalca studia -- ne stack, ampak prva vrstica
      // resničnega vzroka (isto pravilo, ki ga pije CLI na console.error).
      return reply.code(500).send({ error: `Izdelava podkasta ni uspela: ${err.message.split('\n')[0]}` });
    } finally {
      running = false;
    }
  });
}
