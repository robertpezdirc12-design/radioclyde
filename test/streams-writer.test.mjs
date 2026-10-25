// streams.liq generator (src/liquidsoap/streamsLiqWriter.js): the frozen
// template contract with radio.liq's %include. The exact all-disabled /
// opus / flac / archive / all-three contents are pinned byte-for-byte --
// a one-character drift in the generated file changes what every box boots
// with, so it must be a conscious change, never an accident. The write
// discipline (idempotent, atomic, never throws) is pinned the same way.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('streams-writer', {});

const {
  buildStreamsLiq,
  writeStreamsLiq,
  clampToLadder,
  clampOpusBitrate,
  clampArchiveBitrate,
  opusEnabled,
  flacEnabled,
  archiveEnabled,
  mountBaseOf,
  streamsLiqDir,
  streamsLiqPath,
} = await import('../src/liquidsoap/streamsLiqWriter.js');

// The config-like objects are pure inputs -- buildStreamsLiq must not read
// the live config, the clock, or the filesystem.
const BASE = {
  dataDir: '/radio',
  icecast: { sourceHost: 'localhost', port: 8001, sourcePassword: 'pw', mount: '/stream.mp3' },
};

const HEADER = `# streams.liq -- optional mounts + hourly archive (GENERATED, do not edit)
#
# Regenerated at every radioclyde boot by src/liquidsoap/streamsLiqWriter.js
# from config.json's icecast.opus / icecast.flac / archive blocks, with LITERAL
# values (host, port, password, bitrate rungs): the encoders' bitrate
# arguments are parse-time constants in Liquidsoap, so they cannot come from a
# runtime config read, and radio.liq's typed json.parse of config.json stays
# untouched so older configs keep booting. radio.liq %includes this file right
# after the primary MP3 output -- the \`radio\` variable is in scope there, and
# every block below feeds it to one more encoder (SUB/WAVE's
# make_stream_outputs fans one source to N outputs; no crossfeed wiring).
#
# Provenance: SUB/WAVE's make_stream_outputs (liquidsoap/radio.liq in
# perminder-klair/subwave, MIT): %opus(samplerate=48000, channels=2,
# application="audio", vbr="constrained") on the [96,128,192,256,320] ladder,
# %ogg(%flac(samplerate=44100, channels=2, compression=5,
# bits_per_sample=16)) with send_icy_metadata=false, and the hourly archive's
# output.file(reopen_when={0m0s}) fed by the {time.string(...)} path getter
# (the GETTER re-runs strftime at every reopen; a bare string writes one
# literal "%Y-%m-%d/%H-00.mp3" file, truncated hourly). The archive block is
# gated %ifversion >= 2.4.6 because that getter form needs 2.4.6+; the
# opus/flac encoders exist on every supported build. Toggle by editing
# config.json, then restarting radioclyde and liquidsoap-radioclyde
# (docs/stream-mounts.md).`;

// Exactly five lines -- the frozen all-disabled shape.
const ALL_OFF = `# All optional outputs are OFF (icecast.opus.enabled, icecast.flac.enabled,
# archive.enabled are not exactly true in config.json): this file is
# comment-only, the primary MP3 output in radio.liq stays the only encoder,
# and every supported Liquidsoap build parses it identically. Hand edits
# survive only until the next web restart -- change config.json instead.`;

const OPUS_BLOCK = `# --- /stream.opus (opt-in; SUB/WAVE: 48 kHz constrained VBR) --------
# The 44.1 -> 48 kHz resample is part of the deal (Opus mandates 48 kHz
# internally); application="audio" is the music tuning. send_icy_metadata=
# false selects the encoder's native chained-Ogg tags -- external ICY is
# the legacy compat mode SUB/WAVE keeps behind a toggle, and this station
# has no consumer for it. Bitrate was clamped by the writer to the
# [96,128,192,256,320] rungs (below 96 reads as 96, above 320 as 320).
output.icecast(%opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="constrained"),
  id="stream_opus", fallible=true, send_icy_metadata=false,
  host="localhost", port=8001, password="pw",
  mount="/stream.opus",
  radio)`;

const FLAC_BLOCK = `# --- /stream.flac (opt-in; Ogg-FLAC, ~800-900 kbps, no bitrate dial) -
# %ogg(%flac) is the streamable FLAC wrapper (file-oriented %flac is not);
# no resample, compression=5 is the FLAC default, 16-bit is universally
# decodable. send_icy_metadata=false ALWAYS -- SUB/WAVE's rule: Icecast
# does not apply external ICY updates to this codec, so the encoder's
# native chained tags are the only metadata path that works.
output.icecast(%ogg(%flac(samplerate=44100, channels=2, compression=5, bits_per_sample=16)),
  id="stream_flac", fallible=true, send_icy_metadata=false,
  host="localhost", port=8001, password="pw",
  mount="/stream.flac",
  radio)`;

