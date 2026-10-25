// P5 #3: javni podkast naslov -- kanalski RSS, skeniranje arhiva, varnost
// poti in Range servisanje. Vse je deterministično: feed gradnik ne bere
// ure (lastBuildDate = najnovejša epizoda), testi pa vdenejo začasno mapo
// s fikturnimi načrti -- brez piperja, brez ffmpeg, brez omrežja.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('podcast-api', {
  broadcast: { publicStreamUrl: 'https://radio.example.com/live', tuneIn: null, discordWebhook: null },
  web: { port: 3999, publicPaths: [] },
  // Studio uporabnik za polno montažo vtičnika /studio (blok 6) -- preostanek
  // datoteke ga ne rabi, dodatna tipka pa ničesar ne pokvari.
  studio: { users: [{ username: 'studio', password: 'podkast-geslo' }] },
});

const { buildPodcastChannelFeed, itunesDurationSeconds } = await import('../src/auto/podcast.js');
const { scanPodcastEpisodes, parseRange, safeAudioPath, publicBaseUrl, registerPodcastRoutes } = await import('../src/server/podcastApi.js');
const { registerStudioPodcastRoutes } = await import('../src/server/studioPodcastApi.js');
const { registerStudioRoutes } = await import('../src/server/studioAuth.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'markec-podkast-'));
}

function writePlan(dir, date, { withAudio = true, seconds = 400, pieces = null, extra = {} } = {}) {
  const base = `${date}-markec-podkast`;
  const plan = {
    id: 'markec-podkast',
    date,
    title: `Markec Podkast ${date}`,
    seed: `markec-podkast|${date}`,
    ...extra,
  };
  if (withAudio) {
    plan.audio = {
      file: `${dir}/${base}.mp3`,
      seconds,
      persona: 'markec',
      pieces: pieces ?? [
        { kind: 'pogovor', slot: 'podcastOpen', title: 'Otvoritev', seconds: 8, startMs: 0, endMs: 8000 },
        { kind: 'glasba', slot: 'intro', title: 'AC/DC -- Highway to Hell', seconds: 120, startMs: 8000, endMs: 128000 },
      ],
      skipped: [],
    };
  }
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(plan, null, 2) + '\n');
  if (withAudio) fs.writeFileSync(path.join(dir, `${base}.mp3`), Buffer.alloc(128, 7));
  return base;
}

// ---------------------------------------------------------------------------
// 1. Kanalski RSS gradnik
// ---------------------------------------------------------------------------
describe('buildPodcastChannelFeed', () => {
  const episodes = [
    { date: '2026-10-25', title: 'Markec Podkast 25. 10.', seconds: 400, sizeBytes: 1024, audioUrl: 'https://radio.example.com/podcast/a.mp3', description: 'a<b & "c"' },
    { date: '2026-10-24', title: 'Epizoda 24.', seconds: 305, sizeBytes: 512, audioUrl: 'https://radio.example.com/podcast/b.mp3' },
  ];

  test('kanal: osnovne oznake, language sl, itunes episodic', () => {
    const xml = buildPodcastChannelFeed({ station: 'Radio Markec', link: 'https://radio.example.com/', episodes });
    assert.match(xml, /<rss version="2.0" xmlns:itunes=/);
    assert.match(xml, /<title>Markec Podkast<\/title>/);
    assert.match(xml, /<link>https:\/\/radio\.example\.com\/<\/link>/);
    assert.match(xml, /<language>sl<\/language>/);
    assert.match(xml, /<itunes:type>episodic<\/itunes:type>/);
    assert.match(xml, /<itunes:explicit>false<\/itunes:explicit>/);
  });

  test('itemi: najnovejši prvi, guid, pubDate RFC822, trajanje iz sekund', () => {
    const xml = buildPodcastChannelFeed({ link: 'https://x/', episodes });
    assert.equal((xml.match(/<item>/g) || []).length, 2);
    assert.ok(xml.indexOf('25. 10.') < xml.indexOf('Epizoda 24.'), 'najnovejša epizoda gre prva');
    assert.match(xml, /<guid isPermaLink="false">markec-podkast-2026-10-25<\/guid>/);
    assert.match(xml, /<pubDate>Sun, 25 Oct 2026 12:00:00 GMT<\/pubDate>/);
    assert.match(xml, /<itunes:duration>0:06:40<\/itunes:duration>/);
  });

  test('enclosure samo kadar obstajata url in velikost', () => {
    const withEnc = buildPodcastChannelFeed({ link: 'https://x/', episodes });
    assert.match(withEnc, /<enclosure url="https:\/\/radio\.example\.com\/podcast\/a\.mp3" length="1024" type="audio\/mpeg"\/>/);
    const without = buildPodcastChannelFeed({
      link: 'https://x/',
      episodes: [{ date: '2026-10-24', title: 'brez zvoka', seconds: 0, sizeBytes: 0, audioUrl: null }],
    });
    assert.equal((without.match(/<enclosure/g) || []).length, 0);
  });

  test('XML escaping: opasni znaki gredo ven, bajti so deterministični', () => {
    const a = buildPodcastChannelFeed({ link: 'https://x/', episodes });
    const b = buildPodcastChannelFeed({ link: 'https://x/', episodes });
    assert.equal(a, b, 'isti vhod = isti bajti');
    assert.match(a, /a&lt;b &amp; &quot;c&quot;/);
    assert.ok(!a.includes('a<b'));
  });

  test('prazen arhiv: veljaven kanal brez itemov in brez lastBuildDate', () => {
    const xml = buildPodcastChannelFeed({ link: 'https://x/' });
    assert.equal((xml.match(/<item>/g) || []).length, 0);
    assert.ok(!xml.includes('lastBuildDate'), 'brez epizod ni izumljenega datuma');
    assert.match(xml, /<\/rss>\s*$/);
  });

  test('lastBuildDate je od najnovejše epizode, ne od ure zagona', () => {
    const xml = buildPodcastChannelFeed({ link: 'https://x/', episodes });
    const dates = [...xml.matchAll(/<lastBuildDate>([^<]+)<\/lastBuildDate>/g)].map((m) => m[1]);
    assert.equal(dates.length, 1);
    assert.equal(dates[0], 'Sun, 25 Oct 2026 12:00:00 GMT');
  });
});

