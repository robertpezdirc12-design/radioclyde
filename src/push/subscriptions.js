// Shramba push narocnin -- OPT-IN registracij brskalnikov, ki so si
// izrecno zazelela obvestilo ob zaciku terminirane oddaje.
//
// Kaj se shranjuje (in kaj NE): endpoint push servisa + javni kriptografski
// kljuci (p256dh/auth), ki omogocajo sifriranje. NIC drugega -- brez imen,
// brez e-post, brez racunov, brez povezave na posameznika. To je ista
// zaveza, kot jo ima favourites seznam (localStorage, "strezniku ne posiljamo")
// -- push narocnina pa je po naravi strezno stvar, zato je tu najmanjsi
// mozni zapis, brez katerega sifriranje ne gre.
//
// Format: en JSON dokument (lista narocnin), ne JSONL -- vpisi so majhni,
// spremembe (odjava, obrezovanje mrlih endpointov) so BRISANJE, pri katerem
// je polna prepis najbolj izrisena operacija. Pokvarjena datoteka se prebere
// kot prazna lista (z opombo v log), nikoli ne strmoglavi dispatch ticka.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

export function subscriptionsFilePath() {
  return config.paths.pushSubscriptionsFile;
}

// Oblika, ki jo sprejmemo -- vse ostalo je 400 (rute to pinajo posebej).
export function isValidSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return false;
  if (sub.endpoint.length > 2048) return false;
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object') return false;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length < 40 || keys.p256dh.length > 256) return false;
  if (typeof keys.auth !== 'string' || keys.auth.length < 8 || keys.auth.length > 256) return false;
  return true;
}

function readAll(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => isValidSubscription(s));
  } catch (err) {
    // Pokvarjen zapiskostal: izgubljene narocnine so boljse od strmoglavljenega
    // schedulera -- zapisemo si to, ne pretvarjamo se, da se ni zgodilo.
    log(`push subscriptions: pokvarjena datoteka (${err.message}) -- berem kot prazno`);
    return [];
  }
}

function writeAll(filePath, subs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(subs, null, 2) + '\n');
}

export function loadSubscriptions({ filePath = null } = {}) {
  return readAll(filePath ?? subscriptionsFilePath());
}

export function countSubscriptions({ filePath = null } = {}) {
  return loadSubscriptions({ filePath }).length;
}

// Dodaj ali posodobi obstojeco narocnino (isti endpoint = ista naprava;
// brskalnik lahko rotira keys, zadnji vpis je resnica). Vrne koncno stevilo.
export function addSubscription(sub, { filePath = null, addedAt = null } = {}) {
  if (!isValidSubscription(sub)) throw new Error('Neveljavna narocnina: endpoint in keys so obvezni');
  const target = filePath ?? subscriptionsFilePath();
  const all = readAll(target);
  const filtered = all.filter((s) => s.endpoint !== sub.endpoint);
  filtered.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    addedAt: addedAt ?? new Date().toISOString(),
  });
  writeAll(target, filtered);
  return filtered.length;
}

// Odjava (brskalnik poslje event ali ga uporabnik izklopi). Vrne stevilo
// odstranjenih -- 0 je posten rezultat, ne napaka.
export function removeSubscription(endpoint, { filePath = null } = {}) {
  const target = filePath ?? subscriptionsFilePath();
  const all = readAll(target);
  const kept = all.filter((s) => s.endpoint !== endpoint);
  if (kept.length !== all.length) writeAll(target, kept);
  return all.length - kept.length;
}

// Odstrani narocnine za endpointe, ki so jih push servisi javili kot mrte
// (404/410). `endpoints` je mnozica; vrne stevilo odstranjenih.
export function removeManySubscriptions(endpoints, { filePath = null } = {}) {
  if (endpoints.size === 0) return 0;
  const target = filePath ?? subscriptionsFilePath();
  const all = readAll(target);
  const kept = all.filter((s) => !endpoints.has(s.endpoint));
  if (kept.length !== all.length) writeAll(target, kept);
  return all.length - kept.length;
}
