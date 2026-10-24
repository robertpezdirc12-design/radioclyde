// Predvečerna diagnostika (P4 #31) -- EN ukaz, ki operaterju pove, ali bo
// današnja oddaja preživela, ŠE PRED prvo terminirano uro. Krona odpornostnega
// loka P4 #28–#30: program namreč preživi mrtev usmerjevalnik, ampak doslej
// ni obstajal noben način, da to ugotoviš vnaprej, brez čakanja prve režije.
//
// Dogovori, ki jih ta modul varuje (iste pravile kot oddaja sama):
//   * skip-not-fail -- NOBENO preverjanje ne sme pasti; okvaro opišemo,
//     ne podremo procesa. Edini 'fail' statusi so tista stanja, ob katerih
//     program RES ne more sestaviti programa (zlomljen config.json, ni
//     podatkovne mape, ni nobene glasbe v 'local' načinu, poškodovani
//     korpusi -- offline hrbtenica).
//   * poštenost -- mrtev omrežni vir je 'warn', NIKOLI 'fail': to je točno
//     pogodba P4 #28–#30 (rubrika poje pošteno vrstico, radio igra dalje).
//     Diagnostika, ki bi umirala ob mrtvem routerju, bi lagala o programu.
//   * determinizem -- isti inputi -> bajtno isti izpis (rezultati imajo
//     stabilen vrstni red, razlogi so statični nizi).
//
// Zasnova kot asrun.js: ta modul NE importira config/index.js, da doctor
// deluje TUDI z zlomljenim config.json (prav ta primer je ena od stvari,
// ki jih mora sporočiti). Vse odvisnosti so injicirane; CLI jih pripravi,
// testi jih stavijo s fiko. Tudi piperVoice.js ne smemo potegniti noter
// (ta potegne config na prvi vrstici) -- njegovo logiko ključa/datoteke
// lokalno ponovimo s komentarjem, ki kaže nanj kot izvira.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readAiredFile } from './asrun.js';
import { QUIZ_QUESTIONS } from './quizFacts.js';
import { ON_THIS_DAY_MUSIC } from './onThisDayFacts.js';
import { GENERAL_ROCK_FACTS } from './rockFacts.js';

export const STATUS = { OK: 'ok', WARN: 'warn', FAIL: 'fail', SKIP: 'skip' };

// Stabilen vrstni red izpisa -- diagnostika brez vrstnega reda bi bila
// loterijski list. Oznake so slovenske, ID-ji ostanejo strojni.
export const CHECK_ORDER = [
  { id: 'config', label: 'konfiguracija' },
  { id: 'dataDir', label: 'podatkovna mapa' },
  { id: 'tts', label: 'govor (TTS)' },
  { id: 'library', label: 'glasbena knjižnica' },
  { id: 'ledger', label: 'predvajalni ledger' },
  { id: 'corpus', label: 'korpusi (offline rezerva)' },
  { id: 'feeds', label: 'omrežni viri' },
];

// Spodnje meje korpusov -- zrcalijo integritetne teste (onThisDay.test.mjs,
// trivia/quiz suite) na run-u: če nekdo v kodi skrči hrbtenico offline
// programa, diagnostika to pove operaterju PRED oddajo, ne po njej.
export const CORPUS_FLOORS = {
  quiz: 40,
  musicFacts: 40,
  musicDays: 40,
  rock: 20,
};

function result(id, label, status, detail) {
  return { id, label, status, detail };
}

// Slovensko števanje: 1 vnos, 2 vnosa, 5 vnosov (in 0 vnosov -- po
// konvenciji slovenskega knjižnega jezika je pri ničli množina).
//   slPlural(1, 'vnos', 'vnosa', 'vnosov') -> 'vnos'
export function slPlural(n, one, few, many) {
  if (n === 1) return one;
  if (n === 2 || n === 3 || n === 4) return few;
  return many;
}

