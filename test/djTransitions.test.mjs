// Tests for P3 #11 -- dj_transition effects (sweep / washout / dissolve) on
// the upgraded Liquidsoap 2.4.6 runtime, plus the version-gated migration of
// radio.liq's callback forms. Liquidsoap can't run in CI, so the LS half is
// structural (the established pattern): regex assertions over the raw
// scripts, plus gate-balance and ordering checks that the preprocessor
// gating is well-formed. The Node half (stampTransitionFlags.js) is tested
// behaviorally against real temp files.
//
// Every asserted shape was verified against the PRIMARY sources before it
// was written:
//   * 2.4.6 tar (savonet/liquidsoap v2.4.6): cross's persist_override +
//     transition ({source, db_level, metadata} records), filter.rc/comb
//     signatures (feedback in dB), fade.in/out type= ("sin"/"exp"/"log"/
//     "lin") + initial_metadata, source.elapsed/remaining builtins,
//     blank.detect's ~callbacks on_blank/on_noise (zero-arg handlers,
//     synchronous labeled param -- noblank.ml), the REMOVED
//     source.on_metadata function form (deprecations.liq keeps only the
//     unqualified alias), and the %ifversion preprocessor (tests/language/
//     pp.liq, present in BOTH the 2.2.4 and 2.4.6 tars).
//   * SUB/WAVE v1.27.0 radio.liq (perminder-klair/subwave, MIT): the effect
//     envelopes, the measured engine constraints (comb not echo,
//     filter.rc not SVF/iir, mode="high" broken, one dry-subtraction for
//     all dissolve taps, 2.4.6 minimum runtime) and the cross-not-crossfade
//     wrapper rule -- all kept verbatim where the math is concerned.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('dj-transitions', {});

const { stampFlagsOnLine, stampTransitionFlags, TRANSITION_FLAGS } = await import(
  '../src/liquidsoap/stampTransitionFlags.js'
);

// ---------------------------------------------------------------------------
// Script loading + helpers
// ---------------------------------------------------------------------------

function stripComments(raw) {
  return raw
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

const radioRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8');
const radio = stripComments(radioRaw);
const transitionsRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'dj_transitions.liq'), 'utf8');
const transitions = stripComments(transitionsRaw);

function gateBalance(raw) {
  const opens = (raw.match(/^%ifversion/gm) || []).length + (raw.match(/^%ifdef/gm) || []).length;
  const closes = (raw.match(/^%endif/gm) || []).length;
  return { opens, closes };
}

// ---------------------------------------------------------------------------
// radio.liq -- version gating (the old box must boot byte-identically)
// ---------------------------------------------------------------------------

