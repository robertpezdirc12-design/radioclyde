// The On Air dashboard's API: current show/track/DJ, listener count (first
// time it's surfaced anywhere -- getListenerCount() was previously only used
// internally by plex/scrobbleTrack.js), upcoming, recent history, plus the
// Skip and Force Next Show controls. Registered under the /studio prefix
// (see studioAuth.js).
import { composeNowPlaying } from './nowPlaying.js';
import { getUpcomingShows } from './upcoming.js';
import { getRecentHistory } from './historyApi.js';
import { getListenerCount } from '../icecast/listeners.js';
import { forceNextOccurrence } from '../scheduler/updateNowPlaying.js';
import { sendCommand } from '../liquidsoap/telnetClient.js';
import { config } from '../config/index.js';

// radio.liq's output.icecast (the MP3 mount every listener hears) carries no
// explicit `id`, so Liquidsoap names that output's telnet commands after the
// MOUNT: the skip command is "<mount>.skip", not a constant. The previously
// hardcoded '/stream.skip' matched only config.example.json's mount; with
// e.g. the deploy default '/stream.mp3' both studio buttons answered 502
// "no such command". Derived from config.icecast.mount at call time (config
// is boot-frozen) with '/stream' as the fallback for an absent/blank mount --
// the same default streamsLiqWriter.js applies -- and normalized to exactly
// one leading slash so a mount typo can't double it. Pure on purpose: the
// normalization is pin-able in tests without a running Liquidsoap.
export function skipCommandForMount(mount) {
  const raw = typeof mount === 'string' ? mount.trim() : '';
  const base = raw || '/stream';
  return `/${base.replace(/^\/+/, '')}.skip`;
}

export function registerStudioOnAirApi(fastify) {
  fastify.get('/api/on-air', async () => {
    const nowPlaying = composeNowPlaying();
    let listenerCount = null;
    try {
      listenerCount = await getListenerCount();
    } catch {
      // Icecast unreachable/slow -- the rest of the dashboard is still
      // useful without a listener count, so don't fail the whole endpoint.
    }
    return {
      ...nowPlaying,
      listenerCount,
      upcoming: getUpcomingShows(10),
      history: getRecentHistory(20),
    };
  });

  // Skip whatever is actually on the Icecast output (the mounted
  // output.skip command, see skipCommandForMount above), not
  // `show_source.skip`. show_source is the scheduled-show playlist; when
  // fallback() has dropped to filler (or fade.in is the operator actually
  // decoding), skipping the inner playlist does not cut the song the
  // listener hears. Confirmed live against this Liquidsoap build's `help`.
  // The studio UI disables this during DJ speech; the no-track check here
  // is the same guard for a stale/raced click.
  fastify.post('/api/on-air/skip', async (request, reply) => {
    const { track } = composeNowPlaying();
    if (!track) {
      return reply.code(409).send({ error: 'Nothing skippable right now (no track currently airing).' });
    }
    try {
      const result = await sendCommand(skipCommandForMount(config.icecast?.mount));
      return { result };
    } catch (err) {
      return reply.code(502).send({ error: `Liquidsoap telnet command failed: ${err.message}` });
    }
  });

  fastify.post('/api/on-air/force-next', async (request, reply) => {
    let state;
    try {
      state = await forceNextOccurrence();
    } catch (err) {
      const code = /not been produced/.test(err.message) ? 409 : 500;
      return reply.code(code).send({ error: err.message });
    }
    // Playlist watch-reload only drops not-yet-started entries -- without
    // an explicit reload + output skip, the current file plays out and
    // the button looks like a no-op.
    try {
      await sendCommand('show_source.reload');
    } catch {
      // watch mode may still pick the rewrite up; the skip below is the
      // part that actually interrupts.
    }
    try {
      await sendCommand(skipCommandForMount(config.icecast?.mount));
    } catch (err) {
      return reply.code(502).send({ error: `Liquidsoap telnet command failed: ${err.message}` });
    }
    return { state };
  });
}
