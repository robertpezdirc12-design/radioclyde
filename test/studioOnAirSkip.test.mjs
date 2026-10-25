// studioOnAirApi's skip/force-next telnet command (Task 11-P1). radio.liq's
// output.icecast has no explicit id, so the output's command namespace is the
// MOUNT: "/stream.mp3" -> "/stream.mp3.skip". The old hardcoded
// "/stream.skip" 502'd with "no such command" on every non-example mount --
// these tests pin the mount-derived derivation without a running Liquidsoap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('studio-onair-skip');

const { skipCommandForMount } = await import('../src/server/studioOnAirApi.js');

describe('skipCommandForMount (mount -> telnet command)', () => {
  test('shipped mount shapes', () => {
    assert.equal(skipCommandForMount('/stream'), '/stream.skip', 'config.example.json');
    assert.equal(skipCommandForMount('/stream.mp3'), '/stream.mp3.skip', 'deploy/ubuntu default -- the case that 502d');
  });

  test('absent / blank / non-string mount falls back to /stream', () => {
    assert.equal(skipCommandForMount(undefined), '/stream.skip');
    assert.equal(skipCommandForMount(null), '/stream.skip');
    assert.equal(skipCommandForMount('   '), '/stream.skip');
    assert.equal(skipCommandForMount(42), '/stream.skip');
  });

  test('exactly one leading slash, whatever the operator typed', () => {
    assert.equal(skipCommandForMount('stream.mp3'), '/stream.mp3.skip', 'missing slash tolerated');
    assert.equal(skipCommandForMount('//stream'), '/stream.skip', 'doubled slash normalized');
    assert.equal(skipCommandForMount('  /stream.mp3  '), '/stream.mp3.skip', 'whitespace trimmed');
  });
});

describe('structural pin (both buttons derive from config, no hardcoded command)', () => {
  test('skip call sites read config.icecast.mount; the literal /stream.skip is gone', () => {
    const src = fs.readFileSync(path.join(repoRoot(), 'src', 'server', 'studioOnAirApi.js'), 'utf8');
    const derived = src.match(/sendCommand\(skipCommandForMount\(config\.icecast\?\.mount\)\)/g) ?? [];
    assert.equal(derived.length, 2, 'skip + force-next both derive the command');
    // the pin is on CALL SITES -- the explanatory comment above the helper
    // legitimately quotes the old literal as history.
    assert.doesNotMatch(src, /sendCommand\('\/stream\.skip'\)/, 'no handler may pass the hardcoded command');
    // verification comments kept: the WHY for output-vs-show_source skipping
    assert.match(src, /Confirmed live against this Liquidsoap build/);
  });
});
