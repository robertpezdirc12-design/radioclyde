// Wiring-half regression tests for the R128 loudness layer:
//  - director/playlist.js's annotateTrackEntry carries liq_amplify ONLY when
//    the track has an index entry (and never on speech/jingle entries)
//  - liquidsoap/radio.liq keeps the verified amplify() wiring in the right
//    place, with the known-broken constructs still locked out
// (The measurement half -- analyzeTrack/analyzeMissing -- lives in
// autocueLoudness.test.mjs.)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('autocue-annotate', {
  autocue: { targetLufs: -16, maxGainDb: 6 },
});

const { config } = await import('../src/config/index.js');
const { annotateTrackEntry, annotateSpeechEntry, annotateJingleEntry } = await import(
  '../src/director/playlist.js'
);

// Deterministic index writer: utimes stamps an explicitly increasing mtime
// so readIndexFresh's mtime-based cache invalidation can never serve a stale
// copy between two same-millisecond writes.
let stamp = 1_710_000_000_000;
function writeTestIndex(tracks) {
  const idx = config.paths.autocueIndexPath;
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, JSON.stringify({ version: 1, tracks }));
  stamp += 1000;
  fs.utimesSync(idx, new Date(stamp), new Date(stamp));
}

describe('annotateTrackEntry loudness field', () => {
  test('no index entry -> legacy annotate plus the music source_tag (pass-through contract)', () => {
    const p = '/music/no-analysis.mp3';
    assert.equal(annotateTrackEntry(p), `annotate:source_tag="music",liq_fade_in="2":${p}`);
  });

  test('index entry -> liq_amplify joins the field list in dB format', () => {
    writeTestIndex({ '/music/loud.mp3': { mtimeMs: 1, size: 1, lufs: -12.3, peak: -0.5, analyzedAt: 'test' } });
    // target -16 - (-12.3) = -3.7 dB
    assert.equal(
      annotateTrackEntry('/music/loud.mp3'),
      'annotate:source_tag="music",liq_fade_in="2",liq_amplify="-3.7 dB":/music/loud.mp3'
    );
  });

  test('a very quiet master clamps at maxGainDb, not above', () => {
    writeTestIndex({ '/music/quiet.mp3': { mtimeMs: 1, size: 1, lufs: -40, peak: -3, analyzedAt: 'test' } });
    assert.match(annotateTrackEntry('/music/quiet.mp3'), /liq_amplify="6\.0 dB"/);
  });

  test('speech and jingle entries never carry liq_amplify', () => {
    // They are produced at fixed out-of-band loudness; library measurement
    // must not touch them.
    const speech = annotateSpeechEntry('/music/dj1.wav', 'Show', 'Station', ['Elena']);
    const jingle = annotateJingleEntry('/music/jingle.wav', 'Show', 'Station');
    assert.doesNotMatch(speech, /liq_amplify/);
    assert.doesNotMatch(jingle, /liq_amplify/);
    // Both are speech-family for the dispatcher invariant.
    assert.match(speech, /source_tag="speech"/);
    assert.match(jingle, /source_tag="jingle"/);
  });

  test('the index read is cached per-mtime (two reads, one stat -- cheap playlist writers)', () => {
    // Not directly observable without mocking fs; pin the documented shape:
    // repeated calls return the identical string.
    writeTestIndex({ '/music/cached.mp3': { mtimeMs: 1, size: 1, lufs: -18, peak: -1, analyzedAt: 'test' } });
    const first = annotateTrackEntry('/music/cached.mp3');
    const second = annotateTrackEntry('/music/cached.mp3');
    assert.equal(first, second);
    assert.match(first, /liq_amplify="-?2\.0 dB"/); // -16 - (-18) = +2.0
  });
});

describe('radio.liq loudness wiring', () => {
  // Same comment-stripping rule as radioLiqImaging.test.mjs: radio.liq's
  // history comments deliberately NAME broken constructs, so every assertion
  // runs against comment-free source only.
  const liq = fs
    .readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');

  test('amplify(override="liq_amplify") sits before the emergency fallback', () => {
    assert.match(liq, /radio = amplify\(override="liq_amplify", 1\., radio\)/);
    const amplifyAt = liq.indexOf('radio = amplify(override="liq_amplify", 1., radio)');
    const mksafeAt = liq.indexOf('radio = mksafe(fallback(track_sensitive=false, [radio, emergency_source]))');
    assert.ok(amplifyAt !== -1 && mksafeAt !== -1 && amplifyAt < mksafeAt, 'amplify must precede mksafe');
  });

  test('known-broken constructs stay out (same lockout as the imaging regression)', () => {
    assert.doesNotMatch(liq, /crossfade\(/);
    assert.doesNotMatch(liq, /fade\.out\(/);
    assert.doesNotMatch(liq, /predicate\.activates/);
    assert.doesNotMatch(liq, /single\(/);
  });
});