describe('itunesDurationSeconds', () => {
  test('H:MM:SS iz sekund', () => {
    assert.equal(itunesDurationSeconds(400), '0:06:40');
    assert.equal(itunesDurationSeconds(3725), '1:02:05');
    assert.equal(itunesDurationSeconds(0), '0:00:00');
    assert.equal(itunesDurationSeconds(null), '0:00:00');
    assert.equal(itunesDurationSeconds(-5), '0:00:00');
  });
});

// ---------------------------------------------------------------------------
// 2. Skeniranje arhiva
// ---------------------------------------------------------------------------
describe('scanPodcastEpisodes', () => {
  test('načrt + mp3 = hasAudio, sizeBytes, poglavja; brez mp3 = pošteno brez', () => {
    const dir = tmpDir();
    writePlan(dir, '2026-10-25');
    writePlan(dir, '2026-10-24', { withAudio: false });
    const episodes = scanPodcastEpisodes(dir);
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0].date, '2026-10-25', 'najnovejša prva');
    assert.equal(episodes[0].hasAudio, true);
    assert.equal(episodes[0].sizeBytes, 128);
    assert.equal(episodes[0].audioFile, '2026-10-25-markec-podkast.mp3');
    assert.equal(episodes[0].seconds, 400);
    assert.deepEqual(episodes[0].chapters.map((c) => c.title), ['Otvoritev', 'AC/DC -- Highway to Hell']);
    assert.equal(episodes[1].hasAudio, false);
    assert.equal(episodes[1].audioFile, null);
    assert.equal(episodes[1].seconds, null);
  });

  test('pokvarjen JSON in tuje datoteke se preskočijo', () => {
    const dir = tmpDir();
    writePlan(dir, '2026-10-25');
    fs.writeFileSync(path.join(dir, 'slomljen.json'), '{ ni json');
    fs.writeFileSync(path.join(dir, 'neki.txt'), 'hello');
    fs.writeFileSync(path.join(dir, '2001-01-01-drug.json'), JSON.stringify({ date: 'not-a-date' }));
    const episodes = scanPodcastEpisodes(dir);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].date, '2026-10-25');
  });

  test('manjkajoča mapa = prazen arhiv, ne napaka', () => {
    assert.deepEqual(scanPodcastEpisodes('/ne/obstaja/kakor/tudi/ne'), []);
  });
});

