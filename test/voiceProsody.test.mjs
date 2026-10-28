// Tests for P4 #26 voice prosody knobs (the research pass's finding that
// pace IS naturalness):
//   A. edge prosody: persona override > global config; only set keys sent;
//      empty config = undefined (byte-identical request as before),
//   B. piper length scale: flag omitted at 1/undefined, added otherwise.
// Val 33 (dnevni profili govora) -- a daypart layer between persona and
// global, keyed by the timeOfDayBlocks block names:
//   C. edge resolution matrix: persona > daypart > global PER KEY; unknown
//      or null block key = config-only (timeless); junk shapes fail open;
//      synthesis-moment resolution pinned structurally; config.example.json
//      ships the daypart curve,
//   D. piper parity: piperLengthScaleFor mirrors the same chain;
//      synthesizePiper wires the injected blockKey; pre-generate-clips.mjs
//      opts station-level clips out (blockKey null -- imaging is timeless).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('prosody', {
  autoRadio: {
    enabled: true,
    stationName: 'Test Station',
    music: { source: 'local', localDirs: [] },
    rules: { artistCooldownHours: 3 },
    voice: {
      mode: 'none',
      edgeRate: '-8%',
      edgePitch: '-2Hz',
      piperLengthScale: 1.1,
      daypartProsody: {
        morning: { edgeRate: '-3%' },
        night: { edgeRate: '-12%', piperLengthScale: 1.15 },
      },
      personas: { jure: { edgeRate: '+2%', piperLengthScale: 0.95 } },
    },
  },
});

const { edgeProsodyForPersona } = await import('../src/auto/edgeTts.js');
const { buildPiperArgs, piperLengthScaleFor } = await import('../src/auto/piperVoice.js');
const { daypartProsodyProfile } = await import('../src/auto/rules.js');
const { config } = await import('../src/config/index.js');

// A-series calls pin an explicit blockKey ('daytime' has NO profile in this
// config), so they stay wall-clock-independent now that the daypart layer
// exists -- the default parameter resolves the real clock only in production.
describe('edge prosody config', () => {
  test('persona override wins over global for the same key', () => {
    assert.deepEqual(edgeProsodyForPersona('jure', 'daytime'), { rate: '+2%', pitch: '-2Hz' });
  });

  test('global fallback fills keys the persona does not set', () => {
    assert.deepEqual(edgeProsodyForPersona('elena', 'daytime'), { rate: '-8%', pitch: '-2Hz' });
  });

  test('unknown persona inherits the global prosody', () => {
    assert.deepEqual(edgeProsodyForPersona('novid', 'daytime'), { rate: '-8%', pitch: '-2Hz' });
  });
});

describe('piper length scale', () => {
  const base = { model: 'sl_SI-artur-medium', isKey: true, dataDir: 'd', textFile: 't.txt', outPath: 'o.wav' };

  test('flag omitted at default 1 and when unset (no behavior change)', () => {
    assert.ok(!buildPiperArgs({ ...base }).join(' ').includes('length-scale'));
    assert.ok(!buildPiperArgs({ ...base, lengthScale: 1 }).join(' ').includes('length-scale'));
    assert.ok(!buildPiperArgs({ ...base, lengthScale: null }).join(' ').includes('length-scale'));
  });

  test('other values add --length-scale verbatim', () => {
    assert.match(buildPiperArgs({ ...base, lengthScale: 1.1 }).join(' '), /--length-scale 1\.1/);
    assert.match(buildPiperArgs({ ...base, lengthScale: 0.95 }).join(' '), /--length-scale 0\.95/);
  });
});

