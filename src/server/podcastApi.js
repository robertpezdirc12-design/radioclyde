// Javni podkast naslov (P5 #3): ENA resnica na disku (<dataDir>/podcasts/),
// tri površine iz nje --
//   GET /api/podcast        JSON arhiv za stran "Podkast" (vse epizode, tudi
//                           še brez zvoka -- stanje je izpisano, ne izumljeno)
//   GET /podcast/feed.xml   kanalski RSS 2.0 za podkast aplikacije (samo
//                           epizode z ZVOkom na disku -- enclosure je pogodba)
//   GET /podcast/<file>.mp3 zvočne datoteke z podporo za Range (iskanje v
//                           predvajalniku), strogo zaprto znotraj mape
// Varnost: globalni Basic Auth hook velja tudi tu; lastnik lahko poti odpre
// z config.web.publicPaths (npr. ["/podcast", "/api/podcast"]) -- istega
// vzvoda, kot ga že uporabljata /embed in /listen.m3u. Datotečna pot nikoli
// ne uide iz podcastsDir: ime je omejeno na beli seznam znakov, MORA končati
// z .mp3, in rešena pot mora ostati znotraj mape (trojna obramba).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { loadStation } from '../scheduler/scheduleUtil.js';
import { buildPodcastChannelFeed } from '../auto/podcast.js';

// Isti vzorec kot staticFiles.js: pot do public/ iz lokacije modula, ne cwd --
// strežnik se lahko zažene iz katerekoli delovne mape.
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

function stationName() {
  try {
    return loadStation().name ?? 'Radio Markec';
  } catch {
    return 'Radio Markec';
  }
}

// Isti precedens kot listenFiles.resolveStreamUrl (javni URL lastnika > izpeljava),
// ampak ORIGIN brez poti -- feed povezave morajo delovati tudi za Cloudflare
// Tunnel, kjer je javni naslov drug port/dometa kot interni Icecast.
export function publicBaseUrl() {
  const declared = config.broadcast?.publicStreamUrl;
  if (typeof declared === 'string' && declared.trim()) {
    try {
      return new URL(declared.trim()).origin;
    } catch {
      // spodaj izpeljava -- napačen javni URL ne sme spodleteti feeda
    }
  }
  return `http://${config.icecast.publicHost}:${config.web.port}`;
}

// Skenira plan .json datoteke iz podcastsDir. Disk je vir resnice: zvok je
// "obstaja" samo, kadar .mp3 res leži poleg načrta in ima več kot 0 bajtov --
// plan.audio blok je nasvet, ne dokaz (lahko je zastarel).
export function scanPodcastEpisodes(podcastsDir = path.join(config.dataDir, 'podcasts')) {
  let names = [];
  try {
    names = fs.readdirSync(podcastsDir);
  } catch {
    return []; // mapa še ne obstaja = arhiv je prazen, ne napaka
  }
  const episodes = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const base = name.slice(0, -5);
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(podcastsDir, name), 'utf8'));
    } catch {
      continue; // pokvarjen načrt ni objavljen -- stran pokaže le resnico
    }
    if (!plan || typeof plan.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) continue;
    const mp3Path = path.join(podcastsDir, `${base}.mp3`);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
    } catch {
      sizeBytes = 0;
    }
    const pieces = Array.isArray(plan.audio?.pieces) ? plan.audio.pieces : null;
    episodes.push({
      id: typeof plan.id === 'string' ? plan.id : 'markec-podkast',
      date: plan.date,
      title: typeof plan.title === 'string' && plan.title.trim() ? plan.title : `Markec Podkast ${plan.date}`,
      seconds: Number.isFinite(plan.audio?.seconds) ? plan.audio.seconds : null,
      hasAudio: sizeBytes > 0,
      sizeBytes,
      audioFile: sizeBytes > 0 ? `${base}.mp3` : null,
      chapters: pieces
        ? pieces.map((p) => ({ title: String(p.title ?? p.slot ?? ''), startMs: Math.round(Number(p.startMs) || 0) }))
        : null,
      seed: typeof plan.seed === 'string' ? plan.seed : null,
    });
  }
  return episodes.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

