// Tests for external scrobbling (src/broadcast/scrobble.js) -- the SUB/WAVE
// Last.fm + ListenBrainz port. ZERO network: every fetch is a fake injected
// through fetchImpl (the same no-network contract as nowPlayingPush.test.mjs),
// the clock is pinned through nowMs/startedAt, and the session cache lives in
// throwaway tmp dirs. Matrix:
//   A. eligibility: Last.fm's rule at every boundary (29/30 s, exactly half,
//      half-1s vs the 240 s floor, unknown duration, missing artist/title),
//   B. signLastfm: pinned hand-computed md5 vectors,
//   C. the Last.fm wire: urlencoded shape, UA, 200-with-error, HTTP 500,
//      AbortError naming, scrobble/now-playing parameter sets,
//   D. the ListenBrainz wire: baseUrl normalization, playing_now vs single
//      payloads, Token header, media_player,
//   E. mobile-session auth: mint -> 0600 atomic cache -> reuse without
//      re-minting -> corrupt-cache fallback,
//   F. submitScrobbles: fail-closed listener gate, per-backend independence,
//      ineligible outgoing vs live now-playing, {dj:...} incoming, minting
//      inside the orchestration, never-throws.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('scrobble');

const { config } = await import('../src/config/index.js');
const {
  MIN_DURATION_SEC,
  MIN_ELAPSED_FLOOR_SEC,
  elapsedSeconds,
  isEligibleScrobble,
  signLastfm,
  callLastfm,
  listenbrainzApiBase,
  listenbrainzSubmitUrl,
  lastfmSessionCachePath,
  resolveLastfmSessionKey,
  lastfmUpdateNowPlaying,
  lastfmScrobble,
  listenbrainzPlayingNow,
  listenbrainzSubmit,
  submitScrobbles,
} = await import('../src/broadcast/scrobble.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'radioclyde-scrobble-'));
}

// Response stand-ins with exactly the surface the clients touch.
function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function textResponse(status, text) {
  return { ok: status >= 200 && status < 300, status, json: async () => { throw new Error('not JSON'); }, text: async () => text };
}

// A capturing fake fetch: records every (url, init, body) and answers from
// the handler (default: a plain 200 {}).
function capturingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), init, body: init?.body ?? null };
    calls.push(call);
    return handler ? handler(call, calls.length) : jsonResponse(200, {});
  };
  return { calls, fetchImpl };
}

const LASTFM_URL = 'https://ws.audioscrobbler.com/2.0/';
const UA = 'radioclyde/1.0 (+https://github.com/robertpezdirc12-design/radioclyde)';

// ---------------------------------------------------------------------------
// A. Eligibility (Last.fm's rule, SUB/WAVE scrobble-pure semantics)
// ---------------------------------------------------------------------------
describe('A. eligibility', () => {
  test('constants are SUB/WAVE\'s production values', () => {
    assert.equal(MIN_DURATION_SEC, 30);
    assert.equal(MIN_ELAPSED_FLOOR_SEC, 240);
  });

  test('a <=30 s track never scrobbles, however long it aired', () => {
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 29 }, 240), false);
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 30 }, 240), false, 'exactly 30 s is out too (<=)');
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 29 }, 1000), false);
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 31 }, 16), true, '31 s track at half (15.5) qualifies');
  });

  test('exactly half the duration qualifies (>=, not >)', () => {
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 200 }, 100), true);
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 200 }, 99), false, 'half-1s does not');
  });

  test('the 240 s floor beats the half rule for long tracks', () => {
    const t = { title: 'T', artist: 'A', durationSec: 600 };
    assert.equal(isEligibleScrobble(t, 239), false);
    assert.equal(isEligibleScrobble(t, 240), true, 'elapsed=240 qualifies even though half is 300');
  });

  test('the half rule qualifies before 240 for shorter tracks', () => {
    const t = { title: 'T', artist: 'A', durationSec: 100 };
    assert.equal(isEligibleScrobble(t, 50), true);
    assert.equal(isEligibleScrobble(t, 49), false);
  });

  test('unknown duration: only the >30 s elapsed floor applies', () => {
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: null }, 29), false);
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: null }, 30), true);
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A' }, 30), true, 'absent durationSec behaves the same');
    assert.equal(isEligibleScrobble({ title: 'T', artist: 'A', durationSec: 0 }, 29), false, 'duration 0 counts as unknown');
  });

  test('missing title or artist is never eligible (speech/jingle entries)', () => {
    assert.equal(isEligibleScrobble({ artist: 'A', durationSec: 300 }, 300), false);
    assert.equal(isEligibleScrobble({ title: 'T', durationSec: 300 }, 300), false);
    assert.equal(isEligibleScrobble(null, 300), false);
    assert.equal(isEligibleScrobble({}, 300), false);
    assert.equal(isEligibleScrobble({ dj: 'Elena' }, 300), false);
  });

  test('elapsedSeconds: 0 on missing/unparseable, floored at 0, whole seconds', () => {
    const NOW = Date.parse('2026-11-03T18:02:11Z');
    assert.equal(elapsedSeconds(null, NOW), 0);
    assert.equal(elapsedSeconds(undefined, NOW), 0);
    assert.equal(elapsedSeconds('', NOW), 0);
    assert.equal(elapsedSeconds('not a date', NOW), 0);
    assert.equal(elapsedSeconds('2026-11-03T18:00:11Z', NOW), 120);
    assert.equal(elapsedSeconds('2026-11-03T18:00:11.900Z', NOW), 119, 'floored, not rounded');
    assert.equal(elapsedSeconds('2026-11-03T19:00:11Z', NOW), 0, 'a future start (clock skew) clamps to 0');
  });
});

