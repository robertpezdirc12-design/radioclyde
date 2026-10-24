// Tests for P2 #8 -- listener requests reaching the air via Liquidsoap's
// request.queue (radio.liq id "requests"). Three layers, mirroring the
// feature: the radio.liq wiring (structural, same pattern as
// radioLiqImaging.test.mjs -- Liquidsoap can't run in CI), the pure
// library-match math, and the full owner action against a FAKE telnet server
// that speaks Liquidsoap's real wire protocol (command -> response + END).
//
// The fake server's reply shape ("7\nEND" for a successful push) follows the
// v2.2.4 source, verified in src/libs/request.liq (push replies with the
// numeric request id) and src/core/tools/server.ml (command/args split at
// the FIRST space, so paths with spaces survive; errors come back as
// "ERROR: ..." strings -- never mistaken for success here).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { setupTestConfig, writeWav, ratingKeyForFile, repoRoot } from './fixtures.mjs';

setupTestConfig('request-queue', {});

const { pickBestMatch, resolveRequestTrack, pushRequestTrack, queueRequest } = await import(
  '../src/liquidsoap/requestQueue.js'
);
const { appendRequest, readRequests, updateRequestStatus } = await import('../src/server/requestsStore.js');
const { lookupRatingKey } = await import('../src/plex/ratingKeyIndex.js');
const { config: liveConfig } = await import('../src/config/index.js');

// ---------------------------------------------------------------------------
// radio.liq structural wiring
// ---------------------------------------------------------------------------

const liqRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8');
const liq = liqRaw
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('radio.liq request.queue wiring', () => {
  test('request.queue source exists and rides above stingers via track_sensitive fallback', () => {
    assert.match(liq, /requests_source = request\.queue\(id="requests"\)/);
    const requestsAt = liq.indexOf('fallback(track_sensitive=true, [requests_source, radio])');
    const stingersAt = liq.indexOf('fallback(track_sensitive=true, [stinger_timed, radio])');
    assert.ok(requestsAt !== -1, 'requests fallback line present');
    assert.ok(stingersAt !== -1, 'stinger fallback line present');
    assert.ok(requestsAt < stingersAt, 'a ready listener request outranks a ready stinger at the same boundary');
  });

  test('program core, imaging layers and safety net are untouched', () => {
    assert.match(liq, /fallback\(track_sensitive=false, \[show_source, filler_source\]\)/);
    assert.match(liq, /add\(\[radio, switch\(\[\(\{0m0s\}, id_source\)\]\)\]\)/);
    assert.match(liq, /mksafe\(fallback\(track_sensitive=false, \[radio, emergency_source\]\)\)/);
    assert.match(liq, /amplify\(override="liq_amplify", 1\., radio\)/);
  });

  test('known-broken constructs on LS 2.2.4-1+dev stay out', () => {
    assert.doesNotMatch(liq, /crossfade\(/);
    assert.doesNotMatch(liq, /fade\.out\(/);
    assert.doesNotMatch(liq, /predicate\.activates/);
    assert.doesNotMatch(liq, /cross\.smart/);
  });
});

// ---------------------------------------------------------------------------
// pickBestMatch (pure matching math)
// ---------------------------------------------------------------------------

describe('pickBestMatch (library resolution)', () => {
  const catalog = [
    { ratingKey: 'a1', artist: 'Mladi Lev', title: 'Slovenski vihar', ratingCount: 500 },
    { ratingKey: 'a2', artist: 'Mladi Lev', title: 'Slovenski vihar (live)', ratingCount: 90 },
    { ratingKey: 'a3', artist: 'Tomaž Loko', title: 'Nočna.runtime', ratingCount: 10 },
    { ratingKey: 'a4', artist: 'Druga skupina', title: 'Slovenski vihar', ratingCount: 3 },
  ];

  test('requires a fold-equal title; artist is matched only when given', () => {
    assert.equal(pickBestMatch(catalog, { title: 'Slovenski vihar', artist: 'mladi lev' }).ratingKey, 'a1');
    assert.equal(pickBestMatch(catalog, { title: 'slovenski vihar', artist: '' }).ratingKey, 'a1', 'no artist -> title-only');
    assert.equal(pickBestMatch(catalog, { title: 'Slovenski vihar', artist: 'nikoli obstojel' }), null, 'wrong artist is not ignored');
  });

  test('fold bridges case and diacritics', () => {
    assert.equal(pickBestMatch(catalog, { title: 'NOČNA.RUNTIME', artist: 'Tomaž Loko' }).ratingKey, 'a3');
    assert.equal(pickBestMatch(catalog, { title: 'nocna.runtime', artist: 'tomaz loko' }).ratingKey, 'a3');
  });

  test('ties resolve by ratingCount, like dedupeByTitle keeps them station-wide', () => {
    // "Slovenski vihar (live)" does NOT fold-equal "Slovenski vihar"
    // (normalizeTitle strips parenthetical suffixes at the FILTER level, but
    // pickBestMatch compares the listener's raw text to the raw title) --
    // the true tie here is a1 vs a4 (same normalized title, two artists),
    // and artist disambiguation picks a1; without an artist, ratingCount does.
    const tie = [
      { ratingKey: 'x1', artist: 'Mladi Lev', title: 'Slovenski vihar', ratingCount: 500 },
      { ratingKey: 'x2', artist: 'Druga skupina', title: 'Slovenski vihar', ratingCount: 3 },
    ];
    assert.equal(pickBestMatch(tie, { title: 'Slovenski vihar', artist: '' }).ratingKey, 'x1');
    assert.equal(pickBestMatch(catalog, { title: 'Slovenski vihar', artist: 'druga skupina' }).ratingKey, 'a4');
  });

  test('never approximates: no title, no match, no near-misses', () => {
    assert.equal(pickBestMatch(catalog, { title: '', artist: 'Mladi Lev' }), null);
    assert.equal(pickBestMatch(catalog, { title: 'Slovensk vihar', artist: '' }), null, 'a typo must not play the wrong song');
    assert.equal(pickBestMatch(catalog, { title: 'Vihar', artist: '' }), null, 'substring is not a match');
  });
});

// ---------------------------------------------------------------------------
// fake Liquidsoap telnet + the owner action end-to-end
// ---------------------------------------------------------------------------

// Speaks the real wire shape: one command line -> <response>\nEND.
function startFakeLiquidsoap(responder) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        for (const cmd of chunk.toString('utf8').split('\n')) {
          const line = cmd.trim();
          if (!line || line === 'quit') continue;
          socket.write(`${responder(line)}\nEND\n`);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const musicDir = path.join(liveConfig.dataDir, 'music-requests');
const TRACKS = [
  { artist: 'Mladi Lev', title: 'Slovenski vihar' },
  { artist: 'Tomaž Loko', title: 'Nočna.runtime' },
  { artist: 'Dan D', title: 'Ritem plsč' },
];
for (const { artist, title } of TRACKS) {
  writeWav(path.join(musicDir, `${artist} - ${title}.wav`), 2);
}
liveConfig.autoRadio.music.localDirs = [musicDir];
fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(liveConfig, null, 2));

describe('pushRequestTrack (fake Liquidsoap telnet)', () => {
  test('pushes a bare local path, registers the scrobble index, accepts the numeric reply', async () => {
    const fake = await startFakeLiquidsoap((cmd) => (cmd.startsWith('requests.push ') ? '7' : 'ERROR: unknown command'));
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const track = { ratingKey: 'rk1234567890', artist: 'Mladi Lev', title: 'Slovenski vihar', localPath: path.join(musicDir, 'Mladi Lev - Slovenski vihar.wav') };
      const outcome = await pushRequestTrack(track);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.requestId, '7');
      assert.equal(lookupRatingKey(track.localPath), 'rk1234567890', 'scrobble index knows the request track');
    } finally {
      fake.server.close();
    }
  });

  test('a non-numeric reply is surfaced as failure, never treated as queued', async () => {
    const fake = await startFakeLiquidsoap(() => 'ERROR: queue is full');
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushRequestTrack({ ratingKey: null, artist: 'X', title: 'Y', localPath: path.join(musicDir, 'Dan D - Ritem plsč.wav') });
      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /ERROR: queue is full/);
    } finally {
      fake.server.close();
    }
  });

  test('a path with spaces survives the telnet command intact', async () => {
    let seen = null;
    const fake = await startFakeLiquidsoap((cmd) => {
      seen = cmd;
      return '11';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const p = path.join(musicDir, 'Mladi Lev - Slovenski vihar.wav');
      const outcome = await pushRequestTrack({ ratingKey: null, artist: 'Mladi Lev', title: 'Slovenski vihar', localPath: p });
      assert.equal(outcome.ok, true);
      assert.equal(seen, `requests.push ${p}`, 'v2.2.4 server.ml splits at the FIRST space -- the whole path arrives');
    } finally {
      fake.server.close();
    }
  });
});

