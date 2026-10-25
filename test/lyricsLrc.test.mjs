// Tests for the "Besedila" backend's pure halves: the LRC parser
// (src/lyrics/lrc.js) and the LRCLIB client's matching + etiquette
// (src/lyrics/lrclib.js). Every network/clock/sleep seam is injected, so no
// test ever contacts the real lrclib.net and no test waits a real 5 s retry
// delay -- the client's clock and sleep are a virtual clock that advances by
// the slept amount, making the 1100 ms throttle gap and the [5000, 15000] ms
// retry windows observable as plain numbers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('lyrics-lrc', {});

const { parseLrc, plainLines, isRestMarker, recordToLyrics } = await import('../src/lyrics/lrc.js');
const {
  leadArtist,
  searchTitle,
  fold,
  bestSearchMatch,
  createLrclibClient,
} = await import('../src/lyrics/lrclib.js');

// ---------- helpers ----------

// A clock whose sleep() just advances it -- deterministic, zero real time.
function virtualClock(start = 1_000_000) {
  let nowMs = start;
  const slept = [];
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      slept.push(ms);
      nowMs += ms;
    },
    slept,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? headers['Retry-After'] ?? null : null) },
    body: undefined,
    json: async () => body,
  };
}

// ---------- LRC parsing ----------

describe('LRC parsing (lrc.js)', () => {
  test('single stamps, multi-timestamp chorus lines, stable sort', () => {
    const out = parseLrc('[00:12.34]a line\n[00:12.34][01:02.00]chorus');
    assert.deepEqual(out.lines, [
      { startMs: 12340, text: 'a line' },
      { startMs: 12340, text: 'chorus' },
      { startMs: 62000, text: 'chorus' },
    ]);
    assert.equal(out.synced, true);
  });

  test('fraction digit count is its unit: .5 tenths, .50 centiseconds, .500 ms', () => {
    const out = parseLrc('[00:01.5]x\n[00:02.50]y\n[00:03.500]z\n[00:04.75]w');
    assert.deepEqual(out.lines.map((l) => l.startMs), [1500, 2500, 3500, 4750]);
  });

  test('[offset:+N] shifts earlier (clamped at 0); negative shifts later', () => {
    const earlier = parseLrc('[offset:+250]\n[00:01.000]a\n[00:00.100]b');
    assert.deepEqual(earlier.lines.map((l) => l.startMs), [0, 750]);
    const later = parseLrc('[offset:-500]\n[00:01.000]a');
    assert.deepEqual(later.lines.map((l) => l.startMs), [1500]);
  });

  test('metadata tags drop; unstamped text stays untimed (startMs null) and sinks to the end', () => {
    const out = parseLrc('[ti:Title]\nplain intro\n[00:05.00]timed\noutro line');
    assert.deepEqual(out.lines, [
      { startMs: 5000, text: 'timed' },
      { startMs: null, text: 'plain intro' },
      { startMs: null, text: 'outro line' },
    ]);
  });

  test('rest lines: empty text, note glyphs and instrumental markers keep the stamp, text empty', () => {
    const out = parseLrc(
      '[00:01.00]\n[00:02.00]\u266A\n[00:03.00]\u266A \u266A \u266A\n[00:04.00](instrumental)\n[00:05.00][au: instrumental]\n[00:06.00]real words'
    );
    assert.deepEqual(out.lines, [
      { startMs: 1000, text: '' },
      { startMs: 2000, text: '' },
      { startMs: 3000, text: '' },
      { startMs: 4000, text: '' },
      { startMs: 5000, text: '' },
      { startMs: 6000, text: 'real words' },
    ]);
  });

  test('word-level stamps strip; whitespace collapses', () => {
    const out = parseLrc('[00:01.00]a <00:01.20>word <00:01.40>line');
    assert.deepEqual(out.lines, [{ startMs: 1000, text: 'a word line' }]);
  });

  test('bodies with no stamped line, empty or non-string input are null', () => {
    assert.equal(parseLrc('just text\nno stamps'), null);
    assert.equal(parseLrc(''), null);
    assert.equal(parseLrc(null), null);
    assert.equal(parseLrc('[offset:+100]\n[ar:X]'), null);
  });

  test('isRestMarker: empty / glyphs / instrumental spellings yes, sung words no', () => {
    for (const yes of ['', '   ', '\u266A', '\u266A \u266B \u266A', '(instrumental)', 'Instrumental', '[au: instrumental]']) {
      assert.equal(isRestMarker(yes), true, JSON.stringify(yes));
    }
    for (const no of ['The instrumental part', 'AC/DC', 'prva vrstica']) {
      assert.equal(isRestMarker(no), false, JSON.stringify(no));
    }
  });

  test('plainLines: non-empty lines untimed; markers drop; all-marker body is null', () => {
    assert.deepEqual(plainLines('first\n\n\u266A\n(instrumental)\nsecond').lines, [
      { startMs: null, text: 'first' },
      { startMs: null, text: 'second' },
    ]);
    assert.equal(plainLines('\u266A\n(instrumental)'), null);
    assert.equal(plainLines(''), null);
    assert.equal(plainLines(null), null);
  });

  test('recordToLyrics precedence: synced > instrumental (one whole-track rest) > plain > null', () => {
    assert.deepEqual(recordToLyrics({ syncedLyrics: '[00:01.00]x', instrumental: true }).lines, [
      { startMs: 1000, text: 'x' },
    ]);
    assert.deepEqual(recordToLyrics({ instrumental: true }), { synced: true, lines: [{ startMs: 0, text: '' }] });
    const plain = recordToLyrics({ plainLyrics: 'a\nb' });
    assert.equal(plain.synced, false);
    assert.deepEqual(plain.lines, [
      { startMs: null, text: 'a' },
      { startMs: null, text: 'b' },
    ]);
    assert.equal(recordToLyrics(null), null);
    assert.equal(recordToLyrics({}), null);
  });
});

