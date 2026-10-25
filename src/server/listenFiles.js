// /listen.m3u + /listen.pls -- one-line playlist files for hardware and
// desktop players (Sonos, VLC, car head units, MPD, older smart radios).
// The same "ancient hardware" integration SUB/WAVE markets, served as two
// tiny static-format responses with zero dependencies.
//
// URL resolution lives in streamUrls.js (the one source of truth for every
// published stream URL): resolveStreamUrl() is re-exported below so the
// existing imports and tests keep working unchanged. When optional mounts
// are enabled (config.icecast.opus / .flac), the files list EVERY enabled
// entry -- SUB/WAVE's playlist surfaces do the same, so a player that
// understands Opus/FLAC can pick its best fit from one file.
//
// Backwards-compat contract: with all optional mounts off (the shipped
// default), the bodies stay BYTE-IDENTICAL to the pre-mounts output -- the
// format suffixes ("MP3 192k" / "Opus 96k" / "FLAC (brezizgubno)") are added
// per entry ONLY when more than one entry is listed, because a single-entry
// file that suddenly grew a suffix would change what every pinned player,
// cached copy and regression test has seen so far.
//
// Auth note: the global Basic Auth hook (auth.js) runs before these routes
// like everything else, so the playlist is only handed to someone who can
// already reach /stream. When the station later opens selected paths via
// config.web.publicPaths (see auth.js), these files work for anonymous
// players too -- no code change, just the config flip.
import { streamEntries, resolveStreamUrl } from './streamUrls.js';
import { loadStation } from '../scheduler/scheduleUtil.js';

// Kept for every existing importer (tests, embeds, operator scripts).
export { resolveStreamUrl };

function stationName() {
  try {
    return loadStation().name ?? 'Radio Markec';
  } catch {
    return 'Radio Markec';
  }
}

// Slovenian format labels for the multi-entry case: the suffix is what tells
// a human picking between three URLs in a car head unit which line is which.
function entryLabel(entry) {
  if (entry.format === 'opus') return `Opus ${entry.bitrate}k`;
  if (entry.format === 'flac') return 'FLAC (brezizgubno)';
  return `MP3 ${entry.bitrate}k`;
}

function entryTitle(entry, multi) {
  return multi ? `${stationName()} — ${entryLabel(entry)}` : stationName();
}

export function m3uBody() {
  // #EXTM3U header + one #EXTINF entry per enabled stream -- the minimum
  // every M3U consumer (VLC, Sonos, iTunes, mpv) parses. Duration -1 = live.
  const entries = streamEntries();
  const multi = entries.length > 1;
  let body = '#EXTM3U\n';
  for (const entry of entries) {
    body += `#EXTINF:-1,${entryTitle(entry, multi)}\n${entry.url}\n`;
  }
  return body;
}

export function plsBody() {
  // PLS v2 -- the Winamp-era format old head units and internet radios
  // expect. One File/Title/Length triple per enabled stream; Length=-1
  // means "live, no fixed duration".
  const entries = streamEntries();
  const multi = entries.length > 1;
  let body = `[playlist]\nNumberOfEntries=${entries.length}\n`;
  entries.forEach((entry, index) => {
    const n = index + 1;
    body += `File${n}=${entry.url}\nTitle${n}=${entryTitle(entry, multi)}\nLength${n}=-1\n`;
  });
  return `${body}Version=2\n`;
}

export function registerListenFiles(fastify) {
  fastify.get('/listen.m3u', (_request, reply) => {
    reply.header('content-type', 'audio/x-mpegurl');
    return m3uBody();
  });
  fastify.get('/listen.pls', (_request, reply) => {
    reply.header('content-type', 'audio/x-scpls');
    return plsBody();
  });
}
