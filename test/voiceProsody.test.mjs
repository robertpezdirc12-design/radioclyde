// Tests for P4 #26 voice prosody knobs (the research pass's finding that
// pace IS naturalness):
//   A. edge prosody: persona override > global config; only set keys sent;
//      empty config = undefined (byte-identical request as before),
//   B. piper length scale: flag omitted at 1/undefined, added otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

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
      personas: { jure: { edgeRate: '+2%', piperLengthScale: 0.95 } },
    },
  },
});

const { edgeProsodyForPersona } = await import('../src/auto/edgeTts.js');
const { buildPiperArgs } = await import('../src/auto/piperVoice.js');

describe('edge prosody config', () => {
  test('persona override wins over global for the same key', () => {
    assert.deepEqual(edgeProsodyForPersona('jure'), { rate: '+2%', pitch: '-2Hz' });
  });

  test('global fallback fills keys the persona does not set', () => {
    assert.deepEqual(edgeProsodyForPersona('elena'), { rate: '-8%', pitch: '-2Hz' });
  });

  test('unknown persona inherits the global prosody', () => {
    assert.deepEqual(edgeProsodyForPersona('novid'), { rate: '-8%', pitch: '-2Hz' });
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
