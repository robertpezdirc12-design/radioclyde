// Generates liquidsoap/streams.liq -- the optional-mounts + hourly-archive
// half of the SUB/WAVE port (docs/stream-mounts.md). radio.liq %includes
// this file right after the primary MP3 output, where the `radio` variable
// is still in scope, so every generated output block simply feeds `radio` to
// one more encoder -- SUB/WAVE's make_stream_outputs fans one source to N
// outputs; no crossfeed wiring needed.
//
// Why a generator instead of runtime Liquidsoap config reads: the encoders'
// bitrate arguments are PARSE-TIME literals in Liquidsoap (SUB/WAVE's own
// make_stream_outputs comment: "%mp3/%opus/%fdkaac(bitrate=...) each need a
// parse-time literal int -- a ref won't do"), and radio.liq's typed
// json.parse of config.json stays untouched so older configs keep booting.
// Node therefore clamps the configured bitrate to SUB/WAVE's rung sets and
// emits the literal, next to literal host/port/password values.
//
// Frozen contract with radio.liq's %include: enabled blocks are separated by
// blank lines in opus, flac, archive order; the all-disabled shape is a
// 5-line comment, so a fresh clone, a config.json without the new blocks,
// and a pre-2.4.6 Liquidsoap box all boot byte-identically to the
// pre-streams state. The file is rewritten atomically and idempotently at
// every radioclyde boot (writeStreamsLiq below) -- hand edits survive
// only until the next restart; change config.json instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// liquidsoap/ sits at the repo root next to src/, resolved from this
// module's own location (never cwd) -- same derivation style as
// config/index.js's configPath, so the writer works from any working dir.
export const streamsLiqDir = path.resolve(__dirname, '..', '..', 'liquidsoap');
export const streamsLiqPath = path.join(streamsLiqDir, 'streams.liq');

const log = createLogger('station');

// SUB/WAVE's rung sets (controller/src/schemas/settings.ts:
// SETTINGS_OPUS_BITRATES and SETTINGS_MP3_BITRATES -- the archive reuses the
// MP3 ladder). Liquidsoap needs the parse-time literal, so Node picks the
// rung and emits it.
const OPUS_BITRATES = [96, 128, 192, 256, 320];
const ARCHIVE_BITRATES = [64, 96, 128, 160, 192, 320];

// Strict === true on purpose: a typo'd value ("true", 1, "yes", "on") must
// read as OFF, never as a surprise second encoder on the next boot.
export function opusEnabled(configLike) {
  return configLike?.icecast?.opus?.enabled === true;
}

export function flacEnabled(configLike) {
  return configLike?.icecast?.flac?.enabled === true;
}

export function archiveEnabled(configLike) {
  return configLike?.archive?.enabled === true;
}

// Largest rung <= value: a value below the ladder floors to the first rung,
// above it caps at the last; a non-finite/absent value falls back to
// `fallback` (SUB/WAVE's own defaults: 96 opus, 128 archive).
export function clampToLadder(value, ladder, fallback) {
  if (!Number.isFinite(value)) return fallback;
  let chosen = ladder[0];
  for (const rung of ladder) {
    if (rung <= value) chosen = rung;
  }
  return chosen;
}

export function clampOpusBitrate(value) {
  return clampToLadder(value, OPUS_BITRATES, 96);
}

export function clampArchiveBitrate(value) {
  return clampToLadder(value, ARCHIVE_BITRATES, 128);
}

// "/stream.mp3" -> "/stream": sibling mounts hang off the mount base. A
// mount without the trailing .mp3 is its own base and passes through.
export function mountBaseOf(mount) {
  if (typeof mount !== 'string') return mount;
  return mount.endsWith('.mp3') ? mount.slice(0, -4) : mount;
}

