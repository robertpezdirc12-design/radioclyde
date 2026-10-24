import { composeNowPlaying } from './nowPlaying.js';
import { getRecentHistory } from './historyApi.js';
import { getUpcomingShows } from './upcoming.js';
import { registerScheduleRoute } from './scheduleApi.js';
import { registerRequestsRoutes } from './requestsApi.js';
import { registerPollsRoutes } from './pollsApi.js';
import { getListenerCount } from '../icecast/listeners.js';
import { readSamples } from '../analytics/listenerSamples.js';
import { peakListeners } from '../analytics/listenerImpact.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('web');

// Natural future home for POST /api/requests (song requests) -- same file,
// same auth hook already applied globally in index.js, no rework needed.
export function registerApiRoutes(fastify) {
  fastify.get('/api/now-playing', () => composeNowPlaying());

  fastify.get('/api/history', (request) => {
    const limit = parseInt(request.query.limit, 10);
    return { entries: getRecentHistory(Number.isFinite(limit) ? limit : undefined) };
  });

  fastify.get('/api/upcoming', () => ({ shows: getUpcomingShows() }));

  // Real listener count for the public page's chip. Honesty rule: a number
  // appears ONLY when Icecast actually answered -- a dead stream reports
  // { listeners: null } and the chip hides itself, exactly like /api/weather.
  // Error details stay server-side (they can name internal hosts).
  //
  // `peak` rides along: the highest count the sampling ledger (sampled once
  // per minute by the scheduler) actually recorded in the last 24 h. It is
  // history, not a live probe -- it answers even while Icecast is down
  // right now, and it is null when the ledger has no valid sample in the
  // window (fresh install, extended outage). The UI labels it "vrh 24 h".
  fastify.get('/api/listeners', async () => {
    let peak = null;
    try {
      const now = Date.now();
      peak = peakListeners(readSamples(), { from: now - 24 * 60 * 60 * 1000, to: now });
    } catch (err) {
      log(`/api/listeners: peak computation failed: ${err.message}`);
    }
    try {
      const listeners = await getListenerCount();
      return { listeners, peak };
    } catch (err) {
      log(`/api/listeners: Icecast probe failed: ${err.message}`);
      return { listeners: null, peak };
    }
  });

  registerScheduleRoute(fastify);
  registerRequestsRoutes(fastify);
  // P4 #25 listener polls -- open/vote/close, the "anketa" rubric reads the
  // same store at air time (server/pollsStore.js).
  registerPollsRoutes(fastify);
}