// -- 1. konfiguracija -------------------------------------------------------
// CLI ujame napako dinamičnega importa in nam jo podasetavljivo podaje --
// zlomljen config.json je NAPAKA (brez njega ni poti do podatkov), manjkajoč
// autoRadio blok pa le opozorilo (glavna stran oddaje deluje brez njega).
export function checkConfig(configOrError) {
  if (configOrError instanceof Error) {
    return result('config', 'konfiguracija', STATUS.FAIL,
      `config.json se ne prebere: ${configOrError.message}`);
  }
  if (!configOrError || typeof configOrError !== 'object') {
    return result('config', 'konfiguracija', STATUS.FAIL,
      'config.json se ne prebere: vsebina ni objekt');
  }
  const ar = configOrError.autoRadio;
  if (!ar || typeof ar !== 'object') {
    return result('config', 'konfiguracija', STATUS.WARN,
      'config.json berljiv, ampak blok autoRadio manjka -- avtomatski program ne bo stopil na parket');
  }
  if (!ar.enabled) {
    return result('config', 'konfiguracija', STATUS.WARN,
      'config.json berljiv, ampak autoRadio.enabled = false -- terminirane oddaje greste v klasični način');
  }
  return result('config', 'konfiguracija', STATUS.OK,
    `config.json berljiv, autoRadio omogočen (postaja: ${configOrError.stationName ?? 'neznana'})`);
}

// -- 2. podatkovna mapa ------------------------------------------------------
// dataDir je dom ledgerja, klipov, piper glasb in cache. Mora obstajati in
// biti zapisljiva; če kaže na datoteko (ne mapo), je to NAPAKA, saj jo
// vse risi odpirajo kot mapo.
export function checkDataDir(dataDir) {
  if (!dataDir || typeof dataDir !== 'string') {
    return result('dataDir', 'podatkovna mapa', STATUS.FAIL,
      'config.dataDir ni nastavljen');
  }
  let st = null;
  try { st = fs.statSync(dataDir); } catch { st = null; }
  if (!st) {
    return result('dataDir', 'podatkovna mapa', STATUS.WARN,
      `${dataDir} še ne obstaja -- moduli jo ustvarijo ob prvi rabi, do takrat so logi/ledger prazni`);
  }
  if (!st.isDirectory()) {
    return result('dataDir', 'podatkovna mapa', STATUS.FAIL,
      `${dataDir} ni mapa, ampak datoteka -- vse risi od nje pričakujejo mapo`);
  }
  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    return result('dataDir', 'podatkovna mapa', STATUS.FAIL,
      `${dataDir} ni zapisljiva -- predvajalni ledger in klipi ne morejo rasti`);
  }
  return result('dataDir', 'podatkovna mapa', STATUS.OK,
    `${dataDir} (berljiva, zapisljiva)`);
}

// -- 3. govor (TTS) ----------------------------------------------------------
// Glasniki v skip-not-fail svetu: manjkajoč TTS pomeni SKOČEN govorjeni
// segment, glasba igra naprej -- zato je to 'warn', ne 'fail'. Preverimo,
// kar je preverljivo na disku; spletne storitve (edge) se preverjajo "v
// režiji", kar povemo iskreno.
//
// Piper logiko ponovimo lokalno (piperVoice.js potegne config v modul,
// doctor mora delovati brez configa): ključ (brez .onnx končnice) se išče
// kot <piperDataDir>/<ključ>.onnx; pot form pa se rešuje glede na cwd.
// Vir teh pravil: src/auto/piperVoice.js (resolvePiperVoice, piperDataDir).
const PIPER_DEFAULT_MODEL = 'voices/sl_SI-artur-medium.onnx'; // == PIPER_DEFAULT_MODEL v piperVoice.js

function piperDataDirFrom(config) {
  const dir = config?.autoRadio?.voice?.piperDataDir
    ?? path.join(config?.dataDir ?? process.cwd(), 'piper');
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

async function countFilesByExtension(dir, extensions, depth = 0) {
  if (depth > 12) return 0; // jezikovne mape niso do tu globoke
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st = null;
    try { st = await fsp.stat(full); } catch { continue; }
    if (st.isDirectory()) count += await countFilesByExtension(full, extensions, depth + 1);
    else if (extensions.some((ext) => name.toLowerCase().endsWith(ext))) count += 1;
  }
  return count;
}

