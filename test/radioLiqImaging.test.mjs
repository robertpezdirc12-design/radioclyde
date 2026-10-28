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

// The install.sh deployment contract (same read as radioLiqIcy.test.mjs /
// clockwheel.test.mjs: shell # comments strip the same way; until Val 34
// its heredocs were single-quoted so nothing was shell-expanded either).
const installSh = fs
  .readFileSync(path.join(repoRoot(), 'deploy', 'ubuntu', 'install.sh'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('radio.liq imaging layer structure', () => {
  test('hour ID uses the overlay switch recipe, not predicate.activates', () => {
    assert.match(liq, /id_source = playlist\(/);
    assert.match(liq, /add\(normalize=false, \[radio, switch\(\[\(\{0m0s\}, id_source\)\]\)\]\)/);
    // predicate.activates' edge is only observable at sampling points, so an
    // ID via a 0m-5m window can silently skip whole hours (see radio.liq
    // comment) -- if someone reintroduces it, this test should force a
    // conversation.
    assert.doesNotMatch(liq, /predicate\.activates/);
  });

  // --- Val 31, B3: the hour ID must not stomp DJ speech (2.4.6 gate) ---------

  test('no short-clip pool starves: id/stingers/promos all loop=true (Val 31)', () => {
    // With loop=false each pool played its entries once and nothing refilled
    // it in steady state (imagingPlaylists.js rewrites the m3u only when the
    // clip SET changes), so every layer went silent after N clips -- measured
    // live on both official binaries (2026-10-27). loop=true is endless; the
    // gates keep the cadence on both builds: the ID at one clip per window
    // opening (2.2.4: the {0m0s} window closes before any clip ends and the
    // switch re-checks its predicate at track end; 2.4.6: the id_fired latch),
    // stingers/promos at one clip per delay() interval (measured on 2.2.4:
    // stingers at 0 s/36 s/72 s, one each, no chaining; same on 2.4.6).
    assert.match(liq, /id_source = playlist\(id="imaging_id", reload_mode="watch", mode="randomize", loop=true,/);
    assert.match(liq, /stinger_source = playlist\(id="imaging_stingers", reload_mode="watch", mode="randomize", loop=true,/);
    assert.match(liq, /promo_source = playlist\(id="imaging_promos", reload_mode="watch", mode="randomize", loop=true,/);
    assert.doesNotMatch(liq, /id_source = playlist\([^)]*loop=false/);
    assert.doesNotMatch(liq, /stinger_source = playlist\([^)]*loop=false/);
    assert.doesNotMatch(liq, /promo_source = playlist\([^)]*loop=false/);
    // NOT part of this fix, on purpose: show_source's loop=false is the
    // episode contract (plays once, then the filler takes over), and the
    // emergency bed was already loop=true.
    assert.match(liq, /show_source = playlist\(id="show_source", reload_mode="watch", mode="normal", loop=false,/);
    assert.match(liq, /emergency_source = playlist\(id="imaging_emergency", reload_mode="watch", mode="normal", loop=true,/);
  });

  test('B3 speech gate on 2.4.6: 90 s window, fail-closed ref, one-shot latch, ramp latch (Val 32)', () => {
    // The gate block lives inside %ifversion >= 2.4.6; on 2.2.4 the
    // preprocessor strips it before parsing.
    assert.match(liq, /%ifversion >= 2\.4\.6\nid_window = \{0m0s-1m30s\}/);
    // Fail-closed default: before any program metadata has passed (boot),
    // "unknown" reads as speech -- the ID defers, never talks over it.
    assert.match(liq, /id_speech_active = ref\(true\)/);
    assert.match(liq, /id_fired = ref\(false\)/);
    // The gate keys on the source_tag contract (djTransitions' own notion of
    // speech), via the synchronous method form 2.4.6 requires -- PLUS the
    // Val 32 ramp latch: during a rampa the incoming track's metadata arrives
    // while the speech still sounds, so source_tag alone would read "music"
    // mid-talk and open the ID over the DJ (the B3 regression through a new
    // door). Both sides of a ramp seam carry liq_ramp="1", so the marker
    // latches the gate for the whole ramp either way.
    assert.match(liq, /id_speech_active := \(m\["source_tag"\] == "speech" or m\["liq_ramp"\] == "1"\)/);
    assert.match(liq, /radio\.on_metadata\(synchronous=true, id_speech_watch\)/);
    assert.match(liq, /id_source\.on_metadata\(synchronous=true, id_fired_watch\)/);
    // The latch: set only by id-tagged clips, reset by the predicate while
    // the window is closed -- exactly one ID clip per hour-window even with
    // a window wider than one clip and an endless pool.
    assert.match(liq, /if m\["source_tag"\] == "id" then\n    id_fired := true\n  end/);
    assert.match(liq, /if not id_window\(\) then\n    id_fired := false\n  end/);
    assert.match(liq, /id_window\(\) and not id_speech_active\(\) and not id_fired\(\)/);
    assert.match(liq, /radio = add\(normalize=false, \[radio, switch\(\[\(id_ready, id_source\)\]\)\]\)/);
    // Position: the speech watch registers on the program chain BELOW the
    // overlay (it must see program tracks, not the overlay's own output).
    const watchAt = liq.indexOf('radio.on_metadata(synchronous=true, id_speech_watch)');
    const overlayAt = liq.indexOf('radio = add(normalize=false, [radio, switch([(id_ready, id_source)])])');
    assert.ok(watchAt !== -1 && overlayAt !== -1, 'gate wiring present');
    assert.ok(watchAt < overlayAt, 'speech watch sees the program chain below the overlay');
  });

  test('B3: the 2.2.4 %else branch keeps the cookbook overlay, plus the Val 32 normalize fix on BOTH branches', () => {
    // The old line survives byte-identical inside %else EXCEPT for the
    // Val 32 discovery fix (normalize=false, see the block comment at the
    // overlay): the default normalize=true measurably averaged the mix
    // (half-volume station) and, with blank.strip, starved the program
    // chain on BOTH builds. Every position-sensitive test
    // (deadAir/bedQueue/djTransitions/requestQueue) anchors on the %else
    // line, and the 2.2.4 preprocessor strips the gated branch before
    // parsing, so that build gets the fix and nothing else from Val 32.
    assert.match(liq, /%else\s*radio = add\(normalize=false, \[radio, switch\(\[\(\{0m0s\}, id_source\)\]\)\]\)\s*%endif/);
  });

  test('Val 32: every add() over the program chain is normalize=false (starvation + half-volume fix)', () => {
    // The bisection matrix (2026-10-28, official 2.2.4 + 2.4.6 binaries):
    // add(normalize=true) over [radio, switch] + blank.strip below kills
    // the program chain (track dies 10 s in on 2.2.4, ~22 s in on 2.4.6)
    // and averages the mix to half volume on both. normalize=false is the
    // fix and the ONLY sanctioned shape for adds over radio from now on:
    // this anti-drift pin fails if any future edit reintroduces a bare
    // add([radio, ...]) -- the beds add and dj_transitions' rampa/blend
    // adds are already normalize=false by construction.
    assert.doesNotMatch(liq, /add\(\[radio/);
    assert.ok((liq.match(/add\(normalize=false, /g) || []).length >= 3, 'ID overlay (both branches via strip of gated) + beds add present');
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

  test('install.sh runs the reference in place -- the imaging layers exist on deployments (Val 34)', () => {
    // Until Val 34 the install template carried no promo layer (documented
    // known limit in docs/imaging-layer.md + DEPLOYMENT_GUIDE): enabling
    // imaging.promos.enabled on a template deployment produced clips that
    // never aired. The template is gone -- the unit's ExecStart points at
    // THIS reference file, so every layer pinned above exists on every
    // deployment by construction. A reappearance of a second graph heredoc
    // (any imaging source defined inside install.sh) is a regression, not
    // an edit; the unit-to-file pin itself lives in test/deployReference
    // .test.mjs.
    assert.match(installSh, /ExecStart=\/usr\/bin\/liquidsoap \/opt\/radioclyde\/app\/liquidsoap\/radio\.liq/);
    assert.doesNotMatch(installSh, /stinger_source = playlist\(/);
    assert.doesNotMatch(installSh, /promo_source = playlist\(/);
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