// ---------------------------------------------------------------------------
// 3. Range in varnost poti
// ---------------------------------------------------------------------------
describe('parseRange', () => {
  test('veljavne oblike', () => {
    assert.deepEqual(parseRange('bytes=0-99', 200), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=100-', 200), { start: 100, end: 199 });
    assert.deepEqual(parseRange('bytes=-50', 200), { start: 150, end: 199 });
    assert.deepEqual(parseRange('bytes=0-999', 200), { start: 0, end: 199 }, 'konec se prižge na velikost');
  });
  test('neveljavne oblike -> null (odgovor 200 v celoti)', () => {
    assert.equal(parseRange(undefined, 200), null);
    assert.equal(parseRange('chunks=0-1', 200), null);
    assert.equal(parseRange('bytes=0-1,5-9', 200), null, 'multipart pošteno zavrnjen');
    assert.equal(parseRange('bytes=200-', 200), null, 'start za koncem');
    assert.equal(parseRange('bytes=-', 200), null);
    assert.equal(parseRange('bytes=abc-', 200), null);
    assert.equal(parseRange('bytes=0-1', 0), null, 'prazna datoteka nima razponov');
  });
});

describe('safeAudioPath', () => {
  test('veljavno ime gre skozi, traversal ne', () => {
    const dir = tmpDir();
    const ok = safeAudioPath(dir, '2026-10-25-markec-podkast.mp3');
    assert.equal(ok, path.join(dir, '2026-10-25-markec-podkast.mp3'));
    assert.equal(safeAudioPath(dir, '../config.json'), null);
    assert.equal(safeAudioPath(dir, '..%2Fconfig.json'), null, '% v imenu ni na belem seznamu');
    assert.equal(safeAudioPath(dir, 'podcast.xml'), null, 'serviramo samo mp3');
    assert.equal(safeAudioPath(dir, '2026-10-25-markec-podkast.json'), null);
    assert.equal(safeAudioPath(dir, '.mp3'), null);
    assert.equal(safeAudioPath(dir, 'a b.mp3'), null, 'presledek ni na belem seznamu');
    assert.equal(safeAudioPath(dir, 'x'.repeat(200) + '.mp3'), null, 'nora dolžina ven');
  });
});

// ---------------------------------------------------------------------------
// 4. Rute (fastify inject)
// ---------------------------------------------------------------------------
describe('podcast rute', () => {
  function app(podcastsDir) {
    const fastify = Fastify({ logger: false });
    registerPodcastRoutes(fastify, { podcastsDir });
    return fastify;
  }

  test('GET /api/podcast: arhiv z javnimi URL-ji (origin iz publicStreamUrl)', async () => {
    const dir = tmpDir();
    writePlan(dir, '2026-10-25');
    writePlan(dir, '2026-10-24', { withAudio: false });
    const fastify = app(dir);
    const res = await fastify.inject({ method: 'GET', url: '/api/podcast' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.feedUrl, 'https://radio.example.com/podcast/feed.xml');
    assert.equal(body.episodes.length, 2);
    assert.equal(body.episodes[0].audioUrl, 'https://radio.example.com/podcast/2026-10-25-markec-podkast.mp3');
    assert.equal(body.episodes[1].audioUrl, null);
    await fastify.close();
  });

  test('GET /podcast/feed.xml: samo epizode z zvokom, enclosure pogodba', async () => {
    const dir = tmpDir();
    writePlan(dir, '2026-10-25');
    writePlan(dir, '2026-10-24', { withAudio: false });
    const fastify = app(dir);
    const res = await fastify.inject({ method: 'GET', url: '/podcast/feed.xml' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/rss\+xml/);
    assert.equal((res.body.match(/<item>/g) || []).length, 1, 'brez zvoka ne gre v feed');
    assert.match(res.body, /<enclosure url="https:\/\/radio\.example\.com\/podcast\/2026-10-25-markec-podkast\.mp3" length="128"/);
    await fastify.close();
  });

  test('GET /podcast/:file: 200, Range 206, neveljaven range 200, zmeda 404', async () => {
    const dir = tmpDir();
    writePlan(dir, '2026-10-25');
    const fastify = app(dir);
    const url = '/podcast/2026-10-25-markec-podkast.mp3';

    const full = await fastify.inject({ method: 'GET', url });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['content-type'], 'audio/mpeg');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.body.length, 128);

    const part = await fastify.inject({ method: 'GET', url, headers: { range: 'bytes=10-19' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], 'bytes 10-19/128');
    assert.equal(part.body.length, 10);

    const whole = await fastify.inject({ method: 'GET', url, headers: { range: 'bytes=ne-velja' } });
    assert.equal(whole.statusCode, 200, 'neveljaven range = cela datoteka');

    assert.equal((await fastify.inject({ method: 'GET', url: '/podcast/manjka.mp3' })).statusCode, 404);
    assert.equal((await fastify.inject({ method: 'GET', url: '/podcast/2026-10-25-markec-podkast.json' })).statusCode, 404);
    assert.equal((await fastify.inject({ method: 'GET', url: '/podcast/..%2Fconfig.json' })).statusCode, 404, 'traversal ven');
    await fastify.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Studio gumb
// ---------------------------------------------------------------------------
describe('studio podcast ruta', () => {
  // Produkcjska oblika registracije: modul znotraj vtičnika s predpono
  // /studio (kot v index.js) -- poti v modulu so BREZ predpone, testni URL
  // pa zato ostane /studio/api/podcast, kot ga kliče front-end kartica.
  function app({ produce, scan, podcastsDir }) {
    const fastify = Fastify({ logger: false });
    fastify.register(async (instance) => {
      registerStudioPodcastRoutes(instance, { produce, scan, podcastsDir });
    }, { prefix: '/studio' });
    return fastify;
  }
  const today = new Date().toISOString().slice(0, 10); // test config je UTC

  test('GET status: running + lastEpisode iz skena', async () => {
    const fastify = app({
      podcastsDir: tmpDir(),
      scan: () => [{ id: 'markec-podkast', date: '2026-10-25', title: 'X', hasAudio: true, seconds: 400 }],
      produce: async () => { throw new Error('ne smem biti poklican'); },
    });
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/podcast' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.running, false);
    assert.equal(body.lastEpisode.date, '2026-10-25');
    await fastify.close();
  });

  test('POST reuse: današnja z zvokom = reused, produce se ne pokliče', async () => {
    let produceCalls = 0;
    const fastify = app({
      podcastsDir: tmpDir(),
      scan: (dir) => [{ id: 'markec-podkast', date: today, title: 'Današnja', hasAudio: true, seconds: 400, audioFile: 'x.mp3', seed: 's' }],
      produce: async () => { produceCalls += 1; throw new Error('ne smeš'); },
    });
    const res = await fastify.inject({ method: 'POST', url: '/studio/api/podcast' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reused, true);
    assert.equal(produceCalls, 0);
    await fastify.close();
  });

  test('POST force kliče produce in vrne resnico zvoka', async () => {
    const seen = [];
    const fastify = app({
      podcastsDir: tmpDir(),
      scan: () => [],
      produce: async (body) => {
        seen.push(body);
        return {
          episode: { id: 'markec-podkast', date: '2026-10-25', title: 'Nova', seed: 'zrno' },
          audio: { seconds: 400, mp3Path: '/tmp/x.mp3', pieces: [{}, {}], skipped: [] },
        };
      },
    });
    const res = await fastify.inject({ method: 'POST', url: '/studio/api/podcast', body: { force: true } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.reused, false);
    assert.equal(body.audio.seconds, 400);
    assert.deepEqual(seen, [{ force: true }]);
    await fastify.close();
  });

  test('sočasni POST -> 409, produce ne teče dvakrat', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fastify = app({
      podcastsDir: tmpDir(),
      scan: () => [],
      produce: async () => {
        calls += 1;
        await gate;
        return { episode: { id: 'i', date: '2026-01-01', title: 't', seed: 's' }, audio: { seconds: 1, mp3Path: '/tmp/a.mp3', pieces: [], skipped: [] } };
      },
    });
    const first = fastify.inject({ method: 'POST', url: '/studio/api/podcast' });
    // daj prvi mimika, da res pride do running=true pred drugim klicem
    await new Promise((r) => setTimeout(r, 20));
    const second = await fastify.inject({ method: 'POST', url: '/studio/api/podcast' });
    assert.equal(second.statusCode, 409);
    release();
    const firstBody = (await first).json();
    assert.equal(firstBody.ok, true);
    assert.equal(calls, 1);
    await fastify.close();
  });

  test('produce napaka -> 500 s poštenim sporočilom (prva vrstica)', async () => {
    const fastify = app({
      podcastsDir: tmpDir(),
      scan: () => [],
      produce: async () => { throw new Error('V knjižnici ni skladb z žanrom "rock".\nRazpoložljive oznake: metal.'); },
    });
    const res = await fastify.inject({ method: 'POST', url: '/studio/api/podcast' });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, 'Izdelava podkasta ni uspela: V knjižnici ni skladb z žanrom "rock".');
    await fastify.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Produkcija: polna montaža vtičnika /studio (oblika iz index.js)
// ---------------------------------------------------------------------------
describe('produkcija: polna montaža /studio vtičnika', () => {
  const AUTH = { authorization: `Basic ${Buffer.from('studio:podkast-geslo').toString('base64')}` };

  async function prodApp() {
    const fastify = Fastify({ logger: false });
    await fastify.register(registerStudioRoutes, { prefix: '/studio' });
    return fastify;
  }

  test('GET /studio/api/podcast (pogodba front-enda kartice): 401 brez poverilnic, 200 z njimi', async () => {
    const fastify = await prodApp();
    const noAuth = await fastify.inject({ method: 'GET', url: '/studio/api/podcast' });
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.headers['www-authenticate'], 'Basic realm="radioclyde-studio"');

    const res = await fastify.inject({ method: 'GET', url: '/studio/api/podcast', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.running, false);
    assert.equal(body.lastEpisode, null);
    assert.deepEqual(body.episodes, []);
    await fastify.close();
  });

  test('dvojna predpona /studio/studio/api/podcast NE obstaja (regresijski pin Vala 17-b)', async () => {
    const fastify = await prodApp();
    const doubled = await fastify.inject({ method: 'GET', url: '/studio/studio/api/podcast', headers: AUTH });
    assert.equal(doubled.statusCode, 404);
    await fastify.close();
  });
});
