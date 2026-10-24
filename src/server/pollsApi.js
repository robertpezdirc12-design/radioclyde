// HTTP surface for listener polls (P4 #25) -- mounted by server/api.js
// together with the other public routes. Shape follows requestsApi.js /
// studioRequestsApi.js: thin handlers, all policy lives in pollsStore.js.
//
//   POST /api/polls            -- owner action: open a new poll (closing
//                                 the previous one), body {question, options[]}
//   GET  /api/polls/active     -- public: current poll + honest tally
//                                 (null body when nothing is open)
//   POST /api/polls/vote       -- public: body {id, option} (option = index);
//                                 light per-IP rate limit, fail-closed
//   POST /api/polls/close      -- owner action: freeze the tally, stop air
//                                 mentions
//   GET  /api/polls/history    -- owner action: last closed polls
import { createPoll, readStore, validatePollInput, votePoll, closeActivePoll, activePollSummary, pollHistory } from './pollsStore.js';

// Anti-flood floor, in-memory like a mutex: one vote per IP per 30 seconds.
// Restart forgets it -- acceptable for a mood gauge, not for elections.
const VOTE_INTERVAL_MS = 30_000;
const lastVoteByIp = new Map();

function voteAllowed(ip, now = Date.now()) {
  const previous = lastVoteByIp.get(ip) ?? 0;
  if (now - previous < VOTE_INTERVAL_MS) return false;
  lastVoteByIp.set(ip, now);
  return true;
}

export function registerPollsRoutes(fastify) {
  fastify.post('/api/polls', (request, reply) => {
    const check = validatePollInput(request.body);
    if (!check.ok) return reply.code(400).send({ ok: false, errors: check.errors });
    const poll = createPoll(request.body);
    return reply.code(201).send({ ok: true, poll });
  });

  fastify.get('/api/polls/active', () => {
    return { ok: true, poll: activePollSummary() };
  });

  fastify.post('/api/polls/vote', (request, reply) => {
    const ip = request.ip ?? 'unknown';
    if (!voteAllowed(ip)) {
      return reply.code(429).send({ ok: false, errors: ['Glas lahko oddaš le vsakih 30 sekund.'] });
    }
    const result = votePoll(request.body?.id, request.body?.option);
    if (!result.ok) {
      const status = { 'no-active': 404, 'unknown-id': 404, 'bad-option': 400 }[result.reason] ?? 400;
      return reply.code(status).send({ ok: false, errors: [`Glasovanje ni uspelo (${result.reason}).`] });
    }
    return reply.send({ ok: true, tally: result.tally });
  });

  fastify.post('/api/polls/close', () => {
    return closeActivePoll();
  });

  fastify.get('/api/polls/history', () => {
    return { ok: true, closed: pollHistory(), storeExists: !!readStore().active };
  });
}
