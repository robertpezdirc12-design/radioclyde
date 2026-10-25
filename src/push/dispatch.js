// Dispatch push obvestil -- "terminirana oddaja se zacenja".
//
// Cista logika (which shows are due, kaksen payload) je lozena od IO, tako
// kot vsi ostali moduli tega repozitorija: `showsToNotify` je cista funkcija
// nad urnikom + mnozico ze poslanih kljucev, `dispatchPush` pa orkestrira
// branje ledzerja, sifriranje in transport (injektiran za teste).
//
// Idempotentnost cez redepleje: poslan oznaceni par (datum@cas@oddaja) gre
// v dataDir/push/sent.jsonl -- JSONL po vzoru listenerSamples.js (kratke
// append vrstice so na lokalnem FS prakticno atomske). Zato restart ticka
// ne poslje istega obvestila dvakrat, in obvestilo pride PRVCIK pred
// zacikom, ne ob vsakem minutnem preverjanju.
//
// Iskrenost: nihce ne rece "poslano", ce transport ni odgovoril. Mrli
// endpointi (404/410) se obrezujejo iz shrambe -- brskalnik, ki ni vec
// obstajal, nikoli ne bo spet javil narocnine.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { loadSchedule, upcomingOccurrences } from '../scheduler/scheduleUtil.js';
import { loadOrCreateVapidKeys, vapidAuthorizationHeader } from './vapid.js';
import { encryptPushPayload } from './encrypt.js';
import { loadSubscriptions, removeManySubscriptions } from './subscriptions.js';

const log = createLogger('station');

// ---------- cista logika (testirana brez IO) ----------

export function occurrenceKey(occurrence) {
  return `${occurrence.date}@${occurrence.timeKey}@${occurrence.show.id}`;
}

// Oddaje, katerih zacik je v oknu [now, now+leadMinutes] in za katere se
// oznaceni kljuc se ni poslal. `schedule` je loadSchedule() izpust,
// `sentKeys` mnozica stringov. Cisto -- nobenega Date.now() znotraj.
export function showsToNotify(schedule, now, leadMinutes, sentKeys) {
  if (typeof leadMinutes !== 'number' || !Number.isFinite(leadMinutes) || leadMinutes < 0) {
    throw new Error('showsToNotify: leadMinutes mora biti ne-negativno stevilo');
  }
  return upcomingOccurrences(schedule, now, leadMinutes)
    .filter((occ) => !sentKeys.has(occurrenceKey(occ)))
    .sort((a, b) => a.minutesUntil - b.minutesUntil || (a.show.id < b.show.id ? -1 : 1));
}

// Deterministcen payload za eno oddajo. `name` razresi preko show briefa
// (resolveShowInfo), ko klicec poslje resolver -- sicer ostane id (cistost:
// ta modul ne zna brati markdown briefov in se ne pretvarja, da zna).
export function buildNotificationPayload(occurrence, { name = null } = {}) {
  const showName = name ?? occurrence.show.id;
  const body = occurrence.show.host
    ? `Ob ${occurrence.show.startTime} se zacenja ${showName} (voditelj: ${occurrence.show.host}).`
    : `Ob ${occurrence.show.startTime} se zacenja ${showName}.`;
  return {
    title: 'Radio Markec',
    body,
    tag: occurrenceKey(occurrence), // zamenja zastarelo obvestilo istega termina
    url: '/',
  };
}

// ---------- ledzer poslanih ----------

export function sentLedgerPath() {
  return config.paths.pushSentLedgerFile;
}

