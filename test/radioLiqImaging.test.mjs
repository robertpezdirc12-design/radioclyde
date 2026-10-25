// radio.liq imaging-layer structural regression: Liquidsoap can't run in CI,
// so (same pattern as the scheduler ?. regression) the test scans the script's
// SOURCE and pins the wiring that the live stream depends on.
//
// It guards two directions:
//  - PRESENT: the four imaging layers and their exact verified semantics
//    (overlay switch for the hour ID, delay() + track_sensitive fallback for
//    stingers AND promos, emergency playlist below the program, mksafe still
//    last)
//  - ABSENT: the constructs that are known-broken on this Liquidsoap build
//    (2.2.4-1+dev) and must not creep back in a refactor
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from './fixtures.mjs';

const liqRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8');
// Strip Liquidsoap comments before matching: radio.liq's history comments
// deliberately NAME the broken constructs ("Tried crossfade() here...", "NOT
// wrapped in fade.out()") -- those mentions are documentation, not code, so
// every assertion below must run against comment-free source only.
const liq = liqRaw
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

// The install.sh heredoc copy (same read as radioLiqIcy.test.mjs /
// clockwheel.test.mjs: shell # comments and Liquidsoap # comments strip the
// same way, and the heredoc is single-quoted so nothing is shell-expanded).
const installSh = fs
  .readFileSync(path.join(repoRoot(), 'deploy', 'ubuntu', 'install.sh'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('radio.liq imaging layer structure', () => {
  test('hour ID uses the overlay switch recipe, not predicate.activates', () => {
    assert.match(liq, /id_source = playlist\(/);
    assert.match(liq, /add\(\[radio, switch\(\[\(\{0m0s\}, id_source\)\]\)\]\)/);
    // predicate.activates' edge is only observable at sampling points, so an
    // ID via a 0m-5m window can silently skip whole hours (see radio.liq
    // comment) -- if someone reintroduces it, this test should force a
    // conversation.
    assert.doesNotMatch(liq, /predicate\.activates/);
  });

  test('stingers go through delay() and a track_sensitive fallback', () => {
    assert.match(liq, /stinger_timed = delay\(1800\., stinger_source\)/);
    assert.match(liq, /fallback\(track_sensitive=true, \[stinger_timed, radio\]\)/);
  });

  test('promos (Paket B2) mirror the stinger pattern with their own 1200. interval', () => {
    assert.match(liq, /promo_source = playlist\(id="imaging_promos", reload_mode="watch", mode="randomize"/);
    assert.match(liq, /promo_timed = delay\(1200\., promo_source\)/);
    assert.match(liq, /fallback\(track_sensitive=true, \[promo_timed, radio\]\)/);
    // ANTI-DRIFT (the clockwheel test's too-poor-future-edit guard, applied
    // to the clip-pool family): random picking is the CORRECT behavior for a
    // short-clip pool -- only the music wheel is mode="normal". If someone
    // "normalizes" the promo pool, this forces a conversation.
    assert.doesNotMatch(liq, /promo_source = playlist\([^)]*mode="normal"/);
    // The two intervals are DELIBERATELY different (1200. vs 1800.) so the
    // gates don't always fire on the same track boundary and stack a promo
    // on every stinger seam -- pin BOTH so neither can drift into the other.
    assert.match(liq, /stinger_timed = delay\(1800\., stinger_source\)/);
    assert.doesNotMatch(liq, /promo_timed = delay\(1800\./);
    assert.doesNotMatch(liq, /stinger_timed = delay\(1200\./);
  });

  test('install.sh deliberately has NO promo_source (the layer is reference-radio.liq only)', () => {
    // Known limit, documented in docs/imaging-layer.md + DEPLOYMENT_GUIDE:
    // the install template carries no promo layer, so enabling
    // imaging.promos.enabled on an install.sh deployment would produce clips
    // that never air. Pinning the absence keeps the non-port deliberate --
    // anyone adding it here must also port the wiring + docs knowingly.
    assert.doesNotMatch(installSh, /promo_source/);
    assert.doesNotMatch(installSh, /imaging\/promos/);
  });

  test('emergency bed sits below the program and above mksafe, via playlist()', () => {
    assert.match(liq, /emergency_source = playlist\(/);
    assert.match(liq, /mksafe\(fallback\(track_sensitive=false, \[radio, emergency_source\]\)\)/);
    // single() with a missing file has murkier availability semantics on this
    // build -- the emergency layer must stay a fallible playlist().
    assert.doesNotMatch(liq, /single\(/);
  });

  test('show/filler core is unchanged underneath the imaging layers', () => {
    assert.match(liq, /fallback\(track_sensitive=false, \[show_source, filler_source\]\)/);
    assert.match(liq, /show_source = fade\.in\(duration=0\., show_source\)/);
    assert.match(liq, /filler_source = fade\.in\(duration=0\., filler_source\)/);
    assert.match(liq, /output\.icecast\(/);
  });

  test('known-broken constructs on LS 2.2.4-1+dev stay out of the script', () => {
    // crossfade() clipped live DJ audio twice (2026-07-27/28 history); a
    // global fade.out() silenced ENTIRE tracks at low durations (2026-07-29).
    // Both are documented in radio.liq's header -- neither may return without
    // upstream re-verification.
    assert.doesNotMatch(liq, /crossfade\(/);
    assert.doesNotMatch(liq, /fade\.out\(/);
  });
});