export async function checkTts(config, dataDir) {
  const ar = config?.autoRadio;
  if (!ar?.voice) {
    return result('tts', 'govor (TTS)', STATUS.WARN,
      'autoRadio.voice ni nastavljen -- govorjeni segmenti bodo tiho preskočeni (glasba igra naprej)');
  }
  const voice = ar.voice;
  const mode = voice.mode ?? 'clips';
  const parts = [];
  let status = STATUS.OK;

  // klipni sloj (primaren ALI v obnovitveni verigi)
  const chain = [mode, voice.edgeFallback ?? voice.fallback].filter(Boolean);
  if (chain.includes('clips')) {
    const clipsDir = path.isAbsolute(voice.clipsDir ?? 'voice-clips')
      ? voice.clipsDir ?? 'voice-clips'
      : path.join(dataDir ?? process.cwd(), voice.clipsDir ?? 'voice-clips');
    const clips = await countFilesByExtension(clipsDir, ['.wav', '.mp3']);
    if (clips > 0) {
      parts.push(`klipi: ${clips} ${slPlural(clips, 'datoteka', 'datoteki', 'datotek')} v ${clipsDir}`);
    } else {
      parts.push(`klipi: mapa ${clipsDir} je prazna ali manjka (posneti ali predgeneriraj)`);
      status = STATUS.WARN;
    }
  }

  if (mode === 'piper') {
    const model = voice.defaultPiperVoice ?? PIPER_DEFAULT_MODEL;
    const isKey = !/\.onnx$/i.test(String(model));
    const dataRoot = piperDataDirFrom(config);
    const modelPath = isKey
      ? path.join(dataRoot, `${model}.onnx`)
      : (path.isAbsolute(model) ? model : path.join(process.cwd(), model));
    let hasVoice = false;
    try { hasVoice = fs.statSync(modelPath).isFile(); } catch { hasVoice = false; }
    if (hasVoice) {
      parts.push(`piper: glasba ${model} je na disku`);
    } else if (isKey) {
      parts.push(`piper: glasba ${model} se NE prenese -- naloži jo ob prvi sintezi (enkrat, HuggingFace)`);
      status = STATUS.WARN;
    } else {
      parts.push(`piper: model ${modelPath} manjka`);
      status = STATUS.WARN;
    }
  } else if (mode === 'edge') {
    parts.push('edge: spletna nevronka (brez ključa) -- dostopnost se pokaže v režiji, obnova prek edgeFallback');
  } else if (mode === 'sapi') {
    parts.push('sapi: Windows glasovi -- preverjanje ob režiji');
  } else if (mode === 'espeak') {
    parts.push('espeak: sistemski govor -- preverjanje ob režiji');
  } else if (mode !== 'clips') {
    parts.push(`neznani način "${mode}" -- govora ne bo, glasba igra naprej`);
    status = STATUS.WARN;
  }

  if (chain.includes('none') && !chain.includes('clips') && mode !== 'piper') {
    parts.push('obnovitvena veriga se konča z "none" -- oboje odpovedano pomeni tišino namesto govora');
  }

  return result('tts', 'govor (TTS)', status, parts.join(' · '));
}

// -- 4. glasbena knjižnica ----------------------------------------------------
// 'local' način z 0 skladbami = program brez glasbe = NAPAKA (pravilo,
// ne sramota: brez nje ni ničesar za predvajati). 'auto' z 0 lokalnimi je
// opozorilo -- Plex je v takem načinu primaren, lokalna je rezerva; če
// sta oba mrtva, stopi napolnilna plejlista (odpornostni lok).
export async function checkLibrary(config) {
  const music = config?.autoRadio?.music;
  if (!music || typeof music !== 'object') {
    return result('library', 'glasbena knjižnica', STATUS.WARN,
      'autoRadio.music ni nastavljen -- če želiš lokalni vir, nastavi localDirs');
  }
  const source = music.source ?? 'auto';
  const dirs = Array.isArray(music.localDirs) ? music.localDirs : [];
  const extensions = Array.isArray(music.audioExtensions) && music.audioExtensions.length
    ? music.audioExtensions
    : ['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav'];
  if (source === 'plex') {
    return result('library', 'glasbena knjižnica', STATUS.OK,
      `vir: plex (${dirs.length} lokalnih map kot rezerva, preverjanje dostopnosti z --net)`);
  }
  if (dirs.length === 0) {
    const detail = source === 'local'
      ? 'vir: local, ampak localDirs je prazen -- brez skladen ne bo programa'
      : 'vir: auto, ampak localDirs je prazen -- vse je na Plexu (preverjanje dostopnosti z --net)';
    return result('library', 'glasbena knjižnica',
      source === 'local' ? STATUS.FAIL : STATUS.WARN, detail);
  }
  let existing = 0;
  let tracks = 0;
  for (const dir of dirs) {
    let st = null;
    try { st = await fsp.stat(dir); } catch { st = null; }
    if (st?.isDirectory()) {
      existing += 1;
      tracks += await countFilesByExtension(dir, extensions);
    }
  }
  if (tracks === 0) {
    return result('library', 'glasbena knjižnica',
      source === 'local' ? STATUS.FAIL : STATUS.WARN,
      `0 skladb v ${existing}/${dirs.length} mapah (${dirs.join(', ')}) -- pričakovana končnica manjka ali so mape prazne`);
  }
  const detail = source === 'local'
    ? `vir: local -- ${tracks} ${slPlural(tracks, 'skladba', 'skladbi', 'skladb')} v ${existing}/${dirs.length} ${slPlural(dirs.length, 'mapi', 'mapah', 'mapah')}`
    : `vir: auto -- ${tracks} ${slPlural(tracks, 'lokalna skladba', 'lokalni skladbi', 'lokalnih skladb')} v ${existing}/${dirs.length} ${slPlural(dirs.length, 'mapi', 'mapah', 'mapah')} (Plex primaren)`;
  const status = existing === dirs.length ? STATUS.OK : STATUS.WARN;
  return result('library', 'glasbena knjižnica', status, detail);
}

