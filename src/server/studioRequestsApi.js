// Studio moderation of listener requests/dedications (issue #2 section B.4:
// "review, approve, reject, and moderate"). Registered inside the /studio
// prefix (studioAuth.js), so Basic Auth + the JSON-only CSRF rule already
// apply to every route here.
import { listRequests, updateRequestStatus, STATUSES } from './requestsStore.js';
import { queueRequest } from '../liquidsoap/requestQueue.js';

export function registerStudioRequestsApi(fastify) {
  fastify.get('/api/requests', (request) => {
    const { status, limit } = request.query ?? {};
    return {
      requests: listRequests({
        status: STATUSES.has(status) ? status : undefined,
        limit: Number.isFinite(parseInt(limit, 10)) ? parseInt(limit, 10) : undefined,
      }),
    };
  });

  fastify.post('/api/requests/:id/status', (request, reply) => {
    const { status, note } = request.body ?? {};
    if (!STATUSES.has(status)) {
      return reply.code(400).send({ error: `Neznan status "${status}" (dovoljeno: pending, approved, rejected).` });
    }
    const updated = updateRequestStatus(request.params.id, status, note);
    if (!updated) return reply.code(404).send({ error: 'Zahtevek ne obstaja.' });
    if (updated.invalid) return reply.code(400).send({ error: 'Neveljaven prehod statusa.' });
    return updated;
  });

  // P2 #8: queue an ALREADY approved request onto Liquidsoap's request.queue
  // (radio.liq id "requests") so it airs at the next track boundary. The
  // outcome (queued / not in library / Liquidsoap unreachable) is written
  // into the request's note by queueRequest itself, so the dashboard always
  // shows the truth; the HTTP answer mirrors it for the button's alert.
  fastify.post('/api/requests/:id/queue', async (request, reply) => {
    const outcome = await queueRequest(request.params.id);
    if (!outcome) return reply.code(404).send({ error: 'Zahtevek ne obstaja.' });
    if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
    return outcome;
  });
}
