// /listen.m3u + /listen.pls -- one-line playlist files for hardware and
// desktop players (Sonos, VLC, car head units, MPD, older smart radios).
// The same "ancient hardware" integration SUB/WAVE markets, served as two
// tiny static-format responses with zero dependencies.
//
// URL resolution, in priority order (same precedence the TuneIn/Discord push
// uses, see broadcast/nowPlayingPush.js):
//   1. config.broadcast.publicStreamUrl -- the owner-declared public URL,
//      correct behind Cloudflare Tunnel / reverse proxies / custom domains
//   2. derived from config.icecast.publicHost + config.web.port + mount --
//      the exact composition nowPlaying.js's station.streamUrl() reports,
//      so every surface names the same endpoint
//
// Auth note: the global Basic Auth hook (auth.js) runs before these routes
// like everything else, so the playlist is only handed to someone who can
// already reach /stream. When the station later opens selected paths via
// config.web.publicPaths (see auth.js), these files work for anonymous
// players too -- no code change, just the config flip.
import { config } from '../config/index.js';
import { loadStation } from '../scheduler/scheduleUtil.js';

function stationName() {
  try {
    return loadStation().name ?? 'Radio Markec';
  } catch {
    return 'Radio Markec';
  }
}

export function resolveStreamUrl() {
  const declared = config.broadcast?.publicStreamUrl;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return `http://${config.icecast.publicHost}:${config.web.port}${config.icecast.mount}`;
}

export function m3uBody() {
  // #EXTM3U header + one #EXTINF entry -- the minimum every M3U consumer
  // (VLC, Sonos, iTunes, mpv) parses. Duration -1 = live stream.
  return `#EXTM3U\n#EXTINF:-1,${stationName()}\n${resolveStreamUrl()}\n`;
}

export function plsBody() {
  // PLS v2 -- the Winamp-era format old head units and internet radios
  // expect. Length1=-1 means "live, no fixed duration".
  return `[playlist]\nNumberOfEntries=1\nFile1=${resolveStreamUrl()}\nTitle1=${stationName()}\nLength1=-1\nVersion=2\n`;
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
