// Companion to nowPlayingPush.test.mjs -- this file runs in its OWN process
// (node --test isolation) with a config that has NO broadcast block at all,
// which is the shipped default (config.linux.json sets broadcast.* to null).
// It pins the disabled gate: no network call may ever happen on an
// unconfigured station, and the skip reason is explicit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('now-playing-push-disabled', {
  autoRadio: { enabled: true, stationName: 'Test FM' },
  // no broadcast block on purpose -- the gate is config.broadcast?.tuneIn / ?.discordWebhook
});

const { pushTuneIn, pushDiscord, pushNowPlaying } = await import('../src/broadcast/nowPlayingPush.js');

const TRACK = { ratingKey: 'k1', artist: 'Artist A', title: 'Song A' };
const fetchSpy = async () => {
  throw new Error('MUST NOT BE CALLED on an unconfigured station');
};

describe('unconfigured station (shipped default)', () => {
  test('TuneIn push is a no-op with an explicit skip reason', async () => {
    assert.deepEqual(await pushTuneIn(TRACK, { fetchImpl: fetchSpy }), {
      channel: 'tunein',
      skipped: 'disabled',
    });
  });

  test('Discord push is a no-op with an explicit skip reason', async () => {
    assert.deepEqual(await pushDiscord(TRACK, { fetchImpl: fetchSpy }), {
      channel: 'discord',
      skipped: 'disabled',
    });
  });

  test('the entry point performs zero network calls and reports both skips', async () => {
    const results = await pushNowPlaying({ track: TRACK, isFiller: false, fetchImpl: fetchSpy });
    assert.deepEqual(results, [
      { channel: 'tunein', skipped: 'disabled' },
      { channel: 'discord', skipped: 'disabled' },
    ]);
  });
});
