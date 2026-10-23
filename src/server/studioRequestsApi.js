// Studio moderation of listener requests/dedications (issue #2 section B.4:
// "review, approve, reject, and moderate"). Registered inside the /studio
// prefix (studioAuth.js), so Basic Auth + the JSON-only CSRF rule already
// apply to every route here.
import { listRequests, updateRequestStatus, STATUSES } from './requestsStore.js';

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
}
