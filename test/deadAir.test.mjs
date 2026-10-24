// Tests for P2 #9 -- the dead-air guard completing the emergency-bed ladder.
// Four layers, mirroring the feature: the radio.liq wiring (structural, same
// pattern as radioLImaging.test.mjs / requestQueue.test.mjs -- Liquidsoap
// can't run in CI, but the call shapes are pinned against THIS build's
// src/core/operators/noblank.ml and src/libs/source.liq), the CLI writer
// against the real test config, the pure episode-pairing math, and the
// Diagnostics summary over a real ledger file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('dead-air', {});

const { pairDeadAirEpisodes, readDeadAirEvents, deadAirSummary } = await import(
  '../src/deadair/ledger.js'
);
const { config: liveConfig } = await import('../src/config/index.js');

// ---------------------------------------------------------------------------
// radio.liq structural wiring
// ---------------------------------------------------------------------------

const repo = repoRoot();
const liqRaw = fs.readFileSync(path.join(repo, 'liquidsoap', 'radio.liq'), 'utf8');
const liq = liqRaw
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('radio.liq dead-air guard wiring', () => {
  test('blank.strip wraps the program chain, between the ID overlay and amplify', () => {
    const addAt = liq.indexOf('add([radio, switch([({0m0s}, id_source)])])');
    const stripAt = liq.indexOf('radio = blank.strip(threshold=-40., max_blank=20., track_sensitive=true, radio)');
    const amplifyAt = liq.indexOf('amplify(override="liq_amplify", 1., radio)');
    assert.ok(addAt !== -1, 'ID overlay line present');
    assert.ok(stripAt !== -1, 'program strip line present with verified 2.2.4 params');
    assert.ok(amplifyAt !== -1, 'amplify line present');
    assert.ok(addAt < stripAt && stripAt < amplifyAt,
      'strip judges the program as produced -- ID sound counts as sound, per-track gain can never push a master under the threshold');
  });

  test('program blank.detect observer sits just above strip, same state machine', () => {
    const detectAt = liq.indexOf('radio = blank.detect(dead_air_program, on_noise=sound_program,');
    const stripAt = liq.indexOf('radio = blank.strip(threshold=-40., max_blank=20., track_sensitive=true, radio)');
    assert.ok(detectAt !== -1, 'program detect line present');
    assert.ok(detectAt < stripAt, 'strip wraps detect so both see identical frames');
    // blank.detect's handler is its UNNAMED FIRST argument in 2.2.4 (the
    // source is last) -- pinned so a future refactor can't accidentally
    // reorder into "source as first arg", which is a type error only
    // liquidsoap --check on the box would catch.
    assert.match(liq, /blank\.detect\(dead_air_program, on_noise=sound_program,\n\s*threshold=-40\., max_blank=20\., track_sensitive=true, radio\)/);
  });

  test('strip + detect params match the verified noblack.ml defaults', () => {
    // Accumulation semantics: max_blank=20. tolerates 20 s of silence before
    // flipping (boundary micro-gaps never fire), min_noise stays default 0.,
    // track_sensitive=true resets per track so every new file gets a chance.
    const guard = liq.slice(liq.indexOf('radio = blank.detect(dead_air_program'), liq.indexOf('amplify(override="liq_amplify"'));
    assert.match(guard, /threshold=-40\./);
    assert.match(guard, /max_blank=20\./);
    assert.match(guard, /track_sensitive=true/);
    assert.doesNotMatch(guard, /min_noise=/, 'min_noise stays at the 2.2.4 default (0.) -- recovery needs no accumulated sound');
  });

  test('air detector measures the FINAL chain, after the emergency fallback, absolutely', () => {
    const mksafeAt = liq.indexOf('mksafe(fallback(track_sensitive=false, [radio, emergency_source]))');
    const airAt = liq.indexOf('radio = blank.detect(dead_air_total, on_noise=sound_total,');
    const metaAt = liq.indexOf('radio = source.on_metadata(radio, scrobble_on_metadata)');
    assert.ok(mksafeAt !== -1 && airAt !== -1 && metaAt !== -1);
    assert.ok(mksafeAt < airAt && airAt < metaAt,
      'the air observer hears post-mksafe output INCLUDING the emergency bed, and before scrobbling wraps it');
    const airLine = liq.slice(airAt, liq.indexOf(')', liq.indexOf('track_sensitive=', airAt)) + 1);
    assert.match(airLine, /track_sensitive=false/,
      'mksafe blank frames contain no track boundaries -- nothing would ever reset the counter');
  });

  test('every guard callback pings the Node CLI backgrounded (streaming thread stays fast)', () => {
    for (const ev of ['program_blank', 'program_sound', 'air_blank', 'air_sound']) {
      assert.match(liq, new RegExp(`recordEvent\\.js ${ev} > /dev/null 2>&1 &`), `${ev} handler backgrounded`);
    }
    // Same fast-callback pattern as the scrobble handler: thread.run(fast=false).
    assert.match(liq, /def dead_air_program\(\) =\n\s*thread\.run\(fast=false/);
  });

  test('json.parse type stays untouched -- an older config.json still boots', () => {
    const parseBlock = liq.slice(liq.indexOf('let json.parse'), liq.indexOf('= file.contents'));
    assert.doesNotMatch(parseBlock, /deadAir/i,
      'guard params are literals (imaging-layer pattern), no new config block required');
  });

  test('known-broken constructs stay out (same ban list as the request test)', () => {
    assert.doesNotMatch(liq, /cross\.smart|fade\.out\(|predicate\.activates/);
    // blank.eat would DELETE the silent audio (time warps); strip only
    // affects availability -- exactly the difference the recipe needs.
    assert.doesNotMatch(liq, /blank\.eat\(/);
  });
});

// ---------------------------------------------------------------------------
// recordEvent.js CLI (real subprocess against the real test config)
// ---------------------------------------------------------------------------

describe('recordEvent.js CLI', () => {
  test('appends one closed-vocabulary JSON line per call, timestamps from one clock', () => {
    const script = path.join(repo, 'src', 'deadair', 'recordEvent.js');
    execFileSync(process.execPath, [script, 'program_blank'], { cwd: repo });
    execFileSync(process.execPath, [script, 'program_sound'], { cwd: repo });
    execFileSync(process.execPath, [script, 'air_blank'], { cwd: repo });

    const lines = fs.readFileSync(liveConfig.paths.deadAirEventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    assert.equal(lines.length, 3, 'exactly one line per invocation');
    const events = lines.map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.type), ['program_blank', 'program_sound', 'air_blank']);
    for (const e of events) {
      assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'offset-aware local ISO like every other ledger');
      assert.ok(!Number.isNaN(new Date(e.at).getTime()), 'parseable -- pairing does epoch math on it');
    }
  });

  test('refuses an unknown event type loudly (exit code, no line written)', () => {
    const file = liveConfig.paths.deadAirEventsFile;
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
    assert.throws(() => execFileSync(process.execPath, [path.join(repo, 'src', 'deadair', 'recordEvent.js'), 'banana'], { cwd: repo }));
    const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
    assert.equal(before, after, 'a typo must not pollute the ledger');
  });
});

// ---------------------------------------------------------------------------
// Episode pairing (pure math)
// ---------------------------------------------------------------------------

describe('pairDeadAirEpisodes', () => {
  test('pairs blank->sound into one episode with a real duration', () => {
    const eps = pairDeadAirEpisodes([
      { type: 'program_blank', at: '2026-10-24T20:00:00+02:00' },
      { type: 'program_sound', at: '2026-10-24T20:01:10+02:00' },
    ]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].layer, 'program');
    assert.equal(eps[0].durationMs, 70000);
    assert.equal(eps[0].closedAt, '2026-10-24T20:01:10+02:00');
    assert.equal(eps[0].note, undefined);
  });

  test('an unterminated blank stays open -- that is "silent right now"', () => {
    const eps = pairDeadAirEpisodes([
      { type: 'program_blank', at: '2026-10-24T20:00:00+02:00' },
      { type: 'program_sound', at: '2026-10-24T20:00:40+02:00' },
      { type: 'program_blank', at: '2026-10-24T21:00:00+02:00' },
    ]);
    assert.equal(eps.length, 2);
    assert.equal(eps[0].durationMs, 40000);
    assert.equal(eps[1].closedAt, null, 'ongoing');
  });

  test('layers pair independently', () => {
    const eps = pairDeadAirEpisodes([
      { type: 'program_blank', at: '2026-10-24T20:00:00+02:00' },
      { type: 'air_blank', at: '2026-10-24T20:00:20+02:00' },
      { type: 'program_sound', at: '2026-10-24T20:00:30+02:00' },
      { type: 'air_sound', at: '2026-10-24T20:00:40+02:00' },
    ]);
    assert.equal(eps.length, 2);
    const program = eps.find((e) => e.layer === 'program');
    const air = eps.find((e) => e.layer === 'air');
    assert.equal(program.durationMs, 30000);
    assert.equal(air.durationMs, 20000);
  });

  test('irregular sequences are kept and noted, never silently dropped', () => {
    // Sound without a blank: LS restarted mid-episode (state machine fresh,
    // ledger older than the silence) or the file was truncated.
    const orphan = pairDeadAirEpisodes([{ type: 'air_sound', at: '2026-10-24T20:00:30+02:00' }]);
    assert.equal(orphan.length, 1);
    assert.equal(orphan[0].openedAt, null);
    assert.match(orphan[0].note, /without a matching blank/);

    // Second blank while open cannot come from the detectors; the first open
    // (longest honest reading) wins and the anomaly is named.
    const folded = pairDeadAirEpisodes([
      { type: 'program_blank', at: '2026-10-24T20:00:00+02:00' },
      { type: 'program_blank', at: '2026-10-24T20:00:10+02:00' },
      { type: 'program_sound', at: '2026-10-24T20:00:20+02:00' },
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].durationMs, 20000, 'duration measured from the FIRST blank');
    assert.match(folded[0].note, /second blank while already open/);
  });
});