// Liquidsoap double-quoted-string escape (backslash first, then the quote) --
// enough for a filesystem path or a password to survive verbatim.
function liqString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const HEADER = [
  '# streams.liq -- optional mounts + hourly archive (GENERATED, do not edit)',
  '#',
  '# Regenerated at every radioclyde-web boot by src/liquidsoap/streamsLiqWriter.js',
  '# from config.json\'s icecast.opus / icecast.flac / archive blocks, with LITERAL',
  '# values (host, port, password, bitrate rungs): the encoders\' bitrate',
  '# arguments are parse-time constants in Liquidsoap, so they cannot come from a',
  '# runtime config read, and radio.liq\'s typed json.parse of config.json stays',
  '# untouched so older configs keep booting. radio.liq %includes this file right',
  '# after the primary MP3 output -- the `radio` variable is in scope there, and',
  '# every block below feeds it to one more encoder (SUB/WAVE\'s',
  '# make_stream_outputs fans one source to N outputs; no crossfeed wiring).',
  '#',
  '# Provenance: SUB/WAVE\'s make_stream_outputs (liquidsoap/radio.liq in',
  '# perminder-klair/subwave, MIT): %opus(samplerate=48000, channels=2,',
  '# application="audio", vbr="constrained") on the [96,128,192,256,320] ladder,',
  '# %ogg(%flac(samplerate=44100, channels=2, compression=5,',
  '# bits_per_sample=16)) with send_icy_metadata=false, and the hourly archive\'s',
  '# output.file(reopen_when={0m0s}) fed by the {time.string(...)} path getter',
  '# (the GETTER re-runs strftime at every reopen; a bare string writes one',
  '# literal "%Y-%m-%d/%H-00.mp3" file, truncated hourly). The archive block is',
  '# gated %ifversion >= 2.4.6 because that getter form needs 2.4.6+; the',
  '# opus/flac encoders exist on every supported build. Toggle by editing',
  '# config.json, then restarting radioclyde-web and liquidsoap',
  '# (docs/stream-mounts.md).',
].join('\n');

// Exactly five lines -- the frozen all-disabled shape.
const ALL_OFF_COMMENT = [
  '# All optional outputs are OFF (icecast.opus.enabled, icecast.flac.enabled,',
  '# archive.enabled are not exactly true in config.json): this file is',
  '# comment-only, the primary MP3 output in radio.liq stays the only encoder,',
  '# and every supported Liquidsoap build parses it identically. Hand edits',
  '# survive only until the next web restart -- change config.json instead.',
].join('\n');

function opusBlock({ host, port, password, mountBase, bitrate }) {
  return [
    `# --- ${mountBase}.opus (opt-in; SUB/WAVE: 48 kHz constrained VBR) --------`,
    '# The 44.1 -> 48 kHz resample is part of the deal (Opus mandates 48 kHz',
    '# internally); application="audio" is the music tuning. send_icy_metadata=',
    '# false selects the encoder\'s native chained-Ogg tags -- external ICY is',
    '# the legacy compat mode SUB/WAVE keeps behind a toggle, and this station',
    '# has no consumer for it. Bitrate was clamped by the writer to the',
    '# [96,128,192,256,320] rungs (below 96 reads as 96, above 320 as 320).',
    `output.icecast(%opus(bitrate=${bitrate}, samplerate=48000, channels=2, application="audio", vbr="constrained"),`,
    '  id="stream_opus", fallible=true, send_icy_metadata=false,',
    `  host="${host}", port=${port}, password="${password}",`,
    `  mount="${mountBase}.opus",`,
    '  radio)',
  ].join('\n');
}

function flacBlock({ host, port, password, mountBase }) {
  return [
    `# --- ${mountBase}.flac (opt-in; Ogg-FLAC, ~800-900 kbps, no bitrate dial) -`,
    '# %ogg(%flac) is the streamable FLAC wrapper (file-oriented %flac is not);',
    '# no resample, compression=5 is the FLAC default, 16-bit is universally',
    '# decodable. send_icy_metadata=false ALWAYS -- SUB/WAVE\'s rule: Icecast',
    '# does not apply external ICY updates to this codec, so the encoder\'s',
    '# native chained tags are the only metadata path that works.',
    'output.icecast(%ogg(%flac(samplerate=44100, channels=2, compression=5, bits_per_sample=16)),',
    '  id="stream_flac", fallible=true, send_icy_metadata=false,',
    `  host="${host}", port=${port}, password="${password}",`,
    `  mount="${mountBase}.flac",`,
    '  radio)',
  ].join('\n');
}