// ---------------------------------------------------------------------------
// B. signLastfm (authspec 2.0)
// ---------------------------------------------------------------------------
describe('B. signLastfm', () => {
  test('pinned hand-computed md5 vector; format and callback are excluded from the signature', () => {
    const params = {
      method: 'track.scrobble',
      artist: 'Nick Cave & The Bad Seeds',
      track: 'Red Right Hand',
      album: 'Let Love In',
      duration: '394',
      timestamp: '1770000000',
      api_key: 'testApiKey123',
      sk: 'testSessionKey456',
      format: 'json',
    };
    // md5("albumLet Love Inapi_keytestApiKey123artistNick Cave & The Bad Seedsduration394"
    //   + "methodtrack.scrobblesktestSessionKey456timestamp1770000000trackRed Right HandtestApiSecret789")
    assert.equal(signLastfm(params, 'testApiSecret789'), '6ea0f6208ff5309d94c3d7f54ecaf646');
    // `callback` is excluded exactly like `format` -- same signature.
    assert.equal(signLastfm({ ...params, callback: 'x' }, 'testApiSecret789'), '6ea0f6208ff5309d94c3d7f54ecaf646');
  });

  test('keys are sorted alphabetically, not in insertion order', () => {
    // md5("api_keyaaaartistAmethodtrack.updateNowPlayingskzzztrackTs3cr3t") -- sorted keys.
    assert.equal(
      signLastfm({ sk: 'zzz', api_key: 'aaa', method: 'track.updateNowPlaying', track: 'T', artist: 'A' }, 's3cr3t'),
      'b7332f18950621e7cac9f486f03a349f'
    );
  });
});

