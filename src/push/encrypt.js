// Sifriranje push payloada po RFC 8291 (shema "aes128gcm", razporejanje po
// RFC 8188, razdelku 2) -- brez novih npm odvisnosti, vse iz node:crypto.
//
// Zakaj sploh sifriramo: push servis (Google/Mozilla/Apple) je samo slepi
// kurir -- payload sme brati SAMO odjemalec, ki ima zasebni kljuc paru
// p256dh. Streznik torej za vsako narocnino:
//   1. generira kratkotrajen eemeralni P-256 par,
//   2. iz ECDH(emeralni, p256dh) + auth skrivnosti izpelje IKM (HKDF z
//      info "WebPush: info" + obe javni tocki -- RFC 8291, razdelek 3.3),
//   3. iz nakljucne soli izpelje CEK (16 B) in NONCE (12 B),
//   4. AES-256-GCM nad payloadom + zakljucni bajt 0x02 (zadnji zapis).
// Telo je potem header: sol(16) || rs(4) || idlen(1) || emeraldna javna
// tocka(65) || ciphertext+tag -- natanko tisto, kar je `web-push` npm paket
// posiljal leta pred tem; razliko je, da je tukaj vsak korak viden in testno
// preverjen (test naredi polni roundtrip z odjemalcevim zasebnim kljucem).
import crypto from 'node:crypto';
import { fromB64u } from './vapid.js';

const RECORD_SIZE = 4096; // RFC 8188: rs v headerju; en zapis je dovolj za nase kratke sporocile

function hkdf(ikm, salt, info, length) {
  // crypto.hkdfSync vrne ArrayBuffer; poslovni klici zeli Buffer.
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

function ecdhIkm({ subscriberPublicRaw, ephemeral, authSecretB64u }) {
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: subscriberPublicRaw.subarray(1, 33).toString('base64url'),
        y: subscriberPublicRaw.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    }),
  });
  // RFC 8291, razdelek 3.3: PRK_key = HKDF(ikm=ECDH, salt=auth skrivnost,
  // info = "WebPush: info" || 0x00 || UA_public || AS_public, L=32).
  const info = Buffer.concat([
    Buffer.from('WebPush: info', 'utf8'),
    Buffer.from([0x00]),
    subscriberPublicRaw,
    ephemeral.publicKeyRaw,
  ]);
  return hkdf(sharedSecret, fromB64u(authSecretB64u), info, 32);
}

function generateEphemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicKeyRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return { privateKey, publicKeyRaw };
}

// Vrne telo POST zahtevka (aes128gcm) za podan plaintext. `randomSource` je
// injektiran (vrne 16 bajtov) samo zato, da test deterministcno preveri
// headerjev zapis; prodakcija uporablja crypto.randomBytes.
export function encryptPushPayload({
  subscriberPublicKeyB64u,
  authSecretB64u,
  plaintext,
  randomSource = () => crypto.randomBytes(16),
} = {}) {
  const subscriberPublicRaw = fromB64u(subscriberPublicKeyB64u);
  if (subscriberPublicRaw.length !== 65 || subscriberPublicRaw[0] !== 0x04) {
    throw new Error('encryptPushPayload: p256dh ni nespremenjena P-256 tocka (65 bajtov)');
  }
  if (!authSecretB64u) throw new Error('encryptPushPayload: manjka auth skrivnost');

  const ephemeral = generateEphemeral();
  const ikm = ecdhIkm({ subscriberPublicRaw, ephemeral, authSecretB64u });
  const salt = randomSource();

  const prk = ikm; // PRK_key iz RFC 8291 -- nadaljnji HKDF koraki ga samo zmesajo s soljo
  const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Zadnji (edini) zapis: payload || 0x02 -- ozancujoc, da je to konec.
  const plaintextBytes = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  if (plaintextBytes.length > RECORD_SIZE - 17) {
    throw new Error('encryptPushPayload: payload prevelik za en aes128gcm zapis (rs=4096)');
  }
  // aes128gcm = AES-128-GCM (RFC 8291 5.2: CEK je 16 oktetov) -- ime sheme
  // nosi velikost kljuca, ne velikosti bloka.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, RECORD_SIZE >> 8, RECORD_SIZE & 0xff]), // rs, big-endian 4B
    Buffer.from([65]), // idlen: emeraldna javna tocka je vedno 65 bajtov
    ephemeral.publicKeyRaw,
  ]);
  return Buffer.concat([header, ciphertext]);
}
