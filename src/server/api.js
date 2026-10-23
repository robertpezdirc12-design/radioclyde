import { composeNowPlaying } from './nowPlaying.js';
import { getRecentHistory } from './historyApi.js';
import { getUpcomingShows } from './upcoming.js';
import { registerScheduleRoute } from './scheduleApi.js';
import { registerRequestsRoutes } from './requestsApi.js';
import { getListenerCount } from '../icecast/listeners.js';
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
  fastify.get('/api/listeners', async () => {
    try {
      const listeners = await getListenerCount();
      return { listeners };
    } catch (err) {
      log(`/api/listeners: Icecast probe failed: ${err.message}`);
      return { listeners: null };
    }
  });

  registerScheduleRoute(fastify);
  registerRequestsRoutes(fastify);
}