// ---------------------------------------------------------------------------
// C. callLastfm wire shape
// ---------------------------------------------------------------------------
describe('C. callLastfm wire', () => {
  const CREDS = { apiKey: 'k1', apiSecret: 's1', sessionKey: 'sk1' };

  test('POSTs urlencoded method/api_key/sk/api_sig/format with the radioclyde UA', async () => {
    const { calls, fetchImpl } = capturingFetch();
    const r = await callLastfm('track.scrobble', { artist: 'A', track: 'T', timestamp: '1770000000' }, CREDS, { fetchImpl });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, LASTFM_URL);
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(c.init.headers['user-agent'], UA);
    assert.ok(c.init.signal, 'a timeout signal is attached');
    const form = new URLSearchParams(c.body);
    assert.equal(form.get('method'), 'track.scrobble');
    assert.equal(form.get('api_key'), 'k1');
    assert.equal(form.get('sk'), 'sk1');
    assert.equal(form.get('format'), 'json');
    assert.equal(form.get('artist'), 'A');
    assert.equal(form.get('track'), 'T');
    assert.equal(form.get('timestamp'), '1770000000');
    // api_sig is the authspec md5 over exactly the sent params minus format:
    const expected = signLastfm(
      { artist: 'A', track: 'T', timestamp: '1770000000', method: 'track.scrobble', api_key: 'k1', sk: 'sk1' },
      's1'
    );
    assert.equal(form.get('api_sig'), expected);
  });

  test('HTTP 500 -> {ok:false} carrying the status and body detail, no throw', async () => {
    const { fetchImpl } = capturingFetch(() => textResponse(500, 'boom'));
    const r = await callLastfm('track.scrobble', {}, CREDS, { fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.message, /HTTP 500/);
    assert.match(r.message, /boom/);
  });

  test('a 200 whose JSON body carries an error field counts as a failure', async () => {
    const { fetchImpl } = capturingFetch(() => jsonResponse(200, { error: 6, message: 'Invalid parameters' }));
    const r = await callLastfm('track.scrobble', {}, CREDS, { fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.message, /error 6/);
    assert.match(r.message, /Invalid parameters/);
  });

  test('a non-JSON 200 body is treated as success (SUB/WAVE rule)', async () => {
    const { fetchImpl } = capturingFetch(() => textResponse(200, 'OK'));
    const r = await callLastfm('track.scrobble', {}, CREDS, { fetchImpl });
    assert.deepEqual(r, { ok: true });
  });

  test('AbortError becomes the named timeout message', async () => {
    const fetchImpl = async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    };
    const r = await callLastfm('track.scrobble', {}, CREDS, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'request timed out');
  });

  test('lastfmScrobble stamps the unix second of the track START; bad timestamps refuse locally', async () => {
    const { calls, fetchImpl } = capturingFetch();
    await lastfmScrobble(
      { title: 'T', artist: 'A', album: 'Al', durationSec: 251.4 },
      '2026-11-03T18:00:00Z',
      CREDS,
      { fetchImpl }
    );
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('method'), 'track.scrobble');
    assert.equal(form.get('timestamp'), String(Math.floor(Date.parse('2026-11-03T18:00:00Z') / 1000)));
    assert.equal(form.get('album'), 'Al');
    assert.equal(form.get('duration'), '251', 'duration rounds to whole seconds');
    const bad = await lastfmScrobble({ title: 'T', artist: 'A' }, 'not-a-date', CREDS, { fetchImpl });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /invalid start timestamp/);
    assert.equal(calls.length, 1, 'the invalid timestamp made no network call');
  });

  test('lastfmUpdateNowPlaying sends track.updateNowPlaying with no timestamp and no invented fields', async () => {
    const { calls, fetchImpl } = capturingFetch();
    await lastfmUpdateNowPlaying({ title: 'T', artist: 'A' }, CREDS, { fetchImpl });
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('method'), 'track.updateNowPlaying');
    assert.equal(form.get('timestamp'), null);
    assert.equal(form.get('duration'), null, 'no duration key when duration is unknown');
    assert.equal(form.get('album'), null, 'no album key when absent');
  });
});

