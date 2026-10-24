// P5 #4: push obvestila ob zaciku terminirane oddaje. Vse je odvisno samo od
// node:crypto -- brez omrezja, brez piperja, brez ffmpeg. Najmocnejsi dokaz
// je polni kripto roundtrip: sifriramo z odjemalcevim javnim kljucem in
// odsifriramo z njegovim zasebnim (implementacija RFC 8291 se sama preverja).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('push', {
  web: { port: 3998, publicPaths: [] },
});

const {
  loadOrCreateVapidKeys,
  vapidAuthorizationHeader,
  toB64u,
  fromB64u,
  vapidFilePath,
} = await import('../src/push/vapid.js');
const { encryptPushPayload } = await import('../src/push/encrypt.js');
const {
  loadSubscriptions,
  addSubscription,
  removeSubscription,
  removeManySubscriptions,
  isValidSubscription,
  subscriptionsFilePath,
} = await import('../src/push/subscriptions.js');
const {
  showsToNotify,
  occurrenceKey,
  buildNotificationPayload,
  dispatchPush,
  recordSentKey,
  loadSentKeysSet,
  sentLedgerPath,
  setPushTransport,
  sendPushTo,
} = await import('../src/push/dispatch.js');
const { registerPushRoutes } = await import('../src/server/pushApi.js');
const { registerStudioPushRoutes } = await import('../src/server/studioPushApi.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'markec-push-'));
}

// Vsi testi z deljenim stanjem (naročnine/ledžer/vapid v testnem dataDir)
// začnejo s čistim push/ imenikom -- ostanki med testi istega procesa so že
// enkrat pripeljali do lažno rdečih testov (topListened lekcija).
const configModule = await import('../src/config/index.js');
function resetPushState() {
  fs.rmSync(configModule.config.paths.pushDir, { recursive: true, force: true });
}

// Odjemalec (brskalnik): par P-256 + 16-bajtna auth skrivnost -- tocnisto,
// kar pushManager.subscribe() poslje strezniku. Zasebni del ostane v testu
// za roundtrip odsifriranje.
function makeSubscriber(endpoint = 'https://push.example.com/send/x') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const authBytes = crypto.randomBytes(16);
  return {
    endpoint,
    keys: { p256dh: publicRaw.toString('base64url'), auth: authBytes.toString('base64url') },
    privateKey,
    publicRaw,
    authBytes,
  };
}

// Urnik fiksna: nedelja 25. 10. 2026 ob 20:00 -- v testih gradimo Date
// lokalno (getHours uporablja lokalni cas, enako kot scheduleUtil).
const SCHEDULE = { sunday: [{ id: 'rock-vecer', startTime: '20:00', durationMinutes: 60, host: 'Markec' }] };
const NOW_1958 = new Date(2026, 9, 25, 19, 58, 0, 0);

// ---------------------------------------------------------------------------
// 1. VAPID kljuci (RFC 8292 temelj)
// ---------------------------------------------------------------------------
describe('VAPID kljuci', () => {
  test('prvi klic ustvari par na disku, drugi vrne ISTI par (stabilnost cez redeploy)', () => {
    const first = loadOrCreateVapidKeys();
    assert.ok(fs.existsSync(vapidFilePath()), 'vapid.json obstaja');
    assert.equal(first.publicKeyRaw.length, 65, 'nespremenjena tocka = 65 bajtov');
    assert.equal(first.publicKeyRaw[0], 0x04, 'prefix 0x04');
    const second = loadOrCreateVapidKeys();
    assert.equal(second.publicKeyB64u, first.publicKeyB64u, 'javni kljuc enak');
    assert.equal(second.privateKey.d, first.privateKey.d, 'zasebni kljuc enak');
  });

  test('publicKeyB64u je 87 znakov (65 bajtov base64url) -- applicationServerKey oblika', () => {
    const keys = loadOrCreateVapidKeys();
    assert.equal(keys.publicKeyB64u.length, 87);
    assert.equal(fromB64u(keys.publicKeyB64u).length, 65);
  });
});

