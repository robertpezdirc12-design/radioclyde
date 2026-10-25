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
//
// "Owner action" is now ENFORCED, not just documented: create/close/history
// require the STUDIO credentials (config.studio.users -- the same check
// studioAuth.js applies to /studio/*), so a listener credential cannot open
// or close polls any more. 403 (not 401) on failure: the caller has already
// authenticated in the listener realm, and re-challenging with a second
// WWW-Authenticate from the same public surface would just confuse the
// browser's cached credentials. No shipped client calls these three OWNER
// routes (the studio polls UI doesn't exist yet; the on-air anketa rubric
// reads pollsStore.js directly), so the gate breaks nothing today and makes
// the future studio UI's job trivial: its same-origin fetches already carry
// the studio Basic-auth header. The public pair -- GET /api/polls/active +
// POST /api/polls/vote -- is a different story: the listener page's polls
// panel calls both, and it was never behind this gate.
import { createPoll, readStore, validatePollInput, votePoll, closeActivePoll, activePollSummary, pollHistory } from './pollsStore.js';
import { parseBasicAuth, studioCredentialsValid } from './studioAuth.js';

function requireStudioOwner(request, reply) {
  const creds = parseBasicAuth(request.headers.authorization);
  if (!creds || !studioCredentialsValid(creds.username, creds.password)) {
    reply.code(403).send({ ok: false, errors: ['Odpiranje in zapiranje ankete sta dejanji lastnika -- prijavite se s studio poverilnicami.'] });
    return false;
  }
  return true;
}

// Anti-flood floor, in-memory like a mutex: one vote per IP per 30 seconds.
// Restart forgets it -- acceptable for a mood gauge, not for elections.
const VOTE_INTERVAL_MS = 30_000;
// The map would otherwise grow one entry per unique voter IP for the
// process's whole lifetime; evicting the oldest half past this ceiling keeps
// the footprint flat while preserving the recent-window semantics (a station
// behind one NAT gateway has a handful of IPs; thousands of distinct IPs in
// 30 s means something else is wrong anyway).
const VOTE_MAP_CEILING = 5000;
const lastVoteByIp = new Map();

function voteAllowed(ip, now = Date.now()) {
  if (lastVoteByIp.size >= VOTE_MAP_CEILING) {
    // Map preserves insertion order -- the first half is the oldest half.
    const toDrop = Math.ceil(VOTE_MAP_CEILING / 2);
    for (const key of lastVoteByIp.keys()) {
      if (toDrop-- <= 0) break;
      lastVoteByIp.delete(key);
    }
  }
  const previous = lastVoteByIp.get(ip) ?? 0;
  if (now - previous < VOTE_INTERVAL_MS) return false;
  lastVoteByIp.set(ip, now);
  return true;
}

export function registerPollsRoutes(fastify) {
  fastify.post('/api/polls', (request, reply) => {
    if (!requireStudioOwner(request, reply)) return;
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

  fastify.post('/api/polls/close', (request, reply) => {
    if (!requireStudioOwner(request, reply)) return;
    return closeActivePoll();
  });

  fastify.get('/api/polls/history', (request, reply) => {
    if (!requireStudioOwner(request, reply)) return;
    return { ok: true, closed: pollHistory(), storeExists: !!readStore().active };
  });
}