// -- 5. predvajalni ledger -----------------------------------------------------
// history/aired.jsonl je edini resnični vir izvajalnega poročila (P4 #27).
// Ponovno uporabimo readAiredFile -- ista branja, ista toleranca do pokvarjenih
// vrstic, bajtno ista štetja kot poročilo. Manjkajoč ledger je opozorilo
// (nova postaja ima prazen ledger, to ni napaka), pokvarjene vrstice so
// opozorilo (števec jih poroča pošteno), dolgo tiho ledger pa opozorilo:
// morda ne piše plex/scrobbleTrack, morda ne igra nič -- operater naj ve.
export function checkLedger(airedPath, { nowMs = Date.now() } = {}) {
  const { entries, corruptCount, fileExists } = readAiredFile(airedPath);
  if (!fileExists) {
    return result('ledger', 'predvajalni ledger', STATUS.WARN,
      `${airedPath} še ne obstaja -- as-run poročilo bo za zdaj prazno (nova postaja?)`);
  }
  if (entries.length === 0) {
    return result('ledger', 'predvajalni ledger', STATUS.WARN,
      `${airedPath} je prazen${corruptCount > 0 ? ` (${corruptCount} ${slPlural(corruptCount, 'pokvarjena vrstica', 'pokvarjeni vrstici', 'pokvarjenih vrstic')})` : ''} -- izvajalno poročilo bo prazno`);
  }
  // Pokvarjene vrstice so izgubljeni podatki za licenčno poročilo (P4 #27),
  // tudi kadar drugi vnosi preživijo -- zato warn, ne ok z opombo.
  if (corruptCount > 0) {
    return result('ledger', 'predvajalni ledger', STATUS.WARN,
      `${entries.length} ${slPlural(entries.length, 'vnos', 'vnosa', 'vnosov')} preživelih, ${corruptCount} ${slPlural(corruptCount, 'pokvarjena vrstica', 'pokvarjeni vrstici', 'pokvarjenih vrstic')} izpuščenih -- preveri zapisovalnik (scrobbleTrack)`);
  }
  const last = entries[entries.length - 1];
  const playedAt = typeof last?.playedAt === 'string' ? last.playedAt : '';
  const parsed = playedAt ? Date.parse(playedAt) : NaN;
  if (Number.isFinite(parsed)) {
    const days = Math.floor((nowMs - parsed) / 86_400_000);
    if (days >= 7) {
      return result('ledger', 'predvajalni ledger', STATUS.WARN,
        `${entries.length} ${slPlural(entries.length, 'vnos', 'vnosa', 'vnosov')}, zadnji pred ${days} ${slPlural(days, 'dnem', 'dnevoma', 'dnevi')} (${playedAt.slice(0, 16)}) -- scrobbleTrack morda ne piše`);
    }
  }
  const lastNote = `zadnji ${playedAt ? playedAt.slice(0, 16) : 'neznan'}`;
  return result('ledger', 'predvajalni ledger', STATUS.OK,
    `${entries.length} ${slPlural(entries.length, 'vnos', 'vnosa', 'vnosov')}, ${lastNote}`);
}