describe('queueRequest (the whole owner action)', () => {
  async function makeRequest(overrides = {}) {
    const entry = appendRequest(
      { type: 'request', title: 'Slovenski vihar', artist: 'Mladi Lev', message: '', from: 'Test Poslušalec', ...overrides },
      '203.0.113.7'
    );
    return entry;
  }

  test('unknown id -> null; pending request is refused (moderation contract holds)', async () => {
    assert.equal(await queueRequest('does-not-exist'), null);
    const pending = await makeRequest();
    const outcome = await queueRequest(pending.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Samo odobren/);
    assert.equal(readRequests().find((r) => r.id === pending.id).note, '', 'no note written for a refusal');
  });

  test('approved + library match -> queued, note written, scrobble index registered', async () => {
    const entry = await makeRequest();
    updateRequestStatus(entry.id, 'approved', '');
    const fake = await startFakeLiquidsoap((cmd) => (cmd.startsWith('requests.push ') ? '42' : 'ERROR'));
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await queueRequest(entry.id);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.requestId, '42');
      assert.equal(outcome.track.title, 'Slovenski vihar');
      const after = readRequests().find((r) => r.id === entry.id);
      assert.equal(after.status, 'approved', 'status is never implied by queueing');
      assert.match(after.note, /predvajalni vrsti/);
      assert.match(after.note, /#42/);
      const expectedPath = path.join(musicDir, 'Mladi Lev - Slovenski vihar.wav');
      assert.equal(lookupRatingKey(expectedPath), ratingKeyForFile(expectedPath), 'request track will scrobble');
    } finally {
      fake.server.close();
    }
  });

  test('approved but not in the library -> honest note, still approved', async () => {
    const entry = await makeRequest({ title: 'Obstaja samo v sanjah', artist: 'Neznana Skupina' });
    updateRequestStatus(entry.id, 'approved', '');
    const outcome = await queueRequest(entry.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /ni v knjižnici/);
    const after = readRequests().find((r) => r.id === entry.id);
    assert.equal(after.status, 'approved');
    assert.match(after.note, /ni v knjižnici/);
  });

  test('dedication without a song title cannot be queued', async () => {
    const entry = await makeRequest({ type: 'dedication', title: '', artist: '', message: 'Oblačila za Ano' });
    updateRequestStatus(entry.id, 'approved', '');
    const outcome = await queueRequest(entry.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Posvetilo brez naslova/);
  });

  test('Liquidsoap unreachable -> honest note, still approved', async () => {
    const entry = await makeRequest();
    updateRequestStatus(entry.id, 'approved', '');
    // A port with no listener: connection refused is immediate and local.
    const dead = await startFakeLiquidsoap(() => '');
    const port = dead.port;
    dead.server.close();
    liveConfig.liquidsoap.telnetPort = port;
    const outcome = await queueRequest(entry.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /ni dosegljiv/);
    const after = readRequests().find((r) => r.id === entry.id);
    assert.equal(after.status, 'approved');
    assert.match(after.note, /ni dosegljiv/);
  });

  test('resolveRequestTrack finds real library files end-to-end', async () => {
    const track = await resolveRequestTrack({ artist: 'Tomaž Loko', title: 'nočna.runtime' });
    assert.ok(track, 'diacritic-insensitive match against the scanned library');
    assert.equal(track.localPath, path.join(musicDir, 'Tomaž Loko - Nočna.runtime.wav'));
    assert.equal(await resolveRequestTrack({ artist: '', title: 'Ni tega naslova' }), null);
  });
});
