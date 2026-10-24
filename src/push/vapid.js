// VAPID kljuci in RFC 8292 avtorizacijski header za Web Push.
//
// Web Push zahteva, da je vsako sporocilo podpisano z VAPID (Voluntary
// Application Server Identification) -- par P-256 kljucev, ki jih streznik
// sam ustvari in shrani. Nista to "API key od tretje strani": par nastane
// lokalno z node:crypto, brskalnik vidi samo javno polovico (applicationServerKey),
// push servis (Mozilla/Google/Apple) s podpisom preveri, da smejo sporocila
// prihajati v ime te domene. Brez omrezja, brez registracij, brez tipk.
//
// Kljuci lezijo v dataDir/push/vapid.json. Prvi klic jih ustvari, vsi
// poznejsi klici so branje -- zato so obvestila stabilna cez redeploy
// (izguba privatnega kljuca pomeni, da vse obstojece narocnine prenehajo
// delovati; brskalnik sam odkrije neujemljivost in jih zavrze).
//
// Del zgodovine datoteke: modul je namenoma majhen in cist -- testi vdrte
// header s crypto.verify(), prodakcija pa ga samo sestavi.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';

// ---------- base64url pomocniki (URL-safe, brez podpisa) ----------

export function toB64u(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function fromB64u(text) {
  return Buffer.from(String(text), 'base64url');
}

// ---------- kljuci na disku ----------

export function vapidFilePath() {
  return config.paths.pushVapidFile;
}

function jwkToRawPublic(jwk) {
  // Nespremenjena tocka (uncompressed point) = 0x04 || x || y -- to obliko
  // bralci applicationServerKey (in push servis) pricakujejo na zici.
  return Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x), fromB64u(jwk.y)]);
}

function writeVapidFile(filePath, { publicKeyJwk, privateKeyJwk }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic tmp+rename with 0600: this file carries the PRIVATE half of the
  // signing pair. A plain write interrupted mid-way leaves a torn file whose
  // next read falls back to regeneration (silently invalidating every
  // existing browser subscription), and the default 0644 mode would leave
  // the private key readable by every account on a shared box. One write,
  // right perms, either the old file or the new one -- never a torn one.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ publicKey: publicKeyJwk, privateKey: privateKeyJwk }, null, 2) + '\n',
    { mode: 0o600 }
  );
  fs.renameSync(tmp, filePath);
}

// Ustvari par le, ce ga se ni; sicer vrne obstojeci. Vrne { publicKey,
// privateKey } kot JWK objekta (x/y oziroma d, base64url) plus raw javno
// polovico, kakrso gre na zico. `generatePair` je injektiran za teste.
export function loadOrCreateVapidKeys({ filePath = null, generatePair = null } = {}) {
  const target = filePath ?? vapidFilePath();
  if (fs.existsSync(target)) {
    try {
      const jwk = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (jwk?.publicKey?.x && jwk?.publicKey?.y && jwk?.privateKey?.d) {
        return {
          publicKey: jwk.publicKey,
          privateKey: jwk.privateKey,
          publicKeyRaw: jwkToRawPublic(jwk.publicKey),
          publicKeyB64u: toB64u(jwkToRawPublic(jwk.publicKey)),
        };
      }
    } catch {
      // Pokvarjena datoteka -> pade v spodnjo generacijo in jo prepise.
      // Honesty pravilo je dokumentirano v docs/auto-radio.md: ce se to
      // zgodi, obstojece narocnine prenehajo delovati (brskalnik jih zavrze);
      // boljse kot strmoglavljenje streznika.
    }
  }
  const generate = generatePair ?? (() => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { publicKey: publicKey.export({ format: 'jwk' }), privateKey: privateKey.export({ format: 'jwk' }) };
  });
  const { publicKey, privateKey } = generate();
  writeVapidFile(target, { publicKeyJwk: publicKey, privateKeyJwk: privateKey });
  return {
    publicKey,
    privateKey,
    publicKeyRaw: jwkToRawPublic(publicKey),
    publicKeyB64u: toB64u(jwkToRawPublic(publicKey)),
  };
}

// ---------- RFC 8292: podpisani Authorization header ----------

function b64uJson(obj) {
  return toB64u(Buffer.from(JSON.stringify(obj), 'utf8'));
}

// ES256 = ECDSA P-256 nad SHA-256, podpis kot r||s (64 bajtov, ieee-p1363).
function es256Sign(dataB64u, privateKeyJwk) {
  const key = crypto.createPrivateKey({ key: privateKeyJwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(dataB64u, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return toB64u(signature);
}

// Sestavi Authorization header oblike `vapid t=<JWT>, k=<javni kljuc>`.
// `now` je injektiran (ms) -- testi pinajo exp tocnost; prodakcija pusti
// privzeto. exp okno 12 ur: push servisi odklonijo JWT z exp v preteklosti,
// daljse okno pa bi zaprlo vrata preklicu -- 12 h je nenavaden, a povsem
// dovolj kompromis (en odjemalski tick ga vedno obnovi).
export function vapidAuthorizationHeader({
  endpoint,
  subject,
  keys,
  now = Date.now(),
  expiresAfterSeconds = 12 * 60 * 60,
} = {}) {
  if (!endpoint || !keys?.publicKey?.x || !keys?.privateKey?.d) {
    throw new Error('vapidAuthorizationHeader: manjka endpoint ali kljuci');
  }
  // aud = izvor endpointa (RFC 8292): push servisi preverjajo natancno
  // ujemanje originov -- na primer https://fcm.googleapis.com pri Googlu.
  const origin = new URL(endpoint).origin;
  const header = b64uJson({ typ: 'JWT', alg: 'ES256' });
  const payload = b64uJson({
    aud: origin,
    exp: Math.floor(now / 1000) + expiresAfterSeconds,
    sub: subject.startsWith('mailto:') ? subject : `mailto:${subject}`,
  });
  const jwt = `${header}.${payload}.${es256Sign(`${header}.${payload}`, keys.privateKey)}`;
  return `vapid t=${jwt}, k=${toB64u(jwkToRawPublic(keys.publicKey))}`;
}