function archiveBlock({ archiveDir, bitrate }) {
  return [
    '# --- hourly MP3 archive (opt-in; SUB/WAVE\'s output.file mechanism) ------',
    '# reopen_when={0m0s} reopens the file at minute 0, second 0 of every hour,',
    '# and the {time.string(...)} GETTER re-runs strftime at every reopen, so',
    '# the path rolls day by day, hour by hour. Bitrate was clamped by the',
    '# writer to the [64,96,128,160,192,320] rungs. Gated %ifversion >= 2.4.6:',
    '# the time.string getter form needs 2.4.6+; on an older build the archive',
    '# is skipped with the note below and the mounts above are unaffected.',
    '# Built here so it follows the on-air lifecycle like SUB/WAVE\'s: off air',
    '# stops the recording instead of taping the emergency loop.',
    '%ifversion >= 2.4.6',
    `output.file(%mp3(bitrate=${bitrate}), fallible=true, reopen_when={0m0s},`,
    `  {time.string("${liqString(archiveDir)}/archive/%Y-%m-%d/%H-00.mp3")},`,
    '  radio)',
    '%else',
    '# Hourly archive skipped: this Liquidsoap build is older than 2.4.6 and',
    '# the time.string getter form above needs 2.4.6+. The mounts are fine.',
    '%endif',
  ].join('\n');
}

// PURE: builds the exact file content for a config-like object. No reads, no
// writes, no clock -- everything derives from the argument, so tests can pin
// the frozen template byte-for-byte.
export function buildStreamsLiq(configLike = {}) {
  const icecast = configLike?.icecast ?? {};
  const host = liqString(icecast.sourceHost ?? '127.0.0.1');
  const port = Number.isFinite(icecast.port) ? icecast.port : 8001;
  const password = liqString(icecast.sourcePassword ?? '');
  const mountBase = mountBaseOf(typeof icecast.mount === 'string' ? icecast.mount : '/stream');
  const literals = { host, port, password, mountBase };

  const blocks = [HEADER];
  if (opusEnabled(configLike)) {
    blocks.push(opusBlock({ ...literals, bitrate: clampOpusBitrate(icecast.opus?.bitrate) }));
  }
  if (flacEnabled(configLike)) {
    blocks.push(flacBlock(literals));
  }
  if (archiveEnabled(configLike)) {
    blocks.push(
      archiveBlock({
        archiveDir: typeof configLike?.dataDir === 'string' ? configLike.dataDir : '',
        bitrate: clampArchiveBitrate(configLike?.archive?.bitrate),
      })
    );
  }
  if (blocks.length === 1) blocks.push(ALL_OFF_COMMENT);
  return `${blocks.join('\n\n')}\n`;
}

// Boot-time write: idempotent (byte-identical content -> no write at all, so
// the mtime stays stable and `systemctl restart liquidsoap` decisions based
// on the file's timestamp are not poisoned), atomic (tmp-<pid> + rename, the
// same discipline every other generated file in this repo uses), and never
// throws -- a failure is logged via the station log and returned honestly,
// because the web process must keep listening even when the liquidsoap dir
// is unwritable.
export function writeStreamsLiq(targetPath = streamsLiqPath) {
  const enabled = {
    opus: opusEnabled(config),
    flac: flacEnabled(config),
    archive: archiveEnabled(config),
  };
  try {
    const content = buildStreamsLiq(config);
    let existing = null;
    try {
      existing = fs.readFileSync(targetPath, 'utf8');
    } catch {
      existing = null; // no file yet (fresh clone) -- plain write below
    }
    if (existing === content) return { written: false, enabled, error: null };
    const tmp = `${targetPath}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, targetPath);
    return { written: true, enabled, error: null };
  } catch (err) {
    log(`streams.liq write ERROR: ${err.stack || err.message}`);
    return { written: false, enabled, error: err.message };
  }
}