// Single-range parser (RFC 7233 dovolj za <audio> iskanje): "bytes=a-b",
// "bytes=a-", "bytes=-n" -> { start, end } | null (ne-veljaven ali večrazpen).
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=') || size <= 0) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null; // multipart -- redko, obskuren; pošteno zavrnemo
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    // zadnjih n bajtov
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return null;
    end = Math.min(end, size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

// Trojna obramba datotecnega servisa: (1) beli seznam znakov, (2) .mp3
// končnica, (3) rešena pot MORA ostati znotraj podcastsDir. Vrne absolutno
// pot ali null -- klical se bo tudi z URL-odkodiranim "../" iz brskalnika.
export function safeAudioPath(podcastsDir, fileName) {
  if (typeof fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,128}$/.test(fileName)) return null;
  if (!fileName.toLowerCase().endsWith('.mp3')) return null;
  const resolved = path.resolve(podcastsDir, fileName);
  const root = path.resolve(podcastsDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function registerPodcastRoutes(fastify, { podcastsDir = path.join(config.dataDir, 'podcasts') } = {}) {
  const base = () => publicBaseUrl();

  fastify.get('/api/podcast', () => {
    const b = base();
    const episodes = scanPodcastEpisodes(podcastsDir).map((ep) => ({
      ...ep,
      audioUrl: ep.audioFile ? `${b}/podcast/${ep.audioFile}` : null,
    }));
    return {
      feedUrl: `${b}/podcast/feed.xml`,
      episodes,
    };
  });

  fastify.get('/podcast/feed.xml', (_request, reply) => {
    const b = base();
    // Kanal objavi SAMO epizode z zvokom na disku: enclosure je pogodba do
    // podkast aplikacij -- item brez enclosurea bi pomenil lažno obljubo.
    // Arhiv brez zvoka vidiš na /api/podcast (hasAudio: false), ne v feedu.
    const publishable = scanPodcastEpisodes(podcastsDir)
      .filter((ep) => ep.hasAudio)
      .map((ep) => ({
        date: ep.date,
        title: ep.title,
        seconds: ep.seconds ?? 0,
        sizeBytes: ep.sizeBytes,
        audioUrl: `${b}/podcast/${ep.audioFile}`,
        guid: `markec-podkast-${ep.date}`,
      }));
    let imageUrl = null;
    try {
      imageUrl = fs.existsSync(path.join(PUBLIC_DIR, 'logo.png')) ? `${b}/logo.png` : null;
    } catch {
      imageUrl = null;
    }
    const xml = buildPodcastChannelFeed({
      station: stationName(),
      title: `Markec Podkast -- ${stationName()}`,
      description: `Kratke epizode radijske postaje ${stationName()}: glasba iz prave knjižnice, pogovor brez modelov, smeh po dogovoru.`,
      link: `${b}/`,
      imageUrl,
      author: stationName(),
      episodes: publishable,
    });
    reply.header('content-type', 'application/rss+xml; charset=utf-8');
    // Feed se spremeni samo z epizodo -- ena ura cachea je poštena in olajša
    // podkast aplikacijam; vseeno ni no-store, ker so bajti deterministični.
    reply.header('cache-control', 'public, max-age=3600');
    return xml;
  });

  fastify.get('/podcast/:file', (request, reply) => {
    const resolved = safeAudioPath(podcastsDir, request.params.file);
    if (!resolved) return reply.code(404).send();
    let size = 0;
    try {
      size = fs.statSync(resolved).size;
    } catch {
      return reply.code(404).send();
    }
    if (size === 0) return reply.code(404).send();

    const range = parseRange(request.headers.range, size);
    const stream = fs.createReadStream(resolved, range ? { start: range.start, end: range.end } : undefined);
    reply.header('content-type', 'audio/mpeg');
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'public, max-age=3600');
    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('content-length', String(range.end - range.start + 1));
    } else {
      reply.header('content-length', String(size));
    }
    // Stream napaka (datoteka je umrla pod rokami) naj ne strmoglavi procesa:
    // fastify sam konča odgovor, mi samo utišamo EMFILE/ENOENT hrup.
    stream.on('error', () => reply.request.raw.destroy());
    return reply.send(stream);
  });
}
