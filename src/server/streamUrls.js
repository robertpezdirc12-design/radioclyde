// The ONE source of truth for every URL the station publishes for its
// streams (SUB/WAVE's discovery surfaces, Node half): the playlist files
// (/listen.m3u, /listen.pls), /api/now-playing's station.streams, and the
// config-gated /stream.opus // /stream.flac proxy routes all derive from
// here, so every surface names the same endpoints.
//
// URL resolution, in priority order (same precedence the TuneIn/Discord push
// uses, see broadcast/nowPlayingPush.js -- resolveStreamUrl moved here
// unchanged from listenFiles.js, which re-exports it):
//   1. config.broadcast.publicStreamUrl -- the owner-declared public URL,
//      correct behind Cloudflare Tunnel / reverse proxies / custom domains
//   2. derived from config.icecast.publicHost + config.web.port + mount --
//      the exact composition nowPlaying.js's station.streamUrl() reports
//
// Optional-mount gating (opus/flac) is imported from
// liquidsoap/streamsLiqWriter.js on purpose: the .liq generator and this URL
// surface must agree on what "enabled" means (strict === true) and on the
// bitrate rung (SUB/WAVE ladder clamp), or the playlist would advertise a
// mount Liquidsoap never builds.
import { config } from '../config/index.js';
import { opusEnabled, flacEnabled, clampOpusBitrate } from '../liquidsoap/streamsLiqWriter.js';

export function resolveStreamUrl() {
  const declared = config.broadcast?.publicStreamUrl;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return `http://${config.icecast.publicHost}:${config.web.port}${config.icecast.mount}`;
}

// "/stream.mp3" (or an override URL ending in .mp3) -> "/stream": sibling
// mounts/files hang off the base with their own suffix. Anything without the
// trailing .mp3 passes through unchanged.
export function stripMp3Suffix(urlOrMount) {
  if (typeof urlOrMount !== 'string') return urlOrMount;
  return urlOrMount.endsWith('.mp3') ? urlOrMount.slice(0, -4) : urlOrMount;
}

// URL of an optional sibling mount (".opus" / ".flac"): the owner-declared
// publicStreamUrl wins (stripped of its own .mp3 suffix) so siblings live on
// the same public origin; otherwise the same publicHost:webport derivation
// resolveStreamUrl() uses, with the mount base in place of the mount.
export function siblingStreamUrl(suffix) {
  const declared = config.broadcast?.publicStreamUrl;
  if (typeof declared === 'string' && declared.trim()) {
    return `${stripMp3Suffix(declared.trim())}${suffix}`;
  }
  const base = stripMp3Suffix(config.icecast.mount);
  return `http://${config.icecast.publicHost}:${config.web.port}${base}${suffix}`;
}

// Every stream this station currently publishes, in a stable order: MP3
// always first (the universal floor), Opus only when enabled (bitrate
// clamped to the SUB/WAVE rung the .liq generator will emit), FLAC last
// (no bitrate field -- lossless has no dial). Callers may rely on the
// first entry always being the MP3 mount.
export function streamEntries() {
  const entries = [
    {
      url: resolveStreamUrl(),
      format: 'mp3',
      bitrate: Number.isFinite(config.icecast?.bitrate) ? config.icecast.bitrate : 192,
    },
  ];
  if (opusEnabled(config)) {
    entries.push({
      url: siblingStreamUrl('.opus'),
      format: 'opus',
      bitrate: clampOpusBitrate(config.icecast?.opus?.bitrate),
    });
  }
  if (flacEnabled(config)) {
    entries.push({ url: siblingStreamUrl('.flac'), format: 'flac' });
  }
  return entries;
}
