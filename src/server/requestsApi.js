// Listener song requests / dedications (issue #2 section A). Honest by
// construction: a successful POST returns exactly {id, status: "pending"} --
// approval/rejection happens ONLY in the studio, and the status endpoint
// reports the stored truth including a rejection note. There is deliberately
// no way for a listener to see anyone else's request.
//
// Rate limiting is per-IP and fails closed (see requestsStore.js) -- a flood
// is exactly when dropping submissions beats dropping the limit.
import { validateSubmission, submissionAllowed, appendRequest, getRequest, publicView } from './requestsStore.js';

export function registerRequestsRoutes(fastify) {
  fastify.post('/api/requests', (request, reply) => {
    const body = request.body ?? {};
    const check = validateSubmission(body);
    if (!check.ok) return reply.code(400).send({ error: check.errors.join(' ') });

    const allowed = submissionAllowed(request.ip);
    if (!allowed.ok) return reply.code(429).send({ error: allowed.reason });

    const entry = appendRequest(body, request.ip);
    return reply.code(201).send(publicView(entry));
  });

  fastify.get('/api/requests/:id', (request, reply) => {
    const entry = getRequest(request.params.id);
    if (!entry) return reply.code(404).send({ error: 'Zahtevek s tem ID ne obstaja.' });
    return publicView(entry);
  });
}
