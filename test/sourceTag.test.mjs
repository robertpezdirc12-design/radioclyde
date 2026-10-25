// source_tag contract tests -- the Node half of the cookbook's source_tag
// dispatch pattern (docs/ready-made-scripts-analysis.md §2.5, integration row
// #5). Every m3u entry this repo writes must carry exactly one source_tag;
// the future radio.liq dispatcher's single rule ("either side not music ->
// hard cut") only stays correct if the tag set is closed and only "music"
// marks music-family audio.
//
// Honest scope note, same as the doc: nothing on Liquidsoap 2.2.4 READS the
// field yet (the dispatch half needs cross() and live verification on the
// station box) -- these tests pin the data that makes that half a pure
// consumer when it lands.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav } from './fixtures.mjs';

setupTestConfig('source-tag', {
  imaging: { checkIntervalMinutes: 30 },
});

const { config } = await import('../src/config/index.js');
const { SOURCE_TAG, annotateTrackEntry, annotateSpeechEntry, annotateJingleEntry } = await import(
  '../src/director/playlist.js'
);
const { LAYER_TAGS, writeImagingPlaylists } = await import('../src/scheduler/imagingPlaylists.js');

const ALL_TAGS = [...Object.values(SOURCE_TAG), ...Object.values(LAYER_TAGS)];

describe('closed tag set', () => {
  test('the allowed tags are exactly the documented seven', () => {
    assert.deepEqual([...ALL_TAGS].sort(), ['emergency', 'id', 'jingle', 'music', 'promo', 'speech', 'stinger']);
  });

  test('only "music" is music-family (the dispatcher invariant)', () => {
    const nonMusic = ALL_TAGS.filter((t) => t !== SOURCE_TAG.music);
    // The one rule the dispatcher will ever apply: anything that is not
    // exactly "music" must hard-cut. If someone adds a new music-family tag
    // (e.g. "jingle-music"), this test forces a conversation.
    assert.ok(nonMusic.length >= 6, 'speech family must stay explicitly enumerated');
    for (const tag of nonMusic) {
      assert.notEqual(tag, SOURCE_TAG.music);
    }
  });

  test('tag values are annotate-safe constants (no quotes, backslashes, or colons)', () => {
    for (const tag of ALL_TAGS) {
      assert.match(tag, /^[a-z]+$/, `tag "${tag}" must be bare lowercase letters`);
    }
  });
});

describe('every writer tags its entries', () => {
  test('annotateTrackEntry -> source_tag="music" (with and without liq_amplify)', () => {
    const line = annotateTrackEntry('/music/x.mp3');
    assert.match(line, /^annotate:source_tag="music",/);
    assert.match(line, /liq_fade_in="2"/);
  });

  test('annotateSpeechEntry -> source_tag="speech" first, dj field preserved', () => {
    const line = annotateSpeechEntry('/show/speech.wav', 'Show', 'Station', ['Elena', 'Adrian']);
    assert.match(line, /^annotate:source_tag="speech",liq_fade_in="0",/);
    assert.match(line, /dj="Elena & Adrian"/);
    // Bare call (no title/station/personas): still tagged, still hard-cut.
    const minimal = annotateSpeechEntry('/show/speech.wav');
    assert.match(minimal, /^annotate:source_tag="speech",liq_fade_in="0":/);
  });

  test('annotateJingleEntry -> source_tag="jingle", now ALWAYS an annotate line', () => {
    // Behavioral change pinned deliberately: before source_tag, a jingle
    // without title/station was a bare path. The dispatcher contract needs
    // every entry tagged, so the bare-path form is gone.
    const bare = annotateJingleEntry('/show/jingle.wav');
    assert.equal(bare, 'annotate:source_tag="jingle":/show/jingle.wav');
    const full = annotateJingleEntry('/show/jingle.wav', 'Show', 'Station');
    assert.match(full, /^annotate:source_tag="jingle",title="Show",artist="Station":/);
  });

  test('imaging playlists carry their per-layer tags (id/stinger/promo/emergency)', () => {
    fs.mkdirSync(config.paths.imagingIdDir, { recursive: true });
    fs.mkdirSync(config.paths.imagingStingerDir, { recursive: true });
    fs.mkdirSync(config.paths.imagingPromosDir, { recursive: true });
    fs.mkdirSync(config.paths.imagingEmergencyDir, { recursive: true });
    writeWav(path.join(config.paths.imagingIdDir, 'id1.wav'));
    writeWav(path.join(config.paths.imagingStingerDir, 'st1.wav'));
    writeWav(path.join(config.paths.imagingPromosDir, 'promo1.wav'));
    writeWav(path.join(config.paths.imagingEmergencyDir, 'em1.wav'));
    writeImagingPlaylists();

    const cases = [
      { file: config.paths.imagingIdPath, tag: LAYER_TAGS.id },
      { file: config.paths.imagingStingerPath, tag: LAYER_TAGS.stingers },
      { file: config.paths.imagingPromosPath, tag: LAYER_TAGS.promos },
      { file: config.paths.imagingEmergencyPath, tag: LAYER_TAGS.emergency },
    ];
    for (const { file, tag } of cases) {
      const line = fs.readFileSync(file, 'utf8').trim();
      assert.match(line, new RegExp(`^annotate:source_tag="${tag}",liq_fade_in="0":`));
    }
  });
});