// ---------------------------------------------------------------------------
// D. ListenBrainz wire shape
// ---------------------------------------------------------------------------
describe('D. ListenBrainz wire', () => {
  test('baseUrl normalization: root, full endpoint, trailing slash all land on one URL', () => {
    assert.equal(listenbrainzSubmitUrl(''), 'https://api.listenbrainz.org/1/submit-listens');
    assert.equal(listenbrainzSubmitUrl(undefined), 'https://api.listenbrainz.org/1/submit-listens');
    assert.equal(listenbrainzSubmitUrl('https://lb.example/1'), 'https://lb.example/1/submit-listens');
    assert.equal(listenbrainzSubmitUrl('https://lb.example/1/submit-listens'), 'https://lb.example/1/submit-listens');
    assert.equal(listenbrainzSubmitUrl('https://lb.example/1/'), 'https://lb.example/1/submit-listens');
    assert.equal(listenbrainzSubmitUrl('https://lb.example/1/submit-listens/'), 'https://lb.example/1/submit-listens');
    assert.equal(listenbrainzApiBase('https://api.listenbrainz.org/1'), 'https://api.listenbrainz.org/1');
  });

  test('playing_now: Token auth header, no listened_at, media_player radioclyde', async () => {
    const { calls, fetchImpl } = capturingFetch();
    const creds = { userToken: 'tok-1', baseUrl: 'https://lb.example/1' };
    const r = await listenbrainzPlayingNow(
      { title: 'Red Right Hand', artist: 'Nick Cave & The Bad Seeds', album: 'Let Love In', durationSec: 394.6 },
      creds,
      { fetchImpl }
    );
    assert.deepEqual(r, { ok: true });
    const c = calls[0];
    assert.equal(c.url, 'https://lb.example/1/submit-listens');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.Authorization, 'Token tok-1');
    assert.equal(c.init.headers['content-type'], 'application/json');
    assert.equal(c.init.headers['user-agent'], UA);
    const payload = JSON.parse(c.body);
    assert.equal(payload.listen_type, 'playing_now');
    assert.ok(Array.isArray(payload.payload) && payload.payload.length === 1);
    assert.ok(!('listened_at' in payload.payload[0]), 'playing_now carries no listened_at');
    const md = payload.payload[0].track_metadata;
    assert.equal(md.artist_name, 'Nick Cave & The Bad Seeds');
    assert.equal(md.track_name, 'Red Right Hand');
    assert.equal(md.release_name, 'Let Love In');
    assert.equal(md.additional_info.duration, 395, 'duration rounds to whole seconds');
    assert.equal(md.additional_info.media_player, 'radioclyde');
  });

  test('single: listened_at is the unix second of the START; optional fields drop out', async () => {
    const { calls, fetchImpl } = capturingFetch();
    const startedAt = '2026-11-03T18:00:00Z';
    const r = await listenbrainzSubmit({ title: 'T', artist: 'A' }, startedAt, { userToken: 'tok' }, { fetchImpl });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls[0].url, 'https://api.listenbrainz.org/1/submit-listens', 'default base when baseUrl is absent');
    const payload = JSON.parse(calls[0].body);
    assert.equal(payload.listen_type, 'single');
    assert.equal(payload.payload[0].listened_at, Math.floor(Date.parse(startedAt) / 1000));
    const md = payload.payload[0].track_metadata;
    assert.ok(!('release_name' in md), 'no album -> no release_name');
    assert.ok(!('duration' in md.additional_info), 'unknown duration -> no duration key');
    assert.equal(md.additional_info.media_player, 'radioclyde');
    const bad = await listenbrainzSubmit({ title: 'T', artist: 'A' }, 'garbage', { userToken: 'tok' }, { fetchImpl });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /invalid start timestamp/);
    assert.equal(calls.length, 1, 'the invalid timestamp made no network call');
  });

  test('HTTP 500 and network death both become {ok:false}, never throw', async () => {
    const { fetchImpl: f500 } = capturingFetch(() => textResponse(500, 'nope'));
    const r500 = await listenbrainzPlayingNow({ title: 'T', artist: 'A' }, { userToken: 'tok' }, { fetchImpl: f500 });
    assert.equal(r500.ok, false);
    assert.match(r500.message, /HTTP 500/);

    const dead = async () => { throw new Error('connect ECONNREFUSED'); };
    const rdead = await listenbrainzPlayingNow({ title: 'T', artist: 'A' }, { userToken: 'tok' }, { fetchImpl: dead });
    assert.equal(rdead.ok, false);
    assert.match(rdead.message, /ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
// E. Last.fm mobile-session auth + cache
// ---------------------------------------------------------------------------
describe('E. mobile-session auth + session cache', () => {
  function authCreds(file) {
    return { apiKey: 'k', apiSecret: 's', username: 'user', password: 'pass', sessionKeyFile: file };
  }
  // Answers only auth.getMobileSession with a fixed minted key.
  function mobileSessionFetch() {
    return capturingFetch((call) => {
      const form = new URLSearchParams(call.body);
      if (String(call.url).includes('audioscrobbler') && form.get('method') === 'auth.getMobileSession') {
        return jsonResponse(200, { session: { key: 'minted-key-1', name: 'user' } });
      }
      return jsonResponse(200, {});
    });
  }

  test('default cache path lives in dataDir', () => {
    assert.equal(lastfmSessionCachePath(), path.join(config.dataDir, 'lastfm-session.json'));
  });

  test('mints via a signed auth.getMobileSession POST and caches it 0600, atomically', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'lastfm-session.json');
    const { calls, fetchImpl } = mobileSessionFetch();
    const r = await resolveLastfmSessionKey({ ...authCreds(file), fetchImpl });
    assert.equal(r.sessionKey, 'minted-key-1');
    assert.equal(r.source, 'minted');
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, LASTFM_URL);
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers['user-agent'], UA);
    const form = new URLSearchParams(c.body);
    assert.equal(form.get('method'), 'auth.getMobileSession');
    assert.equal(form.get('username'), 'user');
    assert.equal(form.get('password'), 'pass');
    assert.equal(form.get('api_key'), 'k');
    assert.equal(form.get('format'), 'json');
    assert.ok(!form.get('sk'), 'no sk before a session exists');
    assert.equal(
      form.get('api_sig'),
      signLastfm({ username: 'user', password: 'pass', method: 'auth.getMobileSession', api_key: 'k' }, 's')
    );
    // Cache: written, mode 0600, valid JSON, no leftover tmp file (rename, not in-place).
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the session key is a live credential');
    assert.deepEqual(fs.readdirSync(dir), ['lastfm-session.json'], 'tmp-<pid> file renamed away');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionKey, 'minted-key-1');
  });

  test('a later run reuses the cache -- no re-mint, zero network calls', async () => {
    const file = path.join(tmpDir(), 'lastfm-session.json');
    const first = mobileSessionFetch();
    await resolveLastfmSessionKey({ ...authCreds(file), fetchImpl: first.fetchImpl });
    assert.equal(first.calls.length, 1);
    const second = mobileSessionFetch();
    const r = await resolveLastfmSessionKey({ ...authCreds(file), fetchImpl: second.fetchImpl });
    assert.equal(r.sessionKey, 'minted-key-1');
    assert.equal(r.source, 'cache');
    assert.equal(second.calls.length, 0, 'the cached file is preferred over minting again');
  });

  test('a sessionKey from config wins outright -- nothing minted, nothing cached', async () => {
    const file = path.join(tmpDir(), 'lastfm-session.json');
    const { calls, fetchImpl } = mobileSessionFetch();
    const r = await resolveLastfmSessionKey({ ...authCreds(file), sessionKey: 'from-config', fetchImpl });
    assert.deepEqual(r, { sessionKey: 'from-config', source: 'config' });
    assert.equal(calls.length, 0);
    assert.ok(!fs.existsSync(file));
  });

  test('a corrupt cache file falls back to re-minting and replaces it', async () => {
    const file = path.join(tmpDir(), 'lastfm-session.json');
    fs.writeFileSync(file, '{ this is not json');
    const { calls, fetchImpl } = mobileSessionFetch();
    const r = await resolveLastfmSessionKey({ ...authCreds(file), fetchImpl });
    assert.equal(r.source, 'minted');
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionKey, 'minted-key-1');
  });

  test('no sessionKey, no cache, no username/password -> null (backend skipped)', async () => {
    const { calls, fetchImpl } = mobileSessionFetch();
    const r = await resolveLastfmSessionKey(
      { apiKey: 'k', apiSecret: 's', sessionKeyFile: path.join(tmpDir(), 'absent.json'), fetchImpl }
    );
    assert.equal(r, null);
    assert.equal(calls.length, 0);
  });

  test('a failed mint returns null, caches nothing, and says so in the log', async () => {
    const file = path.join(tmpDir(), 'lastfm-session.json');
    const { fetchImpl } = capturingFetch(() => jsonResponse(200, { error: 4, message: 'Invalid credentials' }));
    const logs = [];
    const r = await resolveLastfmSessionKey({ ...authCreds(file), fetchImpl, log: (m) => logs.push(m) });
    assert.equal(r, null);
    assert.ok(!fs.existsSync(file));
    assert.ok(logs.some((m) => /auth\.getMobileSession failed/.test(m)));
  });
});