const ARCHIVE_BLOCK = (bitrate, escapedDir) => `# --- hourly MP3 archive (opt-in; SUB/WAVE's output.file mechanism) ------
# reopen_when={0m0s} reopens the file at minute 0, second 0 of every hour,
# and the {time.string(...)} GETTER re-runs strftime at every reopen, so
# the path rolls day by day, hour by hour. Bitrate was clamped by the
# writer to the [64,96,128,160,192,320] rungs. Gated %ifversion >= 2.4.6:
# the time.string getter form needs 2.4.6+; on an older build the archive
# is skipped with the note below and the mounts above are unaffected.
# Built here so it follows the on-air lifecycle like SUB/WAVE's: off air
# stops the recording instead of taping the emergency loop.
%ifversion >= 2.4.6
output.file(%mp3(bitrate=${bitrate}), fallible=true, reopen_when={0m0s},
  {time.string("${escapedDir}/archive/%Y-%m-%d/%H-00.mp3")},
  radio)
%else
# Hourly archive skipped: this Liquidsoap build is older than 2.4.6 and
# the time.string getter form above needs 2.4.6+. The mounts are fine.
%endif`;

function tmpTarget() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'streams-liq-')), 'streams.liq');
}

describe('buildStreamsLiq frozen templates', () => {
  test('all disabled -> header + the exact 5-line comment, nothing else', () => {
    assert.equal(buildStreamsLiq(BASE), `${HEADER}\n\n${ALL_OFF}\n`);
  });

  test('a config without any of the new blocks is the same all-disabled file', () => {
    assert.equal(buildStreamsLiq({ dataDir: '/radio', icecast: { mount: '/stream' } }), `${HEADER}\n\n${ALL_OFF}\n`);
  });

  test('opus only -> exact block, bitrate clamped to the rung below', () => {
    const out = buildStreamsLiq({ ...BASE, icecast: { ...BASE.icecast, opus: { enabled: true, bitrate: 100 } } });
    assert.equal(out, `${HEADER}\n\n${OPUS_BLOCK}\n`);
  });

  test('flac only -> exact block (no bitrate dial exists)', () => {
    const out = buildStreamsLiq({ ...BASE, icecast: { ...BASE.icecast, flac: { enabled: true } } });
    assert.equal(out, `${HEADER}\n\n${FLAC_BLOCK}\n`);
  });

  test('archive only -> exact gated block, path liq-escaped, 999 clamps to 320', () => {
    // dataDir C:\weird"path (raw) -> C:\\weird\"path in the Liquidsoap string
    const out = buildStreamsLiq({ ...BASE, dataDir: 'C:\\weird"path', archive: { enabled: true, bitrate: 999 } });
    assert.equal(out, `${HEADER}\n\n${ARCHIVE_BLOCK(320, 'C:\\\\weird\\"path')}\n`);
  });

  test('all three -> opus, flac, archive blocks in order, blank-line separated', () => {
    const out = buildStreamsLiq({
      ...BASE,
      archive: { enabled: true, bitrate: 128 },
      icecast: { ...BASE.icecast, opus: { enabled: true, bitrate: 96 }, flac: { enabled: true } },
    });
    assert.equal(out, `${HEADER}\n\n${OPUS_BLOCK}\n\n${FLAC_BLOCK}\n\n${ARCHIVE_BLOCK(128, '/radio')}\n`);
  });

  test('mount without .mp3 suffix is its own base for the sibling mounts', () => {
    const out = buildStreamsLiq({ ...BASE, icecast: { ...BASE.icecast, mount: '/radio', opus: { enabled: true } } });
    assert.ok(out.includes('mount="/radio.opus"'));
    assert.ok(!out.includes('mount="/stream'));
  });
});

