// Javni push rute -- opt-in nacrtna plast za "obvestilo ob zaciku oddaje".
//
// Povrsina je namenoma ozka, tako kot vsa javna plast tega repozitorija:
//   GET  /api/push/vapid        -> { publicKey, enabled } (javna polovica + zastavica)
//   POST /api/push/subscribe    -> { endpoint, keys:{p256dh, auth} } shrani
//   POST /api/push/unsubscribe  -> { endpoint } odpisi
//
// Avtentikacija: rute zivijo v javni API plasti (api.js), kar pomeni, da so
// privzeto za Basic Auth vrati, skupaj z vsemi /api/*. Odpiranje za javne
// postaje (poslusalci BREZ poverilnic) poteka prek DVEH vzvodov:
//   - web.publicPaths poklije bralni dostop (GET /api/push/vapid) -- kot
//     vedno;
//   - web.publicWritePaths pa izrecno odpre pisalne rute, ki so varne za
//     anonimni vpis: subscribe/unsubscribe. Pisala so namerno LOcena od
//     bralnih poti (auth.js), ker prevec sirok publicPaths prefix (npr.
//     "/api") ne sme odpreti /api/requests in lastniskih polls akcij;
//     "/api/push/subscribe" kot prefix zadene natanko to eno ruto.
// To je isti precedens, kot je odprl /podcast v P5 #3 -- en varovalni
// model po celi plast, le da tukaj pisalna polovica zahteva lastnikov
// izrecen vnos v publicWritePaths.
//
// config.push.enabled === false izklopi plast posteno: subscribe odgovori
// 503 (brskalnikova narocnina se ne shranjuje v zastonj), vapid pa vrne
// enabled: false, da lahko stran izpise stanje namesto ugibanja.
//
// Zavrnjeni vnos je 400 s posteno prvo vrstico vzroka -- nič tihe popravke,
// nič izumljanja podatkov. Subscribe nosi per-IP rate limit (fail-closed,
// isti vzorec kot polls glasovanje) -- na javni postaji je to edina
// anonimna pisalna ruta in ne sme biti odprta za poplavo.
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { isTrustedIp } from '../lib/ipRange.js';
import { loadOrCreateVapidKeys } from '../push/vapid.js';
import { addSubscription, removeSubscription, countSubscriptions } from '../push/subscriptions.js';

const log = createLogger('web');

// Ena prijava na IP na 30 s -- zadostuje za vse resnicne primere
// (poskusaj/preklic/poskusaj znova), ustavi pa ročno strganje.
const SUBSCRIBE_INTERVAL_MS = 30_000;
const lastSubscribeByIp = new Map();
// Enak strop kot pri glasovanju: porabi prostor, ne pomnilnik.
const RATE_MAP_CEILING = 5000;

function subscribeAllowed(ip, now = Date.now()) {
  if (lastSubscribeByIp.size >= RATE_MAP_CEILING) {
    const toDrop = Math.ceil(RATE_MAP_CEILING / 2);
    for (const key of lastSubscribeByIp.keys()) {
      if (toDrop-- <= 0) break;
      lastSubscribeByIp.delete(key);
    }
  }
  const previous = lastSubscribeByIp.get(ip) ?? 0;
  if (now - previous < SUBSCRIBE_INTERVAL_MS) return false;
  lastSubscribeByIp.set(ip, now);
  return true;
}

function pushEnabled() {
  return config.push?.enabled !== false;
}

// Rate limit pomeni anonymous/public površino: zaupani naslovi (loopback,
// LAN trustedNetworks) so ze mimo Basic Auth vrati po istem zaupanju kot
// auth.js -- omejevanje njihovih prijav bi samo pokvarilo studio/CLI
// preverjanja (in lastnikovo lastno napravo).
function rateLimitApplies(request) {
  return !isTrustedIp(request.ip, config.web?.trustedNetworks);
}

export function registerPushRoutes(fastify) {
  // Javni kljuc za brskalnikov pushManager.subscribe({ applicationServerKey }).
  // Kljuci se ustvarijo ob prvem klicu (lokalno, node:crypto) in potem samo
  // berejo -- brskalnik nujno rabi STABILNO javno polovico, sprememba bi
  // pomenila zavrnjene narocnine. `enabled` je del odgovora, da stran ve,
  // cesa sme pričakovati od streznika (config.push.enabled).
  fastify.get('/api/push/vapid', () => {
    const { publicKeyB64u } = loadOrCreateVapidKeys();
    return { publicKey: publicKeyB64u, enabled: pushEnabled() };
  });

  fastify.post('/api/push/subscribe', async (request, reply) => {
    if (!pushEnabled()) {
      return reply.code(503).send({ error: 'Push obvestila so izklopljena na strežniku (config.push.enabled).' });
    }
    const ip = request.ip ?? 'unknown';
    if (rateLimitApplies(request) && !subscribeAllowed(ip)) {
      return reply.code(429).send({ error: 'Prijava na obvestila je mogoča le vsakih 30 sekund.' });
    }
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
      // addSubscription javi slab vnos (validacija, strop naročnin) kot čist
      // Error brez code/syscall -- ta je 400 s posteno vrstico vzroka. Vse
      // ostalo so napake datotečnega sistema (ENOSPC, EACCES, EISDIR ...), katerih
      // sporočilo nosi absolutno pot strežnikovega dataDir -- to mora ostati
      // v dnevniku, ne pri morečnem anonimnem klicatelju.
      const filesystemFailure =
        !(err instanceof Error) || typeof err.code === 'string' || typeof err.syscall === 'string';
      if (filesystemFailure) {
        log(`push subscribe: shramba naročnin ni zapisljiva (${err?.code ?? err?.message})`);
        return reply.code(500).send({ error: 'Prijava na obvestila trenutno ni uspela.' });
      }
      reply.code(400);
      return { error: err.message };
    }
  });

  fastify.post('/api/push/unsubscribe', (request, reply) => {
    // Odjava deluje tudi ob izklopljeni plasti: brskalnik racuna na to, da
    // lahko obstojeco narocnino ODSTRANI, ko uporabnik izklopi obvestila --
    // sicer bi podatek ob visi ostal večno.
    const endpoint = typeof request.body?.endpoint === 'string' ? request.body.endpoint.trim() : '';
    if (!endpoint) {
      reply.code(400);
      return { error: 'Manjka endpoint' };
    }
    const removed = removeSubscription(endpoint);
    return { ok: true, removed, subscribers: countSubscriptions() };
  });
}