describe('vapidAuthorizationHeader (RFC 8292)', () => {
  const keys = loadOrCreateVapidKeys();
  const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

  test('oblika: vapid t=<3-segmentni JWT>, k=<javni kljuc>', () => {
    const header = vapidAuthorizationHeader({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      subject: 'mailto:studio@example.com',
      keys,
      now: NOW,
    });
    assert.match(header, /^vapid t=([^,]+), k=([^,]+)$/);
    const [, jwt] = header.match(/^vapid t=([^,]+),/);
    assert.equal(jwt.split('.').length, 3, 'JWT ima 3 segmente');
    assert.equal(header.split(', k=')[1], keys.publicKeyB64u, 'k = isti javni kljuc');
  });

  test('JWT claims: aud = origin endpointa, exp = now+12h, sub = mailto', () => {
    const header = vapidAuthorizationHeader({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      subject: 'studio@example.com',
      keys,
      now: NOW,
    });
    const jwt = header.match(/^vapid t=([^,]+),/)[1];
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(payload.aud, 'https://fcm.googleapis.com');
    assert.equal(payload.exp, Math.floor(NOW / 1000) + 12 * 60 * 60);
    assert.equal(payload.sub, 'mailto:studio@example.com', 'mailto prefix dodan samodejno');
  });

  test('podpis se preveri z javnim kljucem (ES256, ieee-p1363 r||s)', () => {
    const header = vapidAuthorizationHeader({
      endpoint: 'https://push.example.com/x',
      subject: 'mailto:a@b.c',
      keys,
      now: NOW,
    });
    const jwt = header.match(/^vapid t=([^,]+),/)[1];
    const [h, p, s] = jwt.split('.');
    const signed = Buffer.from(`${h}.${p}`, 'utf8');
    const signature = fromB64u(s);
    assert.equal(signature.length, 64, 'r||s = 64 bajtov');
    const publicJwk = keys.publicKey;
    // crypto.verify rabi ISTI dsaEncoding kot crypto.sign -- r||s, ne DER.
    const ok = crypto.verify(
      'sha256',
      signed,
      { key: crypto.createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      signature
    );
    assert.equal(ok, true, 'JWT podpis veljaven');
  });

  test('manjkajoci kljuci -> postena napaka, ne tih header', () => {
    assert.throws(() => vapidAuthorizationHeader({ endpoint: 'https://x.y/z', subject: 'mailto:a@b.c', keys: null }));
  });
});

// ---------------------------------------------------------------------------
// 2. aes128gcm sifriranje (RFC 8291) -- POLNI ROUNDTRIP
// ---------------------------------------------------------------------------
describe('encryptPushPayload (RFC 8291 aes128gcm)', () => {
  test('roundtrip: odjemalcu zasebni kljuc odsifrira, kar je javni kljuc sifriral', () => {
    const sub = makeSubscriber();
    const plaintext = JSON.stringify({ title: 'Radio Markec', body: 'Ob 20:00 se zacenja rock-vecer.' });
    const body = encryptPushPayload({
      subscriberPublicKeyB64u: sub.keys.p256dh,
      authSecretB64u: sub.keys.auth,
      plaintext,
    });

    // Header po RFC 8188: sol(16) || rs(4) || idlen(1) || eph pub(65)
    assert.equal(body.length > 86 + 16, true, 'telo dolzje od headerja+ciphertexta');
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body[20];
    assert.equal(rs, 4096, 'rs = 4096');
    assert.equal(idlen, 65, 'emeraldna javna tocka 65 bajtov');
    const ephPub = body.subarray(21, 21 + idlen);
    assert.equal(ephPub[0], 0x04);

    // Odsifriranje z odjemalcevimi skrivnostmi (to dela brskalnik):
    const sharedSecret = crypto.diffieHellman({ privateKey: sub.privateKey, publicKey: crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: ephPub.subarray(1, 33).toString('base64url'), y: ephPub.subarray(33, 65).toString('base64url') },
      format: 'jwk',
    }) });
    const prk = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, sub.authBytes, Buffer.concat([
      Buffer.from('WebPush: info', 'utf8'),
      Buffer.from([0x00]),
      sub.publicRaw,
      ephPub,
    ]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
    const ciphertext = body.subarray(21 + idlen);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    // aes128gcm = AES-128-GCM (16-bajtni CEK, RFC 8291 5.2).
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    assert.equal(decrypted[decrypted.length - 1], 0x02, 'zadnji bajt = zakljucni delimiter');
    assert.equal(decrypted.subarray(0, decrypted.length - 1).toString('utf8'), plaintext);
  });

  test('neveljaven p256dh -> postena napaka', () => {
    assert.throws(
      () => encryptPushPayload({ subscriberPublicKeyB64u: toB64u(Buffer.alloc(32)), authSecretB64u: 'AAAA', plaintext: 'x' }),
      /nespremenjena P-256/
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Naročnine (shramba)
// ---------------------------------------------------------------------------
describe('subscriptions shramba', () => {
  test('add/dedupe/update/remove/removeMany nad realno datoteko', () => {
    const file = path.join(tmpDir(), 'subscriptions.json');
    const a = makeSubscriber('https://push.example.com/A');
    const b = makeSubscriber('https://push.example.com/B');

    assert.equal(addSubscription(a, { filePath: file, addedAt: '2026-10-25T10:00:00Z' }), 1);
    // isti endpoint z rotiranimi kljuci = posodobitev, ne dvojnica
    const a2 = makeSubscriber('https://push.example.com/A');
    assert.equal(addSubscription(a2, { filePath: file, addedAt: '2026-10-25T11:00:00Z' }), 1);
    const all = loadSubscriptions({ filePath: file });
    assert.equal(all.length, 1);
    assert.equal(all[0].keys.p256dh, a2.keys.p256dh, 'zadnji kljuci so resnica');
    assert.equal(all[0].addedAt, '2026-10-25T11:00:00Z');

    assert.equal(addSubscription(b, { filePath: file }), 2);
    assert.equal(removeSubscription('https://push.example.com/A', { filePath: file }), 1);
    assert.equal(removeSubscription('https://push.example.com/A', { filePath: file }), 0, 'odjava 2x = 0, posteno');
    assert.equal(removeManySubscriptions(new Set(['https://push.example.com/B']), { filePath: file }), 1);
    assert.equal(loadSubscriptions({ filePath: file }).length, 0);
  });

  test('pokvarjena datoteka -> berem kot prazno (ne strmoglavi dispatch ticka)', () => {
    const file = path.join(tmpDir(), 'broken.json');
    fs.writeFileSync(file, '{ to ni json');
    assert.deepEqual(loadSubscriptions({ filePath: file }), []);
  });

  test('isValidSubscription: https endpoint + keys obvezni, http zavrnjen', () => {
    assert.equal(isValidSubscription({ endpoint: 'https://x.y/z', keys: { p256dh: 'a'.repeat(65), auth: 'b'.repeat(16) } }), true);
    assert.equal(isValidSubscription({ endpoint: 'http://x.y/z', keys: { p256dh: 'a'.repeat(65), auth: 'b'.repeat(16) } }), false);
    assert.equal(isValidSubscription({ endpoint: 'https://x.y/z' }), false);
    assert.equal(isValidSubscription(null), false);
  });
});

// ---------------------------------------------------------------------------
// 4. Cista dispatch logika
// ---------------------------------------------------------------------------
describe('showsToNotify + payload (cista logika, brez IO)', () => {
  test('oddaja 2 minuti pred zacikom je zapadla; poslana preskocena; okno 0 prazno', () => {
    const due = showsToNotify(SCHEDULE, NOW_1958, 2, new Set());
    assert.equal(due.length, 1);
    assert.equal(occurrenceKey(due[0]), '2026-10-25@20-00@rock-vecer');

    const already = showsToNotify(SCHEDULE, NOW_1958, 2, new Set(['2026-10-25@20-00@rock-vecer']));
    assert.equal(already.length, 0, 'idempotentnost po kljucu');

    assert.equal(showsToNotify(SCHEDULE, NOW_1958, 0, new Set()).length, 0, 'okno 0 = nic');
    assert.equal(showsToNotify(SCHEDULE, new Date(2026, 9, 25, 12, 0), 2, new Set()).length, 0, '7 ur zgodaj = nic');
  });

  test('neveljaven leadMinutes -> postena napaka (ni tih -1 okno)', () => {
    assert.throws(() => showsToNotify(SCHEDULE, NOW_1958, -1, new Set()));
    assert.throws(() => showsToNotify(SCHEDULE, NOW_1958, NaN, new Set()));
  });

  test('payload: ime + voditelj + tag = kljuc + url /', () => {
    const [occ] = showsToNotify(SCHEDULE, NOW_1958, 2, new Set());
    const payload = buildNotificationPayload(occ, { name: 'Rock večer' });
    assert.equal(payload.title, 'Radio Markec');
    assert.equal(payload.body, 'Ob 20:00 se zacenja Rock večer (voditelj: Markec).');
    assert.equal(payload.tag, '2026-10-25@20-00@rock-vecer');
    assert.equal(payload.url, '/');

    const bare = buildNotificationPayload(occ);
    assert.equal(bare.body, 'Ob 20:00 se zacenja rock-vecer (voditelj: Markec).', 'brez resolverja = id, nic izumljenega');
  });
});

// ---------------------------------------------------------------------------
// 5. dispatchPush end-to-end (injektiran transport, realni ledzer)
// ---------------------------------------------------------------------------
describe('dispatchPush (orkestracija z injektiranim transportom)', () => {
  test('pošlje enkrat, ledzer naredi idempotentno; 410 obreze naročnino', async () => {
    resetPushState();
    const sub = makeSubscriber();
    addSubscription(sub);
    const calls = [];
    setPushTransport(async ({ endpoint }) => {
      calls.push(endpoint);
      return { status: 201 };
    });

    try {
      const first = await dispatchPush({ schedule: SCHEDULE, now: NOW_1958, leadMinutes: 2 });
      assert.equal(first.due, 1);
      assert.equal(first.delivered, 1);
      assert.equal(calls.length, 1);
      assert.ok(loadSentKeysSet().has('2026-10-25@20-00@rock-vecer'), 'ledzer ima kljuc');

      const second = await dispatchPush({ schedule: SCHEDULE, now: NOW_1958, leadMinutes: 2 });
      assert.equal(second.due, 0, 'restart ne poslje dvakrat');
      assert.equal(calls.length, 1);

      // Mrta narocnina: dispatch vidi novo oddajo, transport javi 410 -> obrezano
      const SCHEDULE2 = { sunday: [{ id: 'druga', startTime: '20:10', durationMinutes: 30 }] };
      const now2008 = new Date(2026, 9, 25, 20, 8, 0, 0);
      setPushTransport(async () => ({ status: 410 }));
      const third = await dispatchPush({ schedule: SCHEDULE2, now: now2008, leadMinutes: 2 });
      assert.equal(third.pruned, 1, 'mrta naročnina obrezana');
      assert.equal(loadSubscriptions().length, 0);
    } finally {
      setPushTransport(null); // obnovi produkcijo
    }
  });

  test('transport odpoved -> failed, NE obrezano, kljuc vseeno v ledzerju (brez spamminga)', async () => {
    resetPushState();
    const sub = makeSubscriber('https://push.example.com/y');
    addSubscription(sub);
    setPushTransport(async () => ({ status: 0 }));
    try {
      const SCHEDULE2 = { sunday: [{ id: 'tretja', startTime: '20:20', durationMinutes: 30 }] };
      const now = new Date(2026, 9, 25, 20, 18, 0, 0);
      const report = await dispatchPush({ schedule: SCHEDULE2, now, leadMinutes: 2 });
      assert.equal(report.failed, 1);
      assert.equal(report.pruned, 0);
      assert.equal(loadSubscriptions().length, 1, 'ziv endpoint ostane');
      assert.ok(loadSentKeysSet().has('2026-10-25@20-20@tretja'), 'termin je oznacen -- nic ponavljanja');
    } finally {
      setPushTransport(null);
    }
  });

  test('brez narocnin je tik nič in ne sprozi kripto/urnika', async () => {
    resetPushState(); // (naročnine so prazne po prejšnjih testih -- isti dataDir)
    const report = await dispatchPush({ schedule: SCHEDULE, now: NOW_1958, leadMinutes: 2 });
    assert.equal(report.skippedNoSubs, true);
  });
});

// ---------------------------------------------------------------------------
// 6. Rute (fastify inject nad realnimi datotekami v testnem dataDir)
// ---------------------------------------------------------------------------
describe('javne push rute /api/push/*', () => {
  async function app() {
    const fastify = Fastify({ logger: false });
    registerPushRoutes(fastify);
    return fastify;
  }

  test('GET /api/push/vapid: 200 + 87-znakni javni kljuc', async () => {
    resetPushState();
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/push/vapid' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.publicKey, 'string');
    assert.equal(body.publicKey.length, 87);
    await fastify.close();
  });

  test('POST subscribe: veljavna 201, podvojena = update, neveljavna 400 z razlogom', async () => {
    resetPushState();
    const fastify = await app();
    const sub = makeSubscriber('https://push.example.com/route-a');
    const ok = await fastify.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: { endpoint: sub.endpoint, keys: sub.keys },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().subscribers, 1);

    const bad = await fastify.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: { endpoint: 'http://nesmisel.x/y', keys: { p256dh: 'x', auth: 'y' } },
    });
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.json().error, 'razlog je viden');

    const empty = await fastify.inject({ method: 'POST', url: '/api/push/subscribe', payload: {} });
    assert.equal(empty.statusCode, 400);
    await fastify.close();
  });

  test('POST unsubscribe: odstrani, 0 za neobstojeco = posten rezultat', async () => {
    resetPushState();
    const fastify = await app();
    const sub = makeSubscriber('https://push.example.com/route-b');
    await fastify.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: { endpoint: sub.endpoint, keys: sub.keys },
    });
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      payload: { endpoint: 'https://push.example.com/route-b' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().removed, 1);
    const again = await fastify.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      payload: { endpoint: 'https://push.example.com/route-b' },
    });
    assert.equal(again.json().removed, 0);
    const missing = await fastify.inject({ method: 'POST', url: '/api/push/unsubscribe', payload: {} });
    assert.equal(missing.statusCode, 400);
    await fastify.close();
  });
});