// -- 6. korpusi (offline rezerva) ---------------------------------------------
// Integriteta hrbtenice offline programa -- enaka spodnje meje kot testi.
// Ker so korpusi del KODE (ne podatkov), je 'fail' tu edino realno stanje,
// pri katerem je nekdo pokvaril kodo -- in točno to mora diagnostika pokriki.
export function checkCorpora({
  quizCount = QUIZ_QUESTIONS.length,
  musicCount = ON_THIS_DAY_MUSIC.length,
  rockCount = GENERAL_ROCK_FACTS.length,
} = {}) {
  const days = new Set(ON_THIS_DAY_MUSIC.map((e) => `${String(e.month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`)).size;
  const problems = [];
  if (quizCount < CORPUS_FLOORS.quiz) problems.push(`kviz ${quizCount}/${CORPUS_FLOORS.quiz}`);
  if (musicCount < CORPUS_FLOORS.musicFacts) problems.push(`glasba ${musicCount}/${CORPUS_FLOORS.musicFacts}`);
  if (days < CORPUS_FLOORS.musicDays) problems.push(`glasba-dni ${days}/${CORPUS_FLOORS.musicDays}`);
  if (rockCount < CORPUS_FLOORS.rock) problems.push(`zanimivosti ${rockCount}/${CORPUS_FLOORS.rock}`);
  if (problems.length > 0) {
    return result('corpus', 'korpusi (offline rezerva)', STATUS.FAIL,
      `pod mejo: ${problems.join(', ')} -- offline program je okrnjen, popravi korpus`);
  }
  return result('corpus', 'korpusi (offline rezerva)', STATUS.OK,
    `kviz ${quizCount} vprašanj · glasba ${musicCount} dejstev prek ${days} dni · zanimivosti ${rockCount}`);
}

// -- 7. omrežni viri (opcionalno, z --net) ------------------------------------
// Pet virov, ki jih oddaja resnično diha: ARSO (vremenska rubrika), RTV
// novice + šport, Wikidata (obzorje), Open-Meteo (živi vremenski segment).
// Pogodba P4 #28–#30 je testno-trdna in tu zrcaljena: mrtev vir = 'warn',
// NIKOLI 'fail'. Kakršna koli HTTP odpoved (tudi 4xx/5xx) pomeni "storitev
// odgovarja" -- sprejemo virov za reachability, ne za pravilnost.
export const FEED_PROBES = [
  { id: 'arso', name: 'ARSO vreme', url: 'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observation_si_latest.rss', fallback: 'rubrika poje pošteno vrstico (P4 #29)' },
  { id: 'rtv-novice', name: 'RTV novice', url: 'https://www.rtvslo.si/feeds/novice.xml', fallback: 'rubrika poje pošteno vrstico (P4 #30)' },
  { id: 'rtv-sport', name: 'RTV šport', url: 'https://www.rtvslo.si/sport/rss', fallback: 'rubrika poje pošteno vrstico (P4 #30)' },
  { id: 'wikidata', name: 'Wikidata obzorje', url: 'https://query.wikidata.org/sparql', fallback: 'korpus "na današnji dan v glasbi" ali poštena vrstica (P4 #28/#30)' },
  { id: 'open-meteo', name: 'Open-Meteo (živo vreme)', url: 'https://api.open-meteo.com/v1/forecast', fallback: 'živi segment reši pošteno vrstico -- režija NE pade (P4 #29)' },
];