// ---------- matching ----------

describe('candidate matching (lrclib.js)', () => {
  test('leadArtist splits on feat/ft/featuring/with/x/&/comma/semicolon, never a bare slash', () => {
    assert.equal(leadArtist('Skrillex Feat. Chief Keef, Corbin'), 'Skrillex');
    assert.equal(leadArtist('Buldo\u017Eer ft. Bele vrane'), 'Buldo\u017Eer');
    assert.equal(leadArtist('A featuring B'), 'A');
    assert.equal(leadArtist('A with B'), 'A');
    assert.equal(leadArtist('A x B'), 'A');
    assert.equal(leadArtist('A & B'), 'A');
    assert.equal(leadArtist('A; B'), 'A');
    assert.equal(leadArtist('AC/DC'), 'AC/DC');
  });

  test('searchTitle strips only the (feat. ...) credits, remix tags stay', () => {
    assert.equal(searchTitle('Superman (feat. X) [Remix]'), 'Superman [Remix]');
    assert.equal(searchTitle('Tema'), 'Tema');
  });

  test('fold: NFKD + lowercase + non letter/number stripped', () => {
    assert.equal(fold('\u017Durka!'), 'zurka');
    assert.equal(fold('AC-DC'), 'acdc');
  });

  test('bestSearchMatch: +-2 s gate, NFKD agreement, synced > instrumental > plain', () => {
    const track = { artist: 'Ansambel', title: 'Tema', durationSec: 187 };
    const results = [
      { trackName: 'Tema (live)', artistName: 'Ansambel', duration: 300, syncedLyrics: 'x' }, // wrong cut
      { trackName: 'Tema', artistName: 'Ansambel', duration: 189, plainLyrics: 'x' }, // in tolerance, plain
      { trackName: 'T\u00E9ma', artistName: 'Ansambel', duration: 186, syncedLyrics: 'x' }, // NFKD match, synced
      { trackName: 'Druga', artistName: 'Ansambel', duration: 187, syncedLyrics: 'x' }, // wrong title
    ];
    assert.equal(bestSearchMatch(results, track), results[2]);
    // boundary: exactly +2 s in, +3 s out
    assert.equal(bestSearchMatch([{ trackName: 'Tema', artistName: 'Ansambel', duration: 189, plainLyrics: 'x' }], track) !== null, true);
    assert.equal(bestSearchMatch([{ trackName: 'Tema', artistName: 'Ansambel', duration: 190, syncedLyrics: 'x' }], track), null);
    // no duration on the result = no gate at all
    assert.equal(bestSearchMatch([{ trackName: 'Tema', artistName: 'Ansambel', syncedLyrics: 'x' }], track), null);
    // instrumental beats plain among matches
    assert.equal(
      bestSearchMatch(
        [
          { trackName: 'Tema', artistName: 'Ansambel', duration: 187, plainLyrics: 'x' },
          { trackName: 'Tema', artistName: 'Ansambel', duration: 187, instrumental: true },
        ],
        track
      ).instrumental,
      true
    );
    assert.equal(bestSearchMatch([], track), null);
    assert.equal(bestSearchMatch(null, track), null);
  });
});