// ---------------------------------------------------------------------------
// deadAirSummary over the real ledger
// ---------------------------------------------------------------------------

describe('deadAirSummary (Diagnostics view)', () => {
  test('missing file is an honest empty report, not an error', () => {
    fs.rmSync(liveConfig.paths.deadAirEventsFile, { force: true });
    const summary = deadAirSummary();
    assert.equal(summary.exists, false);
    assert.deepEqual(summary.episodes, []);
    assert.equal(summary.ongoing, null);
  });

  test('reports the tail, skips malformed lines, surfaces ongoing silence', () => {
    const dir = path.dirname(liveConfig.paths.deadAirEventsFile);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'program_blank', at: '2026-10-24T18:00:00+02:00' }),
      JSON.stringify({ type: 'program_sound', at: '2026-10-24T18:00:45+02:00' }),
      '{"type":"program_blank"', // torn append
      JSON.stringify({ type: 'banana', at: '2026-10-24T18:01:00+02:00' }), // unknown type
      JSON.stringify({ type: 'air_blank', at: '2026-10-24T18:02:00+02:00' }), // ongoing air silence
    ];
    fs.writeFileSync(liveConfig.paths.deadAirEventsFile, lines.join('\n') + '\n');

    const summary = deadAirSummary();
    assert.equal(summary.exists, true);
    assert.equal(summary.skipped, 2, 'torn line and unknown type counted, never fatal');
    assert.equal(summary.totalEvents, 3);
    assert.equal(summary.episodes.length, 2);
    assert.equal(summary.ongoing.layer, 'air', 'the newest open episode is what Diagnostics shows as current');
    const closed = summary.episodes.find((e) => e.closedAt);
    assert.equal(closed.durationMs, 45000);
  });

  test('Diagnostics endpoint exposes the deadAir block', () => {
    const api = fs.readFileSync(path.join(repo, 'src', 'server', 'studioDiagnosticsApi.js'), 'utf8');
    assert.match(api, /import \{ deadAirSummary \} from '\.\.\/deadair\/ledger\.js'/);
    assert.match(api, /deadAir: deadAirSummary\(\)/);
  });
});