describe('Val 33 edge daypart prosody', () => {
  test('daypart fills the keys the persona does not set (rate from the block, pitch from global)', () => {
    assert.deepEqual(edgeProsodyForPersona('elena', 'morning'), { rate: '-3%', pitch: '-2Hz' });
  });

  test('persona beats daypart for the same key -- tuning a voice opts it out of pacing for that key', () => {
    assert.deepEqual(edgeProsodyForPersona('jure', 'morning'), { rate: '+2%', pitch: '-2Hz' });
  });

  test('daypart beats global; an unprofiled block falls back to global', () => {
    assert.deepEqual(edgeProsodyForPersona('elena', 'night'), { rate: '-12%', pitch: '-2Hz' });
    assert.deepEqual(edgeProsodyForPersona('elena', 'daytime'), { rate: '-8%', pitch: '-2Hz' });
  });

  test('unknown block key and null block key are config-only (timeless resolution)', () => {
    assert.deepEqual(edgeProsodyForPersona('elena', 'jutro'), { rate: '-8%', pitch: '-2Hz' });
    assert.deepEqual(edgeProsodyForPersona('elena', null), { rate: '-8%', pitch: '-2Hz' });
  });

  test('daypartProsodyProfile fails open on every junk shape (top level and profile level)', () => {
    const voice = config.autoRadio.voice;
    const original = voice.daypartProsody;
    try {
      voice.daypartProsody = ['morning'];
      assert.deepEqual(daypartProsodyProfile('morning'), {});
      voice.daypartProsody = 'morning';
      assert.deepEqual(daypartProsodyProfile('morning'), {});
      voice.daypartProsody = { morning: '-3%' };
      assert.deepEqual(daypartProsodyProfile('morning'), {});
      voice.daypartProsody = { morning: ['-3%'] };
      assert.deepEqual(daypartProsodyProfile('morning'), {});
      voice.daypartProsody = { morning: null };
      assert.deepEqual(daypartProsodyProfile('morning'), {});
      delete voice.daypartProsody;
      assert.deepEqual(daypartProsodyProfile('morning'), {});
      voice.daypartProsody = original;
      assert.deepEqual(daypartProsodyProfile(null), {});
      assert.deepEqual(daypartProsodyProfile(''), {});
    } finally {
      voice.daypartProsody = original;
    }
  });

  test('synthesis-moment resolution is wired (structural pins, backupStation source-pin precedent)', () => {
    const edgeSrc = fs.readFileSync(new URL('../src/auto/edgeTts.js', import.meta.url), 'utf8');
    // the default parameter resolves the block at the synthesis moment...
    assert.match(edgeSrc, /blockKey = timeBlockKey\(\)/);
    // ...and synthesizeWithEdge still calls the resolver with that default
    // (no frozen block, no call-site threading).
    assert.match(edgeSrc, /edgeProsodyForPersona\(persona\)/);
  });

  test('config.example.json ships the daypart curve (jutro -3%, večer -8%, noč -11%; dan dedi globalni -6%)', () => {
    const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    assert.deepEqual(example.autoRadio?.voice?.daypartProsody, {
      morning: { edgeRate: '-3%' },
      evening: { edgeRate: '-8%' },
      night: { edgeRate: '-11%' },
    });
  });
});

describe('Val 33 piper daypart parity', () => {
  test('piperLengthScaleFor mirrors the edge chain: persona > daypart > global; unknown/null block = global', () => {
    assert.equal(piperLengthScaleFor('jure', 'morning'), 0.95);
    assert.equal(piperLengthScaleFor('elena', 'night'), 1.15);
    assert.equal(piperLengthScaleFor('elena', 'daytime'), 1.1);
    assert.equal(piperLengthScaleFor('novid', 'morning'), 1.1); // morning profile sets no piperLengthScale
    assert.equal(piperLengthScaleFor('novid', 'jutro'), 1.1);
    assert.equal(piperLengthScaleFor('novid', null), 1.1);
  });

  test('synthesizePiper wires the injected blockKey; pre-generate opts station clips out (structural pins)', () => {
    const piperSrc = fs.readFileSync(new URL('../src/auto/piperVoice.js', import.meta.url), 'utf8');
    assert.match(piperSrc, /blockKey = timeBlockKey\(\)/);
    assert.match(piperSrc, /lengthScale: piperLengthScaleFor\(persona, blockKey\)/);
    const pregen = fs.readFileSync(new URL('../pre-generate-clips.mjs', import.meta.url), 'utf8');
    assert.match(pregen, /synthesizePiper\(text, rawFile, null, \{ blockKey: null \}\)/);
  });
});