describe('bitrate ladder clamps (SUB/WAVE rungs)', () => {
  test('opus: 100->96, 200->192, 999->320, 50->96', () => {
    assert.equal(clampOpusBitrate(100), 96);
    assert.equal(clampOpusBitrate(200), 192);
    assert.equal(clampOpusBitrate(999), 320);
    assert.equal(clampOpusBitrate(50), 96);
  });

  test('opus: absent/NaN/junk falls back to the 96 default', () => {
    assert.equal(clampOpusBitrate(undefined), 96);
    assert.equal(clampOpusBitrate(null), 96);
    assert.equal(clampOpusBitrate('96'), 96);
    assert.equal(clampOpusBitrate(Number.NaN), 96);
  });

  test('archive: 100->96, 150->128, 999->320, 50->64', () => {
    assert.equal(clampArchiveBitrate(100), 96);
    assert.equal(clampArchiveBitrate(150), 128);
    assert.equal(clampArchiveBitrate(999), 320);
    assert.equal(clampArchiveBitrate(50), 64);
  });

  test('archive: absent/junk falls back to the 128 default', () => {
    assert.equal(clampArchiveBitrate(undefined), 128);
    assert.equal(clampArchiveBitrate('128'), 128);
    assert.equal(clampArchiveBitrate(Number.NaN), 128);
  });

  test('clampToLadder: exact rungs pass through; below floors to first rung', () => {
    assert.equal(clampToLadder(192, [96, 128, 192, 256, 320], 96), 192);
    assert.equal(clampToLadder(1, [96, 128], 96), 96);
    assert.equal(clampToLadder(undefined, [96, 128], 42), 42);
  });
});

describe('enabled gating is strict === true', () => {
  test('opus: only the boolean true counts as on', () => {
    assert.equal(opusEnabled({ icecast: { opus: { enabled: true } } }), true);
    assert.equal(opusEnabled({ icecast: { opus: { enabled: 'true' } } }), false);
    assert.equal(opusEnabled({ icecast: { opus: { enabled: 1 } } }), false);
    assert.equal(opusEnabled({ icecast: { opus: { enabled: 'yes' } } }), false);
    assert.equal(opusEnabled({ icecast: { opus: {} } }), false);
    assert.equal(opusEnabled({ icecast: {} }), false);
    assert.equal(opusEnabled({}), false);
    assert.equal(opusEnabled(undefined), false);
  });

  test('flac + archive: same strict rule, top-level archive block', () => {
    assert.equal(flacEnabled({ icecast: { flac: { enabled: true } } }), true);
    assert.equal(flacEnabled({ icecast: { flac: { enabled: 'true' } } }), false);
    assert.equal(archiveEnabled({ archive: { enabled: true } }), true);
    assert.equal(archiveEnabled({ archive: { enabled: 1 } }), false);
    assert.equal(archiveEnabled({}), false);
  });
});

describe('mountBaseOf + generated-file location', () => {
  test('trailing .mp3 is stripped; everything else passes through', () => {
    assert.equal(mountBaseOf('/stream.mp3'), '/stream');
    assert.equal(mountBaseOf('/stream'), '/stream');
    assert.equal(mountBaseOf('/radio.mp3'), '/radio');
    assert.equal(mountBaseOf('/stream.mp2'), '/stream.mp2'); // only .mp3 is a mount suffix
    assert.equal(mountBaseOf(undefined), undefined);
  });

  test('streamsLiqPath resolves to the repo liquidsoap/ dir, cwd-independent', () => {
    assert.equal(path.basename(streamsLiqDir), 'liquidsoap');
    assert.equal(streamsLiqPath, path.join(streamsLiqDir, 'streams.liq'));
    assert.ok(fs.existsSync(streamsLiqDir), 'the liquidsoap dir radio.liq lives in');
  });
});

describe('writeStreamsLiq discipline', () => {
  test('writes when the target differs; content matches; no tmp leftover', () => {
    const target = tmpTarget();
    const result = writeStreamsLiq(target);
    assert.deepEqual(result, { written: true, enabled: { opus: false, flac: false, archive: false }, error: null });
    assert.equal(fs.readFileSync(target, 'utf8'), `${HEADER}\n\n${ALL_OFF}\n`);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['streams.liq']);
  });

  test('idempotent: byte-identical -> no write, mtime stays stable', () => {
    const target = tmpTarget();
    writeStreamsLiq(target);
    const before = fs.statSync(target).mtimeMs;
    const result = writeStreamsLiq(target);
    assert.equal(result.written, false);
    assert.equal(result.error, null);
    assert.equal(fs.statSync(target).mtimeMs, before);
  });

  test('unwritable target never throws; honest error in the result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streams-liq-'));
    const result = writeStreamsLiq(dir); // target IS a directory -> rename fails
    assert.equal(result.written, false);
    assert.ok(result.error, 'an honest error message, not a silent nothing');
  });
});