describe('radio.liq P3 #11 version gating', () => {
  test('dj_transitions.liq is included unconditionally and self-gated', () => {
    // The %include sits at top level (no %ifversion between the settings
    // block and the include): nesting preprocessor directives is the
    // uncertainty we deliberately avoided -- the gating lives INSIDE the
    // included file.
    const includeIdx = radio.indexOf('%include "dj_transitions.liq"');
    assert.ok(includeIdx >= 0, 'include missing');
    const before = radio.slice(0, includeIdx);
    assert.doesNotMatch(before, /%ifversion/, 'include must not sit inside a %ifversion gate');
  });

  test('every gate is closed: %ifversion/%endif balance in both scripts', () => {
    for (const [name, raw] of [['radio.liq', radioRaw], ['dj_transitions.liq', transitionsRaw]]) {
      const { opens, closes } = gateBalance(raw);
      assert.equal(opens, closes, `${name}: ${opens} gates vs ${closes} endifs`);
    }
  });

  test('cross wiring sits inside the >= 2.4.6 gate behind the self-sync wrap and the cross-stamps rewrite', () => {
    // Order-based invariants (a regex here would pin pre-change text):
    // gate -> source.dynamic -> CROSS STAMPS def -> metadata.map -> cross.
    const gateIdx = radio.indexOf('%ifversion >= 2.4.6');
    const dynamicIdx = radio.indexOf('radio = source.dynamic(self_sync=false, {radio})');
    const stampsDefIdx = radio.indexOf('def cross_stamps(m) =');
    const mapIdx = radio.indexOf('radio = metadata.map(update=true, strip=true, cross_stamps, radio)');
    const crossIdx = radio.indexOf('radio = cross(duration=dj_transition_buffer, persist_override=true, dj_transition, radio)');
    assert.ok(gateIdx >= 0 && dynamicIdx >= 0 && stampsDefIdx >= 0 && mapIdx >= 0 && crossIdx >= 0,
      'wiring lines present');
    assert.ok(gateIdx < dynamicIdx, 'gate opens before the self-sync wrap');
    assert.ok(dynamicIdx < stampsDefIdx && stampsDefIdx < mapIdx,
      'cross_stamps def precedes the metadata.map rewrite');
    assert.ok(mapIdx < crossIdx, 'the rewrite feeds cross: cross reads the liq_cross_start/end_duration override keys off its input frames (the stdlib fade.in method-extension reason for the source.dynamic wrap still stands)');
    const endifIdx = radio.indexOf('%endif', crossIdx);
    assert.ok(crossIdx < endifIdx, 'gate closes after the cross wiring');
    // Exactly one cross wiring, and it is the gated one.
    assert.equal((radio.match(/radio = cross\(/g) || []).length, 1);
  });

  test('CROSS STAMPS: one stamp split into start/end keys, replay dedup, 30 s cap, raw key cleared', () => {
    // rid/filename replay dedup: a replayed chunk reuses the memoized
    // stamps and must not advance cross_prev_end.
    assert.match(radio, /fname = m\["filename"\]/);
    assert.match(radio, /if fname != "" and fname == cross_last_file\(\) and rid == cross_last_rid\(\) then\n\s*cross_last_stamps\(\)/);
    // The one liq_cross_duration stamp becomes explicit start/end values
    // (start = the PREVIOUS track's end); the raw key is cleared so cross
    // never applies it a second time.
    assert.match(radio, /\("liq_cross_start_duration", string\(cross_prev_end\(\)\)\)/);
    assert.match(radio, /\("liq_cross_end_duration", string\(own\)\)/);
    assert.match(radio, /\("liq_cross_duration", ""\)/);
    // Unstamped/negative -> the buffer literal default; 30 s safety cap
    // (the Node side stamps 8..12 s; past 30 is a corrupt index entry).
    assert.match(radio, /own = float_of_string\(default=dj_transition_buffer, m\["liq_cross_duration"\]\)/);
    assert.match(radio, /own = if own < 0\. then dj_transition_buffer else own end/);
    assert.match(radio, /own = if own > 30\. then 30\. else own end/);
    assert.match(radio, /cross_prev_end := own/);
  });

  test('strip_cross_stamps: every dj_transition return wrapped, all three keys removed', () => {
    assert.match(transitions, /def strip_cross_stamps\(s\) =\n\s*metadata\.map\(update=true, strip=true, fun \(_\) -> \[\n\s*\("liq_cross_duration", ""\),\n\s*\("liq_cross_start_duration", ""\),\n\s*\("liq_cross_end_duration", ""\)\n\s*\], s\)\nend/);
    const rampIdx = transitions.indexOf('strip_cross_stamps(add(normalize=false,\n      [amplify(ramp_duck, b.source), a.source]))');
    const hardCutIdx = transitions.indexOf('strip_cross_stamps((sequence([a.source, b.source]) : source))');
    const blendIdx = transitions.indexOf('strip_cross_stamps(add(normalize=false, [a_source, b_source]))');
    assert.ok(rampIdx >= 0 && hardCutIdx >= 0 && blendIdx >= 0, 'the ramp, hard-cut AND blend returns are all wrapped');
    assert.ok(rampIdx < hardCutIdx && hardCutIdx < blendIdx);
    // def + exactly three applications (comments are already stripped).
    assert.equal((transitions.match(/strip_cross_stamps\(/g) || []).length, 4);
  });

  test('streams.liq: included after the primary MP3 output; committed default is comment-only', () => {
    const outputIdx = radio.indexOf('output.icecast(%mp3(bitrate=config.icecast.bitrate)');
    const includeIdx = radio.indexOf('%include "streams.liq"');
    assert.ok(outputIdx >= 0, 'primary MP3 output present');
    assert.ok(includeIdx > outputIdx, 'the streams.liq include sits after the primary output (extra mounts + archive tap the final source)');
    const streamsRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'streams.liq'), 'utf8');
    const codeLines = streamsRaw.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    assert.equal(codeLines.length, 0, 'committed default must be comment-only: the all-off no-op that the boot-time writer regenerates from config.json');
  });

  test('callback migrations: method forms on 2.4+, old forms preserved in %else', () => {
    // scrobble: method form + old function form in %else
    assert.match(radio, /%ifversion >= 2\.4\.0\nradio\.on_metadata\(synchronous=true, scrobble_on_metadata\)\n%else\nradio = source\.on_metadata\(radio, scrobble_on_metadata\)\n%endif/);
    // ducker on_frame: method form + old function form in %else (the method's
    // synchronous parameter is REQUIRED on 2.4.x -- caught by the real 2.4.6
    // type checker: "Missing arguments in function application: synchronous")
    assert.match(radio, /%ifversion >= 2\.4\.0\nradio\.on_frame\(synchronous=true, duck_update\)\n%else\nradio = source\.on_frame\(radio, duck_update\)\n%endif/);
    // blank.detect x2: zero-arg handler methods on 2.4+, positional+on_noise form on 2.2.4
    assert.match(radio, /%ifversion >= 2\.4\.0\nradio = blank\.detect\(threshold=-40\., max_blank=20\., track_sensitive=true, radio\)\nradio\.on_blank\(synchronous=true, dead_air_program\)\nradio\.on_noise\(synchronous=true, sound_program\)\n%else\nradio = blank\.detect\(dead_air_program, on_noise=sound_program,\n  threshold=-40\., max_blank=20\., track_sensitive=true, radio\)\n%endif/);
    assert.match(radio, /%ifversion >= 2\.4\.0\nradio = blank\.detect\(threshold=-40\., max_blank=20\., track_sensitive=false, radio\)\nradio\.on_blank\(synchronous=true, dead_air_total\)\nradio\.on_noise\(synchronous=true, sound_total\)\n%else\nradio = blank\.detect\(dead_air_total, on_noise=sound_total,\n  threshold=-40\., max_blank=20\., track_sensitive=false, radio\)\n%endif/);
  });

  test('requests stay INSIDE the crossed chain; scrobble sits post-cross, pre-imaging', () => {
    const requestsIdx = radio.indexOf('radio = fallback(track_sensitive=true, [requests_source, radio])');
    const crossIdx = radio.indexOf('radio = cross(');
    const onMetadataIdx = radio.indexOf('radio.on_metadata(synchronous=true, scrobble_on_metadata)');
    const stingerIdx = radio.indexOf('radio = fallback(track_sensitive=true, [stinger_timed, radio])');
    assert.ok(requestsIdx >= 0 && crossIdx >= 0 && onMetadataIdx >= 0 && stingerIdx >= 0);
    assert.ok(requestsIdx < crossIdx, 'a request is music -- its seam gets the same crossfade as any music seam (request.dynamic reports (Static, None); the self-sync suspect was the fade.in method-extension, normalized by the source.dynamic wrap)');
    assert.ok(crossIdx < onMetadataIdx && onMetadataIdx < stingerIdx,
      'post-cross registration fires exactly once per track on 2.4.6 (the stdlib cross wrapper with default deduplicate=true drops the marked outgoing replay -- verified LIVE on the real binary: META: AAA, META: BBB, no replay events); imaging never reaches it');
  });

  test('stingers and everything imaging attach ABOVE the cross (never blended)', () => {
    const crossIdx = radio.indexOf('radio = cross(');
    const stingerIdx = radio.indexOf('radio = fallback(track_sensitive=true, [stinger_timed, radio])');
    const idIdx = radio.indexOf('radio = add(normalize=false, [radio, switch([({0m0s}, id_source)])])');
    const bedsIdx = radio.indexOf('beds_source = request.queue(id="beds")');
    assert.ok(stingerIdx > crossIdx, 'stinger fallback must come after the cross wiring');
    assert.ok(idIdx > crossIdx, 'hour ID overlay must come after the cross wiring');
    assert.ok(bedsIdx > crossIdx, 'beds ducker must come after the cross wiring');
  });

  test('P2/P3 invariants survive the rewrite', () => {
    assert.doesNotMatch(radio, /smooth_add/);
    assert.match(radio, /show_source = fade\.in\(duration=0\., show_source\)/);
    assert.match(radio, /requests_source = request\.queue\(id="requests"\)/);
    assert.match(radio, /radio = amplify\(override="liq_amplify", 1\., radio\)/);
    assert.match(radio, /radio = blank\.strip\(threshold=-40\., max_blank=20\., track_sensitive=true, radio\)/);
    assert.match(radio, /radio = mksafe\(fallback\(track_sensitive=false, \[radio, emergency_source\]\)\)/);
    assert.match(radio, /output\.icecast\(%mp3\(bitrate=config\.icecast\.bitrate\)/);
  });
});

// ---------------------------------------------------------------------------
// dj_transitions.liq -- effects structure (SUB/WAVE-derived, our contract)
// ---------------------------------------------------------------------------

describe('dj_transitions.liq effects', () => {
  test('whole file is inside the >= 2.4.6 gate', () => {
    const codeLines = transitionsRaw
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    assert.equal(codeLines[0].trim(), '%ifversion >= 2.4.6');
    assert.equal(codeLines[codeLines.length - 1].trim(), '%endif');
  });

  test('buffer literal + honest sizing; the END STAMP is the lengthless-side fallback', () => {
    assert.match(transitions, /dj_transition_buffer = 3\.5/);
    assert.match(transitions, /buffered = min\(source\.remaining\(a\.source\), source\.remaining\(b\.source\)\)/);
    assert.match(transitions, /stamp = float_of_string\(default=dj_transition_buffer, a\.metadata\["liq_cross_end_duration"\]\)/);
    assert.match(transitions, /d = if buffered > 0\. and buffered < 600\. then buffered else stamp end/);
  });

  test('speech and jingle seams stay HARD CUTS (source_tag dispatch) -- except the Val 32 rampa', () => {
    assert.match(transitions, /speech_out = a\.metadata\["source_tag"\] == "speech"/);
    assert.match(transitions, /speech_in = b\.metadata\["source_tag"\] == "speech"/);
    assert.match(transitions, /jingle_out = a\.metadata\["source_tag"\] == "jingle"/);
    assert.match(transitions, /jingle_in = b\.metadata\["source_tag"\] == "jingle"/);
    // The hard cut is now the ELSIF (the ramp branch is the first case); the
    // pin deliberately says elsif so a future re-ordering forces a look.
    assert.match(transitions, /elsif speech_out or speech_in or jingle_out or jingle_in then\n\s*strip_cross_stamps\(\(sequence\(\[a\.source, b\.source\]\) : source\)\)/);
  });

  test('Val 32 rampa: both sides must carry liq_ramp, the end stamp sizes the duck, release 0.6 s', () => {
    // Branch arming: speech OUT, music IN (not speech, not jingle), and the
    // marker on BOTH sides -- an unmarked incoming (filler, requests,
    // hand-built playlists) can never ramp.
    assert.match(transitions, /ramp_d = float_of_string\(default=0\., a\.metadata\["liq_cross_end_duration"\]\)/);
    assert.match(transitions, /ramp_ok =\n\s*speech_out and not speech_in and not jingle_in and\n\s*a\.metadata\["liq_ramp"\] == "1" and b\.metadata\["liq_ramp"\] == "1" and\n\s*ramp_d > 0\. and ramp_d <= 30\./);
    // The duck: the beds ducker's 0.2 program floor, held while the talk
    // sounds, smoothstep release to unity over the LAST 0.6 s, driven by the
    // incoming source's own elapsed (audio time, like every envelope here).
    assert.match(transitions, /def ramp_duck\(\) =\n\s*e = source\.elapsed\(ramp_in\)\n\s*e = if e < 0\. then 0\. else e end\n\s*t_from = ramp_d - 0\.6/);
    assert.match(transitions, /0\.2 \+ \(3\.0 \* x \* x - 2\.0 \* x \* x \* x\) \* 0\.8/);
    // The transition: ducked incoming + UNTOUCHED speech (the DJ is never
    // faded -- the duck is on the music), stamp-stripped like every return.
    assert.match(transitions, /strip_cross_stamps\(add\(normalize=false,\n\s*\[amplify\(ramp_duck, b\.source\), a\.source\]\)\)/);
    // The speech side gets NO fade.out in the ramp branch -- searching the
    // whole file, fade.out never touches a_source inside the ramp block
    // (the existing fade-shape pins already cover the effects branches).
    const rampAt = transitions.indexOf('if ramp_ok then');
    const hardCutAt = transitions.indexOf('elsif speech_out or speech_in');
    assert.ok(rampAt >= 0 && hardCutAt > rampAt, 'ramp branch precedes the hard-cut elsif');
    const rampBlock = transitions.slice(rampAt, hardCutAt);
    assert.doesNotMatch(rampBlock, /fade\.out\(/);
    assert.doesNotMatch(rampBlock, /fade\.in\(/);
  });

  test('arming precedence: washout > dissolve > sweep, flags from the right side', () => {
    assert.match(transitions, /washing = a\.metadata\["liq_washout"\] == "1"/);
    assert.match(transitions, /dissolving = b\.metadata\["liq_dissolve"\] == "1" and not washing/);
    assert.match(transitions, /sweeping = b\.metadata\["liq_sweep"\] == "1" and not washing and not dissolving/);
  });

  test('fade shapes per effect: exp for washout, log for sweep, lin plain; spans = full buffer', () => {
    assert.match(transitions, /fade\.out\(duration=d, type="exp", initial_metadata=a\.metadata, a\.source\)/);
    assert.match(transitions, /fade\.out\(duration=d, type="log", initial_metadata=a\.metadata, a\.source\)/);
    assert.match(transitions, /fade\.out\(duration=d, initial_metadata=a\.metadata, a\.source\)/);
    assert.match(transitions, /b_source = fade\.in\(duration=d, initial_metadata=b\.metadata, b\.source\)/);
  });

  test('sweep: log-space dual lowpass choke, dry bleed, makeup; surfacing + subtract-HPF bass swap on the incoming side', () => {
    assert.match(transitions, /9000\.0 \* pow\(1100\.0 \/ 9000\.0, depth\)/);
    assert.match(transitions, /amplify\(sweep_gain, add\(normalize=false,\n\s*\[amplify\(0\.30, a_source\), amplify\(0\.75, swept\)\]\)\)/);
    assert.match(transitions, /500\.0 \* pow\(9000\.0 \/ 500\.0, s\)/);
    assert.match(transitions, /bs_low = filter\.rc\(frequency=160\., mode="low", wetness=1\., bs\)/);
    assert.match(transitions, /add\(normalize=false, \[bs, amplify\(bass_amt, bs_low\)\]\)/);
  });

  test('washout: one-shot comb slapback, dB feedback envelope, darkening lowpass, late makeup', () => {
    assert.match(transitions, /wd = float_of_string\(default=0\.30, a\.metadata\["liq_washout_delay"\]\)/);
    assert.match(transitions, /washed = comb\(delay=wd, feedback=wash_fb, a_source\)/);
    assert.match(transitions, /fb_max = -1\.0/);
    assert.match(transitions, /9000\.0 \* pow\(3000\.0 \/ 9000\.0, s\)/);
    assert.match(transitions, /amplify\(wash_gain, washed\)/);
  });

  test('dissolve: FOUR prime-tap combs, ONE dry-subtraction (performance), deeper damping', () => {
    for (const delay of ['0.089', '0.113', '0.151', '0.181']) {
      assert.match(transitions, new RegExp(`comb\\(delay=${delay.replace('.', '\\.')}, feedback=diss_fb, a_source\\)`));
    }
    // Exactly ONE subtraction for all four taps (#1565): per-tap subtraction
    // stalled SUB/WAVE's clock on ~1 dissolve in 5.
    assert.equal((transitions.match(/amplify\(-4\., a_source\)/g) || []).length, 1);
    assert.match(transitions, /washed = amplify\(0\.7, washed\)/);
    assert.match(transitions, /7000\.0 \* pow\(1200\.0 \/ 7000\.0, s\)/);
  });

  test('engine constraints honored: no echo, no iir, no mode="high", envelopes in audio time', () => {
    assert.doesNotMatch(transitions, /echo|ping_pong/);
    assert.doesNotMatch(transitions, /iir_filter|filter\.svf/);
    assert.doesNotMatch(transitions, /mode="high"/);
    // Every envelope closure clamps source.elapsed() (negative/infinity-safe)
    const clamps = (transitions.match(/e = if e < 0\. then 0\. else e end/g) || []).length;
    assert.ok(clamps >= 10, `expected >=10 elapsed clamps, got ${clamps}`);
    assert.doesNotMatch(transitions, /smooth_add/);
  });
});

// ---------------------------------------------------------------------------
// stampTransitionFlags.js -- behavioral, against real temp files
// ---------------------------------------------------------------------------

describe('stampFlagsOnLine', () => {
  test('adds a flag to an annotate entry, preserving existing keys and the uri', () => {
    const line = 'annotate:source_tag="music",liq_fade_in="2":/music/Nightcall.wav';
    const { line: next, changed } = stampFlagsOnLine(line, { set: ['sweep'] });
    assert.equal(changed, true);
    assert.equal(next, 'annotate:source_tag="music",liq_fade_in="2",liq_sweep="1":/music/Nightcall.wav');
  });

  test('wraps a bare path when setting a flag', () => {
    const { line: next, changed } = stampFlagsOnLine('/music/bare.wav', { set: ['dissolve'] });
    assert.equal(changed, true);
    assert.equal(next, 'annotate:liq_dissolve="1":/music/bare.wav');
  });

  test('idempotent: stamping twice changes nothing the second time', () => {
    const once = stampFlagsOnLine('/music/x.wav', { set: ['washout'] });
    const twice = stampFlagsOnLine(once.line, { set: ['washout'] });
    assert.equal(twice.changed, false);
    assert.equal(twice.line, once.line);
  });

  test('washout --delay stamps liq_washout_delay and updates it; clear removes both', () => {
    const stamped = stampFlagsOnLine('/music/x.wav', { set: ['washout'], delay: '0.45' });
    assert.equal(stamped.line, 'annotate:liq_washout="1",liq_washout_delay="0.45":/music/x.wav');
    const updated = stampFlagsOnLine(stamped.line, { set: ['washout'], delay: '0.30' });
    assert.equal(updated.line, 'annotate:liq_washout="1",liq_washout_delay="0.30":/music/x.wav');
    const cleared = stampFlagsOnLine(updated.line, { clear: ['washout'] });
    assert.equal(cleared.line, '/music/x.wav');
    assert.equal(cleared.changed, true);
  });

  test('unknown effect name throws (a typo must be loud, not inert)', () => {
    assert.throws(() => stampFlagsOnLine('/music/x.wav', { set: ['swep'] }), /Neznan učinek/);
  });

  test('--only filter leaves non-matching lines untouched; comments and blanks pass through', () => {
    const comment = '#EXTM3U';
    const blank = '   ';
    const other = 'annotate:source_tag="music",liq_fade_in="2":/music/Other.wav';
    for (const line of [comment, blank]) {
      const { line: next, changed } = stampFlagsOnLine(line, { set: ['sweep'] });
      assert.equal(changed, false);
      assert.equal(next, line);
    }
    const { line: next, changed } = stampFlagsOnLine(other, { set: ['sweep'], only: 'Nightcall' });
    assert.equal(changed, false);
    assert.equal(next, other);
  });

  test('flag vocabulary matches the LS contract exactly', () => {
    assert.deepEqual(TRANSITION_FLAGS, { sweep: 'liq_sweep', washout: 'liq_washout', dissolve: 'liq_dissolve' });
  });
});

describe('stampTransitionFlags (file round-trip)', () => {
  test('stamps, reports honestly, and a second run is a no-op that does not rewrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    const file = path.join(dir, 'filler.m3u');
    fs.writeFileSync(file, [
      '#EXTM3U',
      'annotate:source_tag="music",liq_fade_in="2":/music/A.wav',
      '/music/B.wav',
      '',
    ].join('\n'));

    const first = stampTransitionFlags(file, { set: ['sweep'] });
    assert.equal(first.ok, true);
    assert.equal(first.entries, 2);
    assert.equal(first.changed, 2);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /annotate:source_tag="music",liq_fade_in="2",liq_sweep="1":\/music\/A\.wav/);
    assert.match(content, /annotate:liq_sweep="1":\/music\/B\.wav/);

    const mtime = fs.statSync(file).mtimeMs;
    const second = stampTransitionFlags(file, { set: ['sweep'] });
    assert.equal(second.changed, 0);
    assert.equal(fs.statSync(file).mtimeMs, mtime, 'no-op run must not touch the file (watch-reload churn)');

    const cleared = stampTransitionFlags(file, { clear: ['all'] });
    assert.equal(cleared.changed, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), [
      '#EXTM3U',
      'annotate:source_tag="music",liq_fade_in="2":/music/A.wav',
      '/music/B.wav',
      '',
    ].join('\n'));
  });

  test('missing playlist is an honest refusal, not a throw', () => {
    const result = stampTransitionFlags('/neobstaja/nikoli.m3u', { set: ['sweep'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /ne obstaja/);
  });
});

// ---------------------------------------------------------------------------
// Val 28 D1: the effects are armed AUTOMATICALLY at playlist-write time --
// the CLI stamper stays for manual touch-ups, but the layer no longer
// depends on a hand running it. The deterministic RULES (which measurements
// earn which effect) are pinned pure in test/autocueHead.test.mjs
// (transitionFlagsFor) and integrated in its annotateTrackEntry blocks;
// this block pins the WIRING: the one writer both filler.m3u and show
// playlist.m3u go through calls the stamper for every music entry.
// ---------------------------------------------------------------------------
describe('auto-stamping at playlist-write time (Val 28 D1)', () => {
  const playlistSrc = fs.readFileSync(path.join(repoRoot(), 'src', 'director', 'playlist.js'), 'utf8');
  const autocueSrc = fs.readFileSync(path.join(repoRoot(), 'src', 'lib', 'autocue.js'), 'utf8');
  const fillerSrc = fs.readFileSync(path.join(repoRoot(), 'src', 'scheduler', 'generateFillerPlaylist.js'), 'utf8');

  test('annotateTrackEntry (the shared writer) appends the effect fields', () => {
    assert.match(playlistSrc, /transitionFlagAnnotate/, 'the writer calls the stamper');
    assert.match(autocueSrc, /export function transitionFlagsFor/, 'the deterministic rules live in autocue');
    assert.match(autocueSrc, /export function transitionFlagAnnotate/, 'the path-level annotate helper exists');
    // The effect fields land in the SAME annotate group (dj_transitions.liq
    // reads them as request metadata), after fade-in and before amplify.
    assert.match(playlistSrc, /fields\.push\(\.\.\.transitionFlagAnnotate\(filePath\)\);/);
  });

  test('filler.m3u flows through the same writer (both playlists are covered by construction)', () => {
    assert.match(fillerSrc, /localPaths\.map\(annotateTrackEntry\)/, 'filler uses the shared writer');
  });

  test('the effect keys in the stamper match dj_transitions.liq exactly', () => {
    // The closed key set: what the CLI stamps, what the writer stamps, and
    // what the .liq seam dispatcher reads must be the same three strings.
    assert.equal(Object.keys(TRANSITION_FLAGS).length, 3, 'exactly three effects');
    for (const key of Object.values(TRANSITION_FLAGS)) {
      assert.match(
        transitionsRaw,
        new RegExp(`metadata\\["${key}"\\]`),
        `${key} must be read by the seam dispatcher`
      );
    }
  });
});
