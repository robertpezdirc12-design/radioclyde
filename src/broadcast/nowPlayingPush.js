// External now-playing pushes -- TuneIn AIR metadata + Discord webhook.
// Both are CONFIG-GATED no-ops by default (config.broadcast.tuneIn /
// config.broadcast.discordWebhook), fire-and-forget by design, and can never
// break playout: every failure becomes a returned result object, never a
// throw into scrobbleTrack.js's per-track process.
//
// Which tracks go where, stated plainly:
//  - TuneIn AIR gets EVERY aired track, filler included -- TuneIn displays
//    "what's playing", and the audio is the truth, whatever the source.
//  - Discord gets ONLY curated show tracks -- a webhook announcing filler
//    would spam the channel with the rotation ledger's own output; show
//    tracks are the thing a community cares about.
//
// No new npm dependency: plain fetch with AbortSignal timeouts, injectable
// for tests.
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');
const PUSH_TIMEOUT_MS = 5000;

function tuneInConfigured() {
  const t = config.broadcast?.tuneIn;
  return Boolean(t?.partnerId && t?.partnerKey && t?.stationId);
}

// TuneIn's Playing.ashx contract: partnerId + partnerKey + id (station id)
// identify the station; title/artist update the now-playing text. GET is the
// documented form, kept well under the 5s timeout -- TuneIn is optional
// metadata, never worth blocking a track start over.
export function tuneInUrl(track, cfg = config.broadcast?.tuneIn) {
  const params = new URLSearchParams({
    partnerId: cfg.partnerId,
    partnerKey: cfg.partnerKey,
    id: cfg.stationId,
    title: track?.title ?? '',
    artist: track?.artist ?? '',
  });
  return `http://air.radiotime.com/Playing.ashx?${params.toString()}`;
}

export async function pushTuneIn(track, { fetchImpl = fetch } = {}) {
  if (!tuneInConfigured()) return { channel: 'tunein', skipped: 'disabled' };
  try {
    const res = await fetchImpl(tuneInUrl(track), { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    if (!res.ok) return { channel: 'tunein', ok: false, status: res.status };
    return { channel: 'tunein', ok: true };
  } catch (err) {
    return { channel: 'tunein', ok: false, error: err?.message ?? String(err) };
  }
}

export async function pushDiscord(track, { fetchImpl = fetch } = {}) {
  const url = config.broadcast?.discordWebhook;
  if (!url) return { channel: 'discord', skipped: 'disabled' };
  try {
    const body = {
      username: config.autoRadio?.stationName ?? 'Radio Clyde',
      embeds: [
        {
          title: track?.artist ? `${track.artist} — ${track.title}` : (track?.title ?? ''),
          description: 'Zdaj predvajamo',
        },
      ],
    };
    if (config.broadcast?.publicStreamUrl) {
      body.content = config.broadcast.publicStreamUrl;
    }
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res.ok) return { channel: 'discord', ok: false, status: res.status };
    return { channel: 'discord', ok: true };
  } catch (err) {
    return { channel: 'discord', ok: false, error: err?.message ?? String(err) };
  }
}

// Single entry point for scrobbleTrack.js: routes each aired track to the
// channels it belongs to and logs the outcomes (one short line per track,
// skipped channels stay silent). Never throws. `fetchImpl` threads through
// so tests can substitute the network.
export async function pushNowPlaying({ track, isFiller, fetchImpl = fetch } = {}) {
  const results = [];
  results.push(await pushTuneIn(track, { fetchImpl }));
  if (isFiller) {
    results.push({ channel: 'discord', skipped: 'filler' });
  } else {
    results.push(await pushDiscord(track, { fetchImpl }));
  }
  for (const r of results) {
    if (r.skipped) continue;
    if (r.ok) {
      log(`nowPlayingPush: ${r.channel} updated (${track?.artist ?? ''} — ${track?.title ?? ''}).`);
    } else {
      log(`nowPlayingPush: ${r.channel} failed: ${r.error ?? `HTTP ${r.status}`}`);
    }
  }
  return results;
}