describe('studio push rute', () => {
  async function app() {
    const fastify = Fastify({ logger: false });
    registerStudioPushRoutes(fastify);
    return fastify;
  }

  test('GET /studio/api/push: naročnine, javni kljuc, lastSent iz ledzerja', async () => {
    resetPushState();
    recordSentKey('2026-10-25@20-00@rock-vecer');
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/push' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.configured, true);
    assert.equal(body.publicKey.length, 87);
    assert.equal(body.lastSent, '2026-10-25@20-00@rock-vecer');
    assert.ok(body.sentLedger.endsWith('sent.jsonl'));
    await fastify.close();
  });

  test('POST /studio/api/push/test: brez narocnin = postena opomba, ne napaka', async () => {
    resetPushState();
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/studio/api/push/test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    assert.ok(res.json().note);
    await fastify.close();
  });

  test('POST /studio/api/push/test: z narocnino poslje po ISTEM transportu (setPushTransport)', async () => {
    resetPushState();
    const sub = makeSubscriber('https://push.example.com/studio-test');
    addSubscription(sub);
    const payloads = [];
    setPushTransport(async ({ endpoint, body }) => {
      payloads.push({ endpoint, body });
      return { status: 201 };
    });
    try {
      const fastify = await app();
      const res = await fastify.inject({ method: 'POST', url: '/studio/api/push/test' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.delivered, 1);
      assert.equal(body.ok, true);
      assert.equal(payloads.length, 1);
      // telo je REALNO aes128gcm (header + ciphertext), ne plain JSON:
      assert.equal(payloads[0].body[0] !== 0x7b, true, 'telo ni plain JSON ({)');
      await fastify.close();
    } finally {
      setPushTransport(null);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Ledzer poslanih (JSONL vzorec)
// ---------------------------------------------------------------------------
describe('sent ledger', () => {
  test('append + branje + raztrgana vrstica se preskoci', () => {
    const file = path.join(tmpDir(), 'sent.jsonl');
    recordSentKey('a@b@c', { filePath: file, sentAt: '2026-10-25T18:00:00Z' });
    fs.appendFileSync(file, '{"key":"raztrg\n'); // tore line
    recordSentKey('d@e@f', { filePath: file, sentAt: '2026-10-25T18:01:00Z' });
    const keys = loadSentKeysSet({ filePath: file });
    assert.deepEqual([...keys].sort(), ['a@b@c', 'd@e@f']);
    assert.ok(sentLedgerPath().includes(path.join('push', 'sent.jsonl')));
  });
});
