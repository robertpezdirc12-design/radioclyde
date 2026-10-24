// Javni push rute -- opt-in nacrtna plast za "obvestilo ob zaciku oddaje".
//
// Povrsina je namenoma ozka, tako kot vsa javna plast tega repozitorija:
//   GET  /api/push/vapid        -> { publicKey } (javna polovica, nihce skrivnost)
//   POST /api/push/subscribe    -> { endpoint, keys:{p256dh, auth} } shrani
//   POST /api/push/unsubscribe  -> { endpoint } odpisi
//
// Avtentikacija: rute zivijo v javni API plasti (api.js), kar pomeni, da so
// privzeto za Basic Auth vrati, skupaj z vsemi /api/*; lastnik jih odpre z
// config.web.publicPaths flipom (npr. "/api/push"), ko hoce, da poslusalci
// res vklopijo obvestila. To je isti precedens, kot je odprl /podcast v
// P5 #3 -- en varovalni model po celi plast.
//
// Zavrnjeni vnos je 400 s posteno prvo vrstico vzroka -- nič tihe popravke,
// nič izumljanja podatkov.
import { loadOrCreateVapidKeys } from '../push/vapid.js';
import { addSubscription, removeSubscription, countSubscriptions } from '../push/subscriptions.js';

export function registerPushRoutes(fastify) {
  // Javni kljuc za brskalnikov pushManager.subscribe({ applicationServerKey }).
  // Kljuci se ustvarijo ob prvem klicu (lokalno, node:crypto) in potem samo
  // berejo -- brskalnik nujno rabi STABILNO javno polovico, sprememba bi
  // pomenila zavrnjene narocnine.
  fastify.get('/api/push/vapid', () => {
    const { publicKeyB64u } = loadOrCreateVapidKeys();
    return { publicKey: publicKeyB64u };
  });

  fastify.post('/api/push/subscribe', async (request, reply) => {
    const body = request.body ?? {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint || !body.keys || typeof body.keys.p256dh !== 'string' || typeof body.keys.auth !== 'string') {
      reply.code(400);
      return { error: 'Manjka endpoint ali keys (p256dh, auth)' };
    }
    try {
      const count = addSubscription({ endpoint, keys: body.keys });
      return reply.code(201).send({ ok: true, subscribers: count });
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  fastify.post('/api/push/unsubscribe', async (request, reply) => {
    const endpoint = typeof request.body?.endpoint === 'string' ? request.body.endpoint.trim() : '';
    if (!endpoint) {
      reply.code(400);
      return { error: 'Manjka endpoint' };
    }
    const removed = removeSubscription(endpoint);
    return { ok: true, removed, subscribers: countSubscriptions() };
  });
}
