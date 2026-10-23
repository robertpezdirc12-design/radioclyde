// Tests for the external now-playing pushes (src/broadcast/nowPlayingPush.js).
// Both channels are config-gated no-ops by default -- these tests pin that
// gate (no accidental webhook spam on an unconfigured station), the TuneIn
// URL contract, the Discord payload shape, the filler routing rule (TuneIn
// hears everything, Discord only curated show tracks), and the
// never-throws-on-network-failure guarantee, using an injected fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('now-playing-push', {
  broadcast: {
    tuneIn: { partnerId: 'pid123', partnerKey: 'pkey456', stationId: 'st789' },
    discordWebhook: 'https://discord.com/api/webhooks/123/abc',
    publicStreamUrl: 'https://radio.example/stream',
  },
  autoRadio: { enabled: true, stationName: 'Test FM' },
});

const { tuneInUrl, pushTuneIn, pushDiscord, pushNowPlaying } = await import(
  '../src/broadcast/nowPlayingPush.js'
);

const TRACK = { ratingKey: 'k1', artist: 'Artist A', title: 'Song A', album: 'Album' };

describe('TuneIn AIR push', () => {
  test('URL carries the documented Playing.ashx contract, URL-encoded', () => {
    const url = tuneInUrl({ ...TRACK, title: 'Song: A/B + C' });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'http://air.radiotime.com/Playing.ashx');
    assert.equal(u.searchParams.get('partnerId'), 'pid123');
    assert.equal(u.searchParams.get('partnerKey'), 'pkey456');
    assert.equal(u.searchParams.get('id'), 'st789');
    assert.equal(u.searchParams.get('title'), 'Song: A/B + C');
    assert.equal(u.searchParams.get('artist'), 'Artist A');
  });

  test('success and non-200 both return result objects, never throw', async () => {
    const ok = await pushTuneIn(TRACK, { fetchImpl: async () => ({ ok: true, status: 200 }) });
    assert.deepEqual(ok, { channel: 'tunein', ok: true });

    const bad = await pushTuneIn(TRACK, { fetchImpl: async () => ({ ok: false, status: 403 }) });
    assert.deepEqual(bad, { channel: 'tunein', ok: false, status: 403 });

    const dead = await pushTuneIn(TRACK, {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    assert.equal(dead.ok, false);
    assert.match(dead.error, /ECONNREFUSED/);
  });
});

describe('Discord webhook push', () => {
  test('posts the station-branded embed, no invented art or counts', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 204 };
    };
    const result = await pushDiscord(TRACK, { fetchImpl });
    assert.deepEqual(result, { channel: 'discord', ok: true });
    assert.equal(captured.url, 'https://discord.com/api/webhooks/123/abc');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['content-type'], 'application/json');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.username, 'Test FM');
    assert.equal(body.embeds[0].title, 'Artist A — Song A');
    assert.equal(body.embeds[0].description, 'Zdaj predvajamo');
    assert.equal(body.content, 'https://radio.example/stream', 'publicStreamUrl becomes the invite link');
    assert.ok(!('image' in body.embeds[0]), 'no fabricated artwork URL');
  });

  test('network failure returns a result object, never throws', async () => {
    const result = await pushDiscord(TRACK, {
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOTFOUND/);
  });
});

describe('routing + gating (pushNowPlaying entry point)', () => {
  test('filler goes to TuneIn but never to Discord', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200 };
    };
    const results = await pushNowPlaying({ track: TRACK, isFiller: true, fetchImpl });
    assert.equal(results.filter((r) => r.channel === 'tunein' && r.ok).length, 1, 'TuneIn got the filler track');
    assert.deepEqual(
      results.find((r) => r.channel === 'discord'),
      { channel: 'discord', skipped: 'filler' },
      'Discord is skipped for filler, with the reason recorded'
    );
    assert.equal(calls.length, 1, 'exactly one network call happened (TuneIn only)');
  });

  test('a show track reaches both channels; dead TuneIn cannot block Discord', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (url.includes('radiotime.com')) throw new Error('timeout');
      return { ok: true, status: 204 };
    };
    const results = await pushNowPlaying({ track: TRACK, isFiller: false, fetchImpl });
    assert.equal(results.find((r) => r.channel === 'tunein').ok, false);
    assert.equal(results.find((r) => r.channel === 'discord').ok, true);
    assert.equal(calls.length, 2);
  });
});
