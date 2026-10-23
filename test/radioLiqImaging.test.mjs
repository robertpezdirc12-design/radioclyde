// radio.liq imaging-layer structural regression: Liquidsoap can't run in CI,
// so (same pattern as the scheduler ?. regression) the test scans the script's
// SOURCE and pins the wiring that the live stream depends on.
//
// It guards two directions:
//  - PRESENT: the three imaging layers and their exact verified semantics
//    (overlay switch for the hour ID, delay() + track_sensitive fallback for
//    stingers, emergency playlist below the program, mksafe still last)
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