// ---------- client etiquette (no network, virtual clock) ----------

describe('LRCLIB client (injected fetch, virtual clock)', () => {
  const TRACK = { artist: 'Ansambel', title: 'Tema', album: 'Album', durationSec: 187.4 };

  test('search-first request shape: /api/search, lead artist, stripped title, album only when known, self-naming UA', async () => {
    const seen = [];
    const client = createLrclibClient({
      baseUrl: 'https://lrclib.example/',
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: init.headers });
        return jsonResponse([{ trackName: 'Tema', artistName: 'Ansambel', duration: 187, syncedLyrics: '[00:01.00]x', id: 9 }]);
      },
      now: virtualClock().now,
      sleep: virtualClock().sleep,
    });
    const record = await client.find(TRACK);
    assert.equal(seen.length, 1, 'one lenient search, no /api/get');
    const u = new URL(seen[0].url);
    assert.equal(u.origin + u.pathname, 'https://lrclib.example/api/search');
    assert.equal(u.searchParams.get('artist_name'), 'Ansambel');
    assert.equal(u.searchParams.get('track_name'), 'Tema');
    assert.equal(u.searchParams.get('album_name'), 'Album');
    assert.equal(u.searchParams.get('duration'), '187');
    assert.equal(seen[0].headers['User-Agent'], 'radioclyde/1.0 (+https://github.com/robertpezdirc12-design/radioclyde)');
    assert.equal(record.id, 9);

    // An unknown album is ABSENT, not an empty param that would filter.
    const seen2 = [];
    const bare = createLrclibClient({
      baseUrl: 'https://lrclib.example',
      fetchImpl: async (url) => {
        seen2.push(String(url));
        return jsonResponse([]);
      },
      now: virtualClock().now,
      sleep: virtualClock().sleep,
    });
    assert.equal(await bare.find({ artist: 'Ansambel', title: 'Tema', durationSec: 187 }), null);
    assert.equal(new URL(seen2[0]).searchParams.get('album_name'), null);
  });

  test('no lookup at all without duration > 0, artist or title', async () => {
    let calls = 0;
    const client = createLrclibClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse([]);
      },
    });
    assert.equal(await client.find({ artist: 'A', title: 'T', durationSec: 0 }), null);
    assert.equal(await client.find({ artist: 'A', title: 'T', durationSec: -5 }), null);
    assert.equal(await client.find({ artist: '', title: 'T', durationSec: 100 }), null);
    assert.equal(await client.find({ artist: 'A', title: null, durationSec: 100 }), null);
    assert.equal(calls, 0);
  });

  test('404 and 400 are definitive misses: null after exactly one request', async () => {
    for (const status of [404, 400]) {
      let calls = 0;
      const client = createLrclibClient({
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(null, status);
        },
        now: virtualClock().now,
        sleep: virtualClock().sleep,
      });
      assert.equal(await client.find(TRACK), null);
      assert.equal(calls, 1, `HTTP ${status} retried exactly zero times`);
    }
  });

  test('503/429 retried exactly twice with [5000, 15000] waits, then throws "ask later"', async () => {
    for (const status of [503, 429]) {
      const clock = virtualClock();
      let calls = 0;
      const client = createLrclibClient({
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({}, status);
        },
        now: clock.now,
        sleep: clock.sleep,
      });
      await assert.rejects(() => client.find(TRACK), (err) => /refused/i.test(err.message));
      assert.equal(calls, 3, `HTTP ${status}: initial try + exactly two retries`);
      assert.deepEqual(clock.slept, [5000, 15000]);
    }
  });

  test('Retry-After stretches the wait (max of delay and header), capped at 30 s', async () => {
    const clock = virtualClock();
    let calls = 0;
    const client = createLrclibClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, 429, { 'Retry-After': '20' }); // 20 s -> 20000 ms wins over 5000
        return jsonResponse([{ trackName: 'Tema', artistName: 'Ansambel', duration: 187, plainLyrics: 'x' }]);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const record = await client.find(TRACK);
    assert.equal(record.plainLyrics, 'x');
    assert.deepEqual(clock.slept, [20000]);

    const capped = virtualClock();
    let cappedCalls = 0;
    const cappedClient = createLrclibClient({
      fetchImpl: async () => {
        cappedCalls += 1;
        if (cappedCalls === 1) return jsonResponse({}, 503, { 'Retry-After': '60' }); // 60 s capped at 30 s
        return jsonResponse([]);
      },
      now: capped.now,
      sleep: capped.sleep,
    });
    assert.equal(await cappedClient.find(TRACK), null);
    assert.deepEqual(capped.slept, [30000]);
  });

  test('a refusal that clears on the second try answers; only one retry delay slept', async () => {
    const clock = virtualClock();
    let calls = 0;
    const client = createLrclibClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, 503);
        return jsonResponse([{ trackName: 'Tema', artistName: 'Ansambel', duration: 187, syncedLyrics: '[00:01.00]x' }]);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const record = await client.find(TRACK);
    assert.ok(record.syncedLyrics);
    assert.equal(calls, 2);
    assert.deepEqual(clock.slept, [5000]);
  });

  test('throttle: concurrent lookups space request STARTS by MIN_GAP_MS (1100)', async () => {
    const clock = virtualClock();
    const starts = [];
    const client = createLrclibClient({
      fetchImpl: async () => {
        starts.push(clock.now());
        return jsonResponse([{ trackName: 'T', artistName: 'A', duration: 100, plainLyrics: 'x' }]);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const one = client.find({ artist: 'A', title: 'One', durationSec: 100 });
    const two = client.find({ artist: 'A', title: 'Two', durationSec: 100 });
    await Promise.all([one, two]);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 1100, `request starts ${starts[1] - starts[0]} ms apart`);
    assert.ok(clock.slept.includes(1100), 'the gap was actually slept');
  });

  test('a rejected link never poisons the queue behind it', async () => {
    const clock = virtualClock();
    let calls = 0;
    const client = createLrclibClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transport down');
        return jsonResponse([{ trackName: 'T', artistName: 'A', duration: 100, plainLyrics: 'x' }]);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const doomed = client.find({ artist: 'A', title: 'One', durationSec: 100 });
    const fine = client.find({ artist: 'A', title: 'Two', durationSec: 100 });
    await assert.rejects(() => doomed, /transport down/);
    assert.ok((await fine).plainLyrics);
    assert.equal(calls, 2);
  });

  test('timeout bounds the request and the stalled body (body deadline)', async () => {
    // real (short) 20 ms deadline on the fetch itself
    const hanging = createLrclibClient({
      fetchImpl: (url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      timeoutMs: 20,
    });
    await assert.rejects(() => hanging.find(TRACK), /aborted/);

    // and on the body read: headers arrive, json() stalls, abort fires
    const stallingBody = createLrclibClient({
      fetchImpl: (url, init) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: undefined,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => reject(new Error('body stalled')));
            }),
        }),
      timeoutMs: 20,
    });
    await assert.rejects(() => stallingBody.find(TRACK), /body stalled/);
  });
});