export function recordSentKey(key, { filePath = null, sentAt = null } = {}) {
  const target = filePath ?? sentLedgerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify({ key, sentAt: sentAt ?? new Date().toISOString() })}\n`);
}

export function loadSentKeysSet({ filePath = null } = {}) {
  const target = filePath ?? sentLedgerPath();
  if (!fs.existsSync(target)) return new Set();
  const keys = new Set();
  for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.key === 'string') keys.add(parsed.key);
    } catch {
      // Raztrgana vrstica (JSONL vzorec): preskoci, ne strmoglavi.
    }
  }
  return keys;
}

// Retencija po vzoru listenerSamples.js: ledger je append-only in bi s casom
// rasel brez meje (~2k vrstic/leto je majhno, a poceni zavarovalo). Nad
// SENT_LEDGER_MAX vrsticami prepis obdrzi zadnjih SENT_LEDGER_KEEP -- ključi
// so datum@cas@oddaja, torej najstarejši odpadejo prvi, kar je točno tisto,
// kar idempotentnost potrebuje (samo nedavno okno ima pomen). Atomska zamenjava,
// poceni pogoj (stevilo vrstic, ne branje vsakega ticka).
const SENT_LEDGER_MAX = 20_000;
const SENT_LEDGER_KEEP = 10_000;

export function pruneSentLedger({ filePath = null } = {}) {
  const target = filePath ?? sentLedgerPath();
  if (!fs.existsSync(target)) return 0;
  const lines = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length <= SENT_LEDGER_MAX) return 0;
  const kept = lines.slice(-SENT_LEDGER_KEEP);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, kept.join('\n') + '\n');
  fs.renameSync(tmp, target);
  log(`push dispatch: sent.jsonl porezan (${lines.length} -> ${kept.length} vrstic)`);
  return lines.length - kept.length;
}

// ---------- transport ----------

// Privzeti transport: globalni fetch (node 24), z casovno omejitvijo --
// dispatch tick sme obstati, tudi ce push servis visi. Nikoli ne vrze:
// { status } je edina resnica.
export async function defaultPushTransport({ endpoint, body, headers }) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status };
  } catch (err) {
    log(`push transport: ${endpoint.slice(0, 48)}... -- ${err.message}`);
    return { status: 0 }; // 0 = omrezje ni odgovorilo (ne vrzemo, ne trosimo)
  }
}

// Nastavljiv za studio test-gumb in teste (postavite/obnovite).
let transportOverride = null;
export function setPushTransport(fn) {
  transportOverride = fn;
}

async function transport(args) {
  return transportOverride ? transportOverride(args) : defaultPushTransport(args);
}

// Poslje eno sporocilo eni narocnini: sifriraj + podpisi + poslji.
// Vrne { delivered, gone, status }.
export async function sendPushTo(subscription, payloadJson, { keys, subject }) {
  let body;
  try {
    body = encryptPushPayload({
      subscriberPublicKeyB64u: subscription.keys.p256dh,
      authSecretB64u: subscription.keys.auth,
      plaintext: payloadJson,
    });
  } catch {
    // Neveljavni kljuci narocnine = mrta narocnina, ne napaka dispatcha.
    return { delivered: false, gone: true, status: 400 };
  }
  const headers = {
    Authorization: vapidAuthorizationHeader({ endpoint: subscription.endpoint, subject, keys }),
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: '60',
  };
  const { status } = await transport({ endpoint: subscription.endpoint, body, headers });
  return { delivered: status >= 200 && status < 300, gone: status === 404 || status === 410, status };
}

// ---------- orkestracija ----------

// Scheduler registrira tick na navadnem every() timerju, ne na runSerialized
// repu -- pošiljanje eni naročnici lahko traja do 10 s (AbortSignal), zato
// prehod, ki preseže interval, ne sme teči vzporedno z naslednjim: ključ
// zapadlega termina se zapiše šele PO celotni zanki naročnikov, prekrivajoč
// prehod bi torej isti termin znova izpeljal in znova poslal (dvojna
// obvestila + dvojni ledger ključi). Zastavica "v letu", ista disciplina kot
// studioPodcastApi gumb za izdelavo.
let dispatchInFlight = false;

// Glavni tik: preveri urnik, poslji vse, kar je zapadel, oznaci v ledzer.
// Vrne porocilo s stevilkami -- tic nikoli ne vrze (scheduler logira napako
// in gre naprej); postene napake so v porocilu, ne v stack traceu.
// skippedConcurrent: prejšnji prehod še teče (zgornja varovalka) -- ta klic
// ničesar ne pošlje in ničesar ne zapiše, naslednji tick bo termin spet videl.
export async function dispatchPush({
  schedule = null,
  now = new Date(),
  leadMinutes = config.push?.leadMinutes ?? 2,
  subject = config.push?.subject ?? 'mailto:radio-markec@example.com',
  nameResolver = null,
  sendFn = null,
} = {}) {
  if (dispatchInFlight) {
    return { due: 0, delivered: 0, failed: 0, pruned: 0, skippedConcurrent: true };
  }
  dispatchInFlight = true;
  try {
    const subs = loadSubscriptions();
    if (subs.length === 0) return { due: 0, delivered: 0, failed: 0, pruned: 0, skippedNoSubs: true };

    const station = schedule ?? loadSchedule();
    const sentKeys = loadSentKeysSet();
    pruneSentLedger(); // obenem z branjem -- cena je ze placana
    const due = showsToNotify(station, now, leadMinutes, sentKeys);
    if (due.length === 0) return { due: 0, delivered: 0, failed: 0, pruned: 0 };

    const keys = loadOrCreateVapidKeys();
    let delivered = 0;
    let failed = 0;
    const goneEndpoints = new Set();

    for (const occ of due) {
      const name = nameResolver ? nameResolver(occ.show) : null;
      const payload = JSON.stringify(buildNotificationPayload(occ, { name }));
      for (const sub of subs) {
        const result = await (sendFn ?? sendPushTo)(sub, payload, { keys, subject });
        if (result.delivered) delivered += 1;
        else if (result.gone) goneEndpoints.add(sub.endpoint);
        else failed += 1;
      }
      recordSentKey(occurrenceKey(occ));
    }

    const pruned = removeManySubscriptions(goneEndpoints);
    if (pruned > 0) log(`push dispatch: obrezanih ${pruned} mrlih narocnin`);
    return { due: due.length, delivered, failed, pruned };
  } finally {
    dispatchInFlight = false;
  }
}