// ---------------------------------------------------------------------------
// F. submitScrobbles orchestration
// ---------------------------------------------------------------------------
describe('F. submitScrobbles', () => {
  const INCOMING = { title: 'New Track', artist: 'New Artist', album: 'New Album', durationSec: 200 };
  const OUTGOING = { title: 'Old Track', artist: 'Old Artist', album: 'Old Album', durationSec: 300 };
  const OUTGOING_STARTED = '2026-11-03T18:00:00Z';
  const NOW = Date.parse('2026-11-03T18:05:00Z'); // elapsed 300 s = full duration -> eligible
  const LF = { enabled: true, apiKey: 'k', apiSecret: 's', sessionKey: 'sk-fixed', username: '', password: '' };
  const LB = { enabled: true, userToken: 'lb-token', baseUrl: '' };

  function okFetch() {
    return capturingFetch(() => jsonResponse(200, {}));
  }

  test('listener gate fails closed: null skips everything', async () => {
    const { calls, fetchImpl } = okFetch();
    const logs = [];
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: null, nowMs: NOW, fetchImpl, log: (m) => logs.push(m),
    });
    assert.equal(r.skipped, 'listeners');
    assert.equal(calls.length, 0, 'no network at all on an unknown count');
    assert.ok(logs.some((m) => /scrobble: skip/.test(m)));
  });

  test('listener gate: undefined (fetch failed) skips too', async () => {
    const { calls, fetchImpl } = okFetch();
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: undefined, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.skipped, 'listeners');
    assert.equal(calls.length, 0);
  });

  test('listener gate: 0 listeners skips (same rule the Plex gate uses)', async () => {
    const { calls, fetchImpl } = okFetch();
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: 0, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.skipped, 'listeners');
    assert.equal(calls.length, 0);
  });

  test('1 listener proceeds: now-playing on the incoming + scrobble on the outgoing, both backends', async () => {
    const { calls, fetchImpl } = okFetch();
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: 1, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.skipped, null);
    assert.deepEqual(r.backends, ['lastfm', 'listenbrainz']);
    assert.equal(r.eligible, true);
    assert.equal(r.elapsed, 300);
    assert.deepEqual(r.nowPlaying.map((x) => [x.backend, x.ok]), [['lastfm', true], ['listenbrainz', true]]);
    assert.deepEqual(r.submit.map((x) => [x.backend, x.ok]), [['lastfm', true], ['listenbrainz', true]]);
    assert.equal(calls.length, 4, 'now-playing x2 + scrobble x2');
    const lfSubmit = calls.find((c) => String(c.url).includes('audioscrobbler') && /method=track\.scrobble/.test(String(c.body)));
    const ts = String(Math.floor(Date.parse(OUTGOING_STARTED) / 1000));
    assert.equal(new URLSearchParams(lfSubmit.body).get('timestamp'), ts, 'Last.fm timestamp = track START');
    const lbSubmit = calls.find((c) => String(c.url).includes('listenbrainz') && JSON.parse(c.body).listen_type === 'single');
    assert.equal(JSON.parse(lbSubmit.body).payload[0].listened_at, Number(ts), 'LB listened_at = same START second');
    const lbNow = calls.find((c) => String(c.url).includes('listenbrainz') && JSON.parse(c.body).listen_type === 'playing_now');
    assert.equal(JSON.parse(lbNow.body).payload[0].track_metadata.track_name, 'New Track');
  });

  test('backends are independent: a dead last.fm cannot take ListenBrainz down', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('audioscrobbler')) throw new Error('connect ETIMEDOUT');
      return jsonResponse(200, {});
    };
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: 3, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.skipped, null);
    assert.equal(r.nowPlaying.find((x) => x.backend === 'lastfm').ok, false);
    assert.match(r.nowPlaying.find((x) => x.backend === 'lastfm').message, /ETIMEDOUT/);
    assert.equal(r.nowPlaying.find((x) => x.backend === 'listenbrainz').ok, true);
    assert.equal(r.submit.find((x) => x.backend === 'lastfm').ok, false);
    assert.equal(r.submit.find((x) => x.backend === 'listenbrainz').ok, true);
  });

  test('an ineligible outgoing sends no scrobble, but the incoming now-playing still goes out', async () => {
    const { calls, fetchImpl } = okFetch();
    const shortElapsed = '2026-11-03T18:04:00Z'; // 60 s of a 300 s track: under half, under 240
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: shortElapsed, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: 2, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.eligible, false);
    assert.deepEqual(r.submit, []);
    assert.equal(calls.filter((c) => /track\.scrobble|listen_type..single/.test(String(c.body))).length, 0, 'no submit anywhere');
    assert.equal(r.nowPlaying.length, 2, 'now-playing still sent');
    assert.equal(calls.length, 2);
  });

  test('a {dj:...} incoming sends no now-playing; the outgoing submit is unaffected', async () => {
    const { calls, fetchImpl } = okFetch();
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: { dj: 'Elena' },
      lastfm: LF, listenbrainz: LB, listenerCount: 1, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.nowPlaying, null, 'speech is not a now-playing entry');
    assert.equal(r.submit.length, 2, 'the outgoing scrobble still went to both backends');
    assert.equal(calls.length, 2);
  });

  test('no credentials at all -> skipped no-backends, zero calls', async () => {
    const { calls, fetchImpl } = okFetch();
    const logs = [];
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: { enabled: true }, listenbrainz: { enabled: true }, listenerCount: 1, nowMs: NOW,
      fetchImpl, log: (m) => logs.push(m),
    });
    assert.equal(r.skipped, 'no-backends');
    assert.equal(calls.length, 0);
    assert.ok(logs.some((m) => /last\.fm/.test(m)));
    assert.ok(logs.some((m) => /listenbrainz/.test(m)));
  });

  test('disabled backends are skipped silently even with credentials present', async () => {
    const { calls, fetchImpl } = okFetch();
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: { ...LF, enabled: false }, listenbrainz: { ...LB, enabled: false },
      listenerCount: 1, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.skipped, 'no-backends');
    assert.equal(calls.length, 0);
  });

  test('mints the session inside the orchestration and scrobbles with the minted key', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'lastfm-session.json');
    const { calls, fetchImpl } = capturingFetch((call) => {
      const form = new URLSearchParams(call.body);
      if (form.get('method') === 'auth.getMobileSession') {
        return jsonResponse(200, { session: { key: 'orchestrated-key', name: 'user' } });
      }
      return jsonResponse(200, {});
    });
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: { enabled: true, apiKey: 'k', apiSecret: 's', sessionKey: '', username: 'user', password: 'pass' },
      listenbrainz: null, listenerCount: 1, nowMs: NOW, fetchImpl, sessionKeyFile: file,
    });
    assert.equal(r.skipped, null);
    assert.equal(calls.length, 3, 'one mint + now-playing + scrobble');
    assert.equal(new URLSearchParams(calls[0].body).get('method'), 'auth.getMobileSession', 'the mint happens before any write');
    for (const c of calls.slice(1)) {
      assert.equal(new URLSearchParams(c.body).get('sk'), 'orchestrated-key', 'writes carry the minted session key');
    }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionKey, 'orchestrated-key', 'minted key cached for the next track');
  });

  test('never throws: a fully dead network still returns a result object', async () => {
    const fetchImpl = async () => { throw new Error('network down'); };
    const r = await submitScrobbles({
      outgoing: OUTGOING, outgoingStartedAt: OUTGOING_STARTED, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: 1, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.skipped, null);
    assert.ok(r.nowPlaying.every((x) => x.ok === false));
    assert.ok(r.submit.every((x) => x.ok === false));
  });

  test('no outgoing (first track after boot) still sends the incoming now-playing', async () => {
    const { calls, fetchImpl } = okFetch();
    const r = await submitScrobbles({
      outgoing: null, outgoingStartedAt: null, incoming: INCOMING,
      lastfm: LF, listenbrainz: LB, listenerCount: 1, nowMs: NOW, fetchImpl,
    });
    assert.equal(r.submit, null);
    assert.equal(r.nowPlaying.length, 2);
    assert.equal(calls.length, 2);
  });
});
