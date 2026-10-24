// Javna "najbolj poslusano" (P5): rangiranje po listenersAvg, javna polja
// (brez ratingKey/lastMeasuredAt), postena prazna stanja, deterministika.
// Cista jedra so injektibilna; rutni test pa gre preko REALNIH datotek v
// testnem dataDir (listener-samples.jsonl + aired.jsonl).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('top-listened', {
  broadcast: { publicStreamUrl: null, tuneIn: null, discordWebhook: null },
  web: { port: 3999, publicPaths: [] },
});

const { computeTopListened, registerTopListenedRoutes } = await import('../src/server/topListenedApi.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-25T12:00:00Z');

// vzorci vsakih 30 s -- dovolj gosta pokritost za minCoverage 0.5
function samplesFor(startTs, durationMs, startListeners, endListeners) {
  const out = [];
  for (let t = startTs; t <= startTs + durationMs; t += 30_000) {
    const progress = (t - startTs) / durationMs;
    out.push({ ts: new Date(t).toISOString(), listeners: Math.round(startListeners + (endListeners - startListeners) * progress) });
  }
  return out;
}

function airedEntry(artist, title, startTs, durationMs = 5 * MIN, ratingKey = null) {
  return { ratingKey, artist, title, showId: 'test', durationMs, playedAt: new Date(startTs).toISOString() };
}

const BASE = NOW - 60 * MIN;

describe('computeTopListened (cisto jedro)', () => {
  const aired = [
    airedEntry('Punjabi MC', 'Mundian', BASE, 5 * MIN, 'k1'),
    airedEntry('Lastovke', 'Pod orientom', BASE + 10 * MIN, 5 * MIN),
    airedEntry('Buldožer', 'Novi vetrovi', BASE + 20 * MIN, 5 * MIN),
  ];
  const samples = [
    ...samplesFor(BASE, 5 * MIN, 10, 14), // najbolj poslusano: avg ~12, delta +4
    ...samplesFor(BASE + 10 * MIN, 5 * MIN, 20, 21), // avg ~20.5, delta +1
    ...samplesFor(BASE + 20 * MIN, 5 * MIN, 5, 4), // avg ~4.5, delta -1
  ];

  test('ranga po listenersAvg padajoce, neodlocene po plays', () => {
    const out = computeTopListened({ now: NOW, readAired: () => aired, readLedger: () => samples });
    assert.equal(out.measured, 3);
    assert.equal(out.windowDays, 7);
    assert.deepEqual(out.tracks.map((t) => t.title), ['Pod orientom', 'Mundian', 'Novi vetrovi']);
    assert.equal(out.tracks[0].listenersAvg, 20.5);
    assert.equal(out.note, null);
  });

  test('javna polja: brez ratingKey, brez lastMeasuredAt, brez kljucev', () => {
    const out = computeTopListened({ now: NOW, readAired: () => aired, readLedger: () => samples });
    for (const t of out.tracks) {
      assert.deepEqual(Object.keys(t).sort(), ['artist', 'avgDelta', 'listenersAvg', 'plays', 'title']);
      assert.ok(!('ratingKey' in t));
      assert.ok(!('key' in t));
    }
  });

  test('top 10 rez + deterministika bajtov', () => {
    const many = [];
    const manySamples = [];
    for (let i = 0; i < 12; i += 1) {
      const start = BASE + i * 6 * MIN;
      many.push(airedEntry(`Izvajalec ${String.fromCharCode(65 + i)}`, `Skladba ${i}`, start, 5 * MIN));
      manySamples.push(...samplesFor(start, 5 * MIN, 5 + (i % 4), 6 + (i % 4)));
    }
    const a = computeTopListened({ now: NOW, readAired: () => many, readLedger: () => manySamples });
    const b = computeTopListened({ now: NOW, readAired: () => many, readLedger: () => manySamples });
    assert.equal(a.tracks.length, 10, '12 izmerjenih -> top 10');
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'isti vhod = isti bajti');
    const avgs = a.tracks.map((t) => t.listenersAvg);
    assert.deepEqual(avgs, [...avgs].sort((x, y) => y - x), 'padajoce po listenersAvg');
  });

  test('prazna stanja: brez lederja = note, brez pokritosti = izmerjenih 0', () => {
    const empty = computeTopListened({ now: NOW, readAired: () => aired, readLedger: () => [] });
    assert.equal(empty.measured, 0);
    assert.equal(empty.tracks.length, 0);
    assert.match(empty.note, /ni izmerila/);
    // samo luknje (Icecast padel) -> ni merljivo, ampak unmeasured nosi stevilo
    const gaps = aired.map(() => ({ ts: new Date(BASE).toISOString(), listeners: null }));
    const gapOut = computeTopListened({ now: NOW, readAired: () => aired, readLedger: () => gaps });
    assert.equal(gapOut.measured, 0);
    assert.equal(gapOut.unmeasured, 3);
  });

  test('okno: starodavna predvajanja izven 7 dni ne stejejo', () => {
    const old = [airedEntry('Staro', 'Zelo staro', NOW - 30 * 24 * 60 * MIN)];
    const oldSamples = samplesFor(NOW - 30 * 24 * 60 * MIN, 5 * MIN, 50, 60);
    const out = computeTopListened({ now: NOW, readAired: () => old, readLedger: () => oldSamples });
    assert.equal(out.measured, 0);
  });
});

describe('ruta GET /api/top-listened (realne datoteke)', () => {
  test('bere leder + aired iz testnega dataDir in vrne javno obliko', async () => {
    const { config } = await import('../src/config/index.js');
    const historyDir = path.join(config.dataDir, 'history');
    fs.rmSync(historyDir, { recursive: true, force: true });
    fs.mkdirSync(historyDir, { recursive: true });
    // REALNI cas (ne fiksni NOW): ruta brez injekcije uporablja Date.now(),
    // entry v "prihodnosti" bi trackImpact pošteno izpustil.
    const start = Date.now() - 30 * MIN;
    fs.writeFileSync(
      path.join(historyDir, 'aired.jsonl'),
      airedEntry('Buldožer', 'Novi vetrovi', start, 5 * MIN, 'k9').toJSON
        ? ''
        : JSON.stringify(airedEntry('Buldožer', 'Novi vetrovi', start, 5 * MIN, 'k9')) + '\n'
    );
    fs.writeFileSync(
      path.join(historyDir, 'listener-samples.jsonl'),
      samplesFor(start, 5 * MIN, 9, 12).map((s) => JSON.stringify(s)).join('\n') + '\n'
    );
    const fastify = Fastify({ logger: false });
    registerTopListenedRoutes(fastify);
    const res = await fastify.inject({ method: 'GET', url: '/api/top-listened' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.measured, 1);
    assert.equal(body.tracks[0].title, 'Novi vetrovi');
    assert.ok(!res.body.includes('k9'), 'ratingKey ne sme na javno povrsino');
    assert.ok(!res.body.includes('lastMeasuredAt'));
    await fastify.close();
  });

  test('prazen dataDir: 200 z posteno opombo (ne 500)', async () => {
    // pocisti sledi prejsnjega testa (isti proces = isti config/dataDir)
    const { config } = await import('../src/config/index.js');
    fs.rmSync(path.join(config.dataDir, 'history'), { recursive: true, force: true });
    const fastify = Fastify({ logger: false });
    registerTopListenedRoutes(fastify);
    const res = await fastify.inject({ method: 'GET', url: '/api/top-listened' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().measured, 0);
    assert.match(res.json().note, /ni izmerila/);
    await fastify.close();
  });
});
