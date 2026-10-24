// Studio push rute -- admin vidik obvestil (P5 #4 dopolnitev admin strani).
//
// Poslusalska stran je ta, ki se narocuje (opt-in prek /api/push/*); studio
// pa dobi dve stvari, ki jih ima samo lastnik:
//   GET  /studio/api/push       -- stanje: ali je push ziv, koliko je
//                                  narocnin, kdaj je bilo nazadnje poslano
//                                  (iz ledzerja, ne iz ugibanja)
//   POST /studio/api/push/test  -- poslji testno sporocilo vsem narocninam;
//                                  edini nacin, da lastnik PREVERI cevovod,
//                                  preden ga ob oddaji rabi
//
// Testni gumb poslja po ISTEM sendPushTo kot dispatch tick (sifriranje +
// VAPID + transport ena resnica), zato kar pade tukaj, bi padlo tudi ob
// zaciku oddaje. Obrezovanje mrlih narocnin poteka tudi tukaj.
import { config } from '../config/index.js';
import { loadSubscriptions, removeManySubscriptions } from '../push/subscriptions.js';
import { loadOrCreateVapidKeys } from '../push/vapid.js';
import { loadSentKeysSet, sentLedgerPath, sendPushTo } from '../push/dispatch.js';

export function registerStudioPushRoutes(fastify) {
  fastify.get('/studio/api/push', () => {
    const subscribers = loadSubscriptions();
    const keys = loadOrCreateVapidKeys();
    // Zadnji poslani kljuc iz ledzerja ("2026-10-25@20:00:00@rock-vecer") je
    // resnica o tem, kaj se je DEJANSKO poslalo -- leksikonski sort je dovolj,
    // ker je format datum@cas@id bajtno urejen sam po sebi.
    let lastSent = null;
    try {
      const sent = [...loadSentKeysSet()];
      if (sent.length > 0) lastSent = sent.sort().at(-1);
    } catch {
      lastSent = null;
    }
    return {
      configured: true,
      publicKey: keys.publicKeyB64u,
      subscriberCount: subscribers.length,
      leadMinutes: config.push?.leadMinutes ?? 2,
      sentLedger: sentLedgerPath(),
      lastSent,
    };
  });

  fastify.post('/studio/api/push/test', async (request, reply) => {
    const subs = loadSubscriptions();
    if (subs.length === 0) {
      return reply.code(200).send({
        ok: false,
        note: 'Ni narocnin -- poslusalec mora najprej vklopiti obvestila na poslusalski strani.',
        delivered: 0,
        failed: 0,
        pruned: 0,
      });
    }
    const keys = loadOrCreateVapidKeys();
    const subject = config.push?.subject ?? 'mailto:radio-markec@example.com';
    const payload = JSON.stringify({
      title: 'Radio Markec',
      body: 'Testno obvestilo: ce to vidis, cevovod deluje.',
      tag: `studio-test|${new Date().toISOString()}`,
      url: '/',
    });
    let delivered = 0;
    let failed = 0;
    const gone = new Set();
    for (const sub of subs) {
      const result = await sendPushTo(sub, payload, { keys, subject });
      if (result.delivered) delivered += 1;
      else if (result.gone) gone.add(sub.endpoint);
      else failed += 1;
    }
    const pruned = removeManySubscriptions(gone);
    return reply.code(200).send({ ok: delivered > 0, delivered, failed, pruned });
  });
}