export async function checkFeeds({ netProbe = false, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (!netProbe) {
    return result('feeds', 'omrežni viri', STATUS.SKIP,
      'preskočeno -- poženi z --net za dostopnost virov (program preživi tudi brez njih)');
  }
  const dead = [];
  const alive = [];
  for (const probe of FEED_PROBES) {
    try {
      await fetchImpl(probe.url, { signal: AbortSignal.timeout(timeoutMs) });
      alive.push(probe.name);
    } catch {
      dead.push(probe.name);
    }
  }
  if (dead.length === 0) {
    return result('feeds', 'omrežni viri', STATUS.OK,
      `odgovarjajo vsi: ${alive.join(', ')}`);
  }
  return result('feeds', 'omrežni viri', STATUS.WARN,
    `nedosegljivi: ${dead.join(', ')} -- ${dead.length === FEED_PROBES.length
      ? 'mrtev usmerjevalnik: program igla dalje s korpusi in poštenimi vrsticami (P4 #28–#30)'
      : dead.map((name) => `${name}: ${FEED_PROBES.find((p) => p.name === name)?.fallback ?? 'poštena vrstica'}`).join(' · ')}`);
}

// -- sestava -------------------------------------------------------------------
export function orderResults(results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return CHECK_ORDER.map(({ id, label }) => byId.get(id) ?? result(id, label, STATUS.SKIP, 'ni izvedeno'));
}

export function doctorExitCode(results) {
  return results.some((r) => r.status === STATUS.FAIL) ? 1 : 0;
}

export function doctorVerdict(results) {
  const fails = results.filter((r) => r.status === STATUS.FAIL);
  const warns = results.filter((r) => r.status === STATUS.WARN);
  const skips = results.filter((r) => r.status === STATUS.SKIP);
  const skipNote = skips.length > 0
    ? ` (${skips.length} ${slPlural(skips.length, 'preskočeno', 'preskočeni', 'preskočenih')})`
    : '';
  if (fails.length > 0) {
    return `NAPAKA: ${fails.length} ${slPlural(fails.length, 'preverjanje na tleh', 'preverjanji na tleh', 'preverjanj na tleh')} -- oddaja DANES ne bo stopila na parket brez popravila${skipNote}.`;
  }
  if (warns.length > 0) {
    return `oddaja preživi: 0 napak, ${warns.length} ${slPlural(warns.length, 'opozorilo', 'opozorili', 'opozoril')}${skipNote} -- program igra dalje tudi ob opozorilih.`;
  }
  if (skips.length > 0) {
    return `brez napak in opozoril, ampak je ${skips.length} ${slPlural(skips.length, 'preverjanje preskočeno', 'preverjanji preskočeni', 'preverjanj preskočenih')}${skips.some((r) => r.id === 'feeds') ? ' (omrežje: poženi z --net)' : ''} -- za celo sliko dopolni preskočeno.`;
  }
  return `vse zeleno: 0 napak, 0 opozoril -- parket je pripravljen.`;
}

export async function runDoctor({
  configOrError,
  netProbe = false,
  fetchImpl = fetch,
  nowMs = Date.now(),
} = {}) {
  const configOk = !(configOrError instanceof Error) && configOrError && typeof configOrError === 'object';
  const dataDir = configOk ? configOrError.dataDir : null;
  // POZOR: configOk je boolean -- dataDir vzamemo iz configOrError, ne iz
  // configOk (true.dataDir je undefined; ta bug je živ demo preskočil v
  // PRESK, ledger pa nikoli ne tekel).
  const airedPath = configOk && configOrError.dataDir
    ? path.join(configOrError.dataDir, 'history', 'aired.jsonl')
    : null;

  // Varovalka: če se katero koli preverjanje sesuje (bug ali nenavadna
  // izjema), ga zamenjamo z warn rezultatom -- doctor sam NIKOLI ne pade,
  // ker bi diagnostika, ki pade, pustila operaterja brez odgovora prav
  // takrat, ko jo potrebuje (isti skip-not-fail dogovor kot oddaja).
  const safe = (id, label, fn) => Promise.resolve().then(fn).catch((err) =>
    result(id, label, STATUS.WARN, `preverjanje se je sesulo: ${err?.message ?? err}`));

  const raw = [
    safe('config', 'konfiguracija', () => checkConfig(configOrError)),
    configOk
      ? safe('dataDir', 'podatkovna mapa', () => checkDataDir(dataDir))
      : result('dataDir', 'podatkovna mapa', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('tts', 'govor (TTS)', () => checkTts(configOrError, dataDir))
      : result('tts', 'govor (TTS)', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('library', 'glasbena knjižnica', () => checkLibrary(configOrError))
      : result('library', 'glasbena knjižnica', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk && airedPath
      ? safe('ledger', 'predvajalni ledger', () => checkLedger(airedPath, { nowMs }))
      : result('ledger', 'predvajalni ledger', STATUS.SKIP, 'preskočeno -- config ni berljiv ali dataDir ni nastavljen'),
    safe('corpus', 'korpusi (offline rezerva)', () => checkCorpora()),
    safe('feeds', 'omrežni viri', () => checkFeeds({ netProbe, fetchImpl })),
  ];

  // POMENBNO: najprej await, ŠELE nato orderResults -- orderResults bere
  // r.id, na Promise pa je id undefined (dimenzionalni test je ujel: vsi
  // rezultati so bili PRESK, ker je mapa gledala skozi obljube).
  const settled = await Promise.all(raw);
  const results = orderResults(settled);
  return {
    results,
    verdict: doctorVerdict(results),
    exitCode: doctorExitCode(results),
  };
}

// Ta modul ostane čist -- brez configa, brez konzole. Raba:
//   const { results, verdict, exitCode } = await runDoctor({ configOrError });
// CLI: src/cli/doctorCli.js (npm run doctor).
