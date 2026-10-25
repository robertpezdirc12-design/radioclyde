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
//
// Nadgradnja (SUB/WAVE 4-c, ukradeno brez AI): rezultat je Finding --
// opozorilo lahko nosi `hint` (kje poglej) in `fix` ({id, label} iz zaprtega
// nabora FIXES -- kaj stori), šest novih preverjanj pa pokrije stvari, ki
// so jim bile do zdaj nedoumljive: oddajnik (icecast), mešalna miza
// (liquidsoap telnet), predvajalne liste, shramba (arhiv/disk), gostitelj
// (CPU/spomin) in dnevnik napak. Izpeljava iz configa za te šest prinese
// CLI (spodaj runDoctor sprejema že sestavljene poti/nize), da pravilo
// "brez configa v tem modulu" ostane nedotaknjeno.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAiredFile } from './asrun.js';
import { QUIZ_QUESTIONS } from './quizFacts.js';
import { ON_THIS_DAY_MUSIC } from './onThisDayFacts.js';
import { GENERAL_ROCK_FACTS } from './rockFacts.js';

export const STATUS = { OK: 'ok', WARN: 'warn', FAIL: 'fail', SKIP: 'skip' };

// Stabilen vrstni red izpisa -- diagnostika brez vrstnega reda bi bila
// loterijski list. Oznake so slovenske, ID-ji ostanejo strojni. Prvih sedem
// je zamrznjenih od P4 #31; nadaljnjih šest (SUB/WAVE 4-c) pripenjamo ZA
// vire, v istem vrstnem redu, ki ga pinirajo testi: kdor tu preureja vrstni
// red, prelomi izpis cron/monitoringa, ki se je nanj navezal.
export const CHECK_ORDER = [
  { id: 'config', label: 'konfiguracija' },
  { id: 'dataDir', label: 'podatkovna mapa' },
  { id: 'tts', label: 'govor (TTS)' },
  { id: 'library', label: 'glasbena knjižnica' },
  { id: 'ledger', label: 'predvajalni ledger' },
  { id: 'corpus', label: 'korpusi (offline rezerva)' },
  { id: 'feeds', label: 'omrežni viri' },
  { id: 'icecast', label: 'icecast (oddajnik)' },
  { id: 'liquidsoap', label: 'liquidsoap (telnet)' },
  { id: 'm3u', label: 'predvajalne liste' },
  { id: 'storage', label: 'shramba (arhiv/disk)' },
  { id: 'host', label: 'gostitelj (CPU/spomin)' },
  { id: 'errors', label: 'dnevnik napak (24 h)' },
];

// ZAPRT nabor popravil (SUB/WAVE Finding/fix model): vsako opozorilo novih
// preverjanj nosi ID dejanskega operaterjevega ukrepa, ne proste besedilne
// izmišljotine. Nabor je zaprt, ker je vrednost ravno v tem, da ga lahko
// pripneš na gumb/štikalo (SUB/WAVE panel preslika id -> POST route); kdor
// doda preverjanje, doda sem tudi njegov popravek -- sicer bi operaterju
// rekli "pokvarjeno je", ne pa tudi "naredi to". Gostitelj (CPU/spomin)
// NIMA popravka: pritisk na gostitelja se ne reši z enim klikom in boljše
// je to priznati, kot izmisliti ukrep.
export const FIXES = {
  'check-icecast': { id: 'check-icecast', label: 'preveri/zaženi icecast (oddajnik)' },
  'restart-liquidsoap': { id: 'restart-liquidsoap', label: 'ponovno zaženi liquidsoap (mešalna miza)' },
  'regenerate-filler': { id: 'regenerate-filler', label: 'zgeneriraj liste (npm run update-now-playing / generate-filler-playlist)' },
  'prune-archives': { id: 'prune-archives', label: 'obreži arhiv (studio → Arhiv ali manjši archive.retentionDays)' },
  'free-disk': { id: 'free-disk', label: 'sprosti prostor na disku (dataDir)' },
  'inspect-logs': { id: 'inspect-logs', label: 'preglej dnevnik napak (dataDir/logs)' },
};

// Meje novih preverjanj (SUB/WAVE 4-c, pretvorjene v naše razmere):
// arhiv čez 20 GB je milo napihnjen (pri 128 kb/s je to ~15 dni neprekinjeno
// posnetega programa), prostor pod 2 GB pa je rob, kjer ledger, klipi in
// arhiv ne morejo več rasti. Obe meji sta OPOZORILI, ne napaki -- do zadnjega
// bajta zaseden disk še vedno pusti programu, da igra, samo zapisovalniki
// bodo molčali.
export const STORAGE_LIMITS = {
  archiveWarnBytes: 20 * 1024 ** 3,
  diskFreeWarnBytes: 2 * 1024 ** 3,
};
// Nad to mejo napak na dan "nekaj se vrti v zanki": ena napaka je življenje,
// dvajset pa vzorec (SUB/WAVE ima enak prag za svoj error-rate).
export const ERROR_WARN_COUNT = 20;

// Spodnje meje korpusov -- zrcalijo integritetne teste (onThisDay.test.mjs,
// trivia/quiz suite) na run-u: če nekdo v kodi skrči hrbtenico offline
// programa, diagnostika to pove operaterju PRED oddajo, ne po njej.
export const CORPUS_FLOORS = {
  quiz: 40,
  musicFacts: 40,
  musicDays: 40,
  rock: 20,
};

function result(id, label, status, detail, hint, fix) {
  // Finding model (SUB/WAVE 4-c): `hint` pove, KJE poglej, `fix` ({id, label}
  // iz FIXES) pa KAJ stori. Oba sta neobvezna in ju nosijo SAMO opozorila
  // novih preverjanj -- obstoječi rezultati (in njihovi bajtno pinirani
  // testi) ostanejo točno takšni, kot so bili: ni ključa, ni razlike v
  // izpisu. Ključa dodamo samo, ko ju res imamo -- undefined vrednosti bi
  // JSON seveda odnesel, a deepEqual bi jih zagledal.
  const finding = { id, label, status, detail };
  if (hint) finding.hint = hint;
  if (fix) finding.fix = fix;
  return finding;
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

// -- 8. icecast (oddajnik) ------------------------------------------------------
// SUB/WAVE 4-c, prvo od šestih novih preverjanj: oddajnik, ki ne odgovarja,
// pomeni TIŠINO pri poslušalcih, ne padec programa -- Liquidsoap mirno meče
// pakete v vtičnico in čaka, da se icecast (ali usmerjevalnik pred njim)
// dvigne. Zato opozorilo in ne napaka (P4 #28–#30: radio igra dalje).
// Merimo le DOSTOPNOST: vsak HTTP odgovor (tudi 4xx/5xx) pomeni "storitev
// živi" -- enaka filozofija kot pri virih (checkFeeds), ker status-json.xsl
// na napačno geslo še vedno odgovarja, prazna stran pa je odgovor strežnika,
// ne mrtva povezava.
// URL sestavi CLI z ISTO izpeljavo kot getListenerCount() v
// src/icecast/listeners.js -- doctor sam ne bere configa (pravilo z vrha
// datoteke), zato tu že dobi sestavljen niz. Ta sonda ni pod --net (kot
// viri): oddajnik je LAN storitev postaje same, ne internet, in njen padec
// je ravno tisto, kar operator želi izvedeti OBVEZNO, ne opcijsko.
export async function checkIcecast({ icecastUrl = null, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (!icecastUrl || typeof icecastUrl !== 'string') {
    return result('icecast', 'icecast (oddajnik)', STATUS.SKIP,
      'preskočeno -- config.icecast ni nastavljen (brez bloka ni sonde dostopnosti)');
  }
  try {
    await fetchImpl(icecastUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return result('icecast', 'icecast (oddajnik)', STATUS.OK,
      `oddajnik odgovarja na ${icecastUrl} -- merimo dostopnost, ne pravilnost`);
  } catch (err) {
    return result('icecast', 'icecast (oddajnik)', STATUS.WARN,
      `poslušalci trenutno ne slišijo ničesar -- icecast na ${icecastUrl} ne odgovarja (${err?.message ?? err}); program igra dalje`,
      'poglej, ali icecast sploh teče (npr. systemctl status icecast2) in ali sourceHost/vrata v config.json ustrezata strežniku',
      FIXES['check-icecast']);
  }
}

// -- 9. liquidsoap (telnet) -----------------------------------------------------
// Drugo SUB/WAVE preverjanje: telnet strežnik radio.liq (vezan samo na
// 127.0.0.1) je edino okno v notranjost mešalne mize. Ukaz 'uptime' je
// Liquidsoapov VGRADEN strežniški ukaz (ne radijski), zato odgovarja na vsaki
// različici, ki ima telnet sploh vklopljen. Ne-prazen odgovor, ki se ne
// začne s "ERROR:", pomeni, da miza živi; vse ostalo (zavržen ukaz, prazen
// odgovor, odklopljen socket) je opozorilo -- program takrat najbrž igra s
// praznimi viri ali bo padel na rezervo, a doctor ne more trditi, da JE
// padel, zato tudi tu ne lažemo.
// sendCommandImpl injicira CLI (pravi odjemalec je sendCommand v
// src/liquidsoap/telnetClient.js); tu ga NE smemo uvoziti, ker telnetClient
// potegne config na vrhu modula in bi zlomljen config.json sesel ravno to
// preverjanje namesto, da bi ga poročalo. telnetPort je samo signal
// "je telnet sploh nastavljen" -- povezavo odpre impl sam.
export async function checkLiquidsoap({ sendCommandImpl = null, telnetPort = null } = {}) {
  if (!telnetPort) {
    return result('liquidsoap', 'liquidsoap (telnet)', STATUS.SKIP,
      'preskočeno -- config.liquidsoap.telnetPort ni nastavljen (brez telnet strežnika ni sonde)');
  }
  if (typeof sendCommandImpl !== 'function') {
    return result('liquidsoap', 'liquidsoap (telnet)', STATUS.SKIP,
      'preskočeno -- telnet odjemalec ni podan (injekcija CLI-ja ali testov)');
  }
  let reply;
  try {
    reply = await sendCommandImpl('uptime');
  } catch (err) {
    return result('liquidsoap', 'liquidsoap (telnet)', STATUS.WARN,
      `mešalna miza ne odgovarja (telnet "uptime" na port ${telnetPort}: ${err?.message ?? err}) -- program pade na rezervne vire, doctor pa ne more trditi, da je padel`,
      `telnet 127.0.0.1 ${telnetPort} in ukaz "uptime" ti iz roke pove isto; ponovni zagon mizo dvigne sistemski nadzornik`,
      FIXES['restart-liquidsoap']);
  }
  const text = String(reply ?? '').trim();
  if (text === '' || /^ERROR:/.test(text)) {
    return result('liquidsoap', 'liquidsoap (telnet)', STATUS.WARN,
      `mešalna miza je odgovorila, ampak slabo ("uptime" -> ${text === '' ? 'prazen odgovor' : `"${text.slice(0, 60)}"`}) -- telnet strežnik živi, mešalnica pa najbrž ne`,
      'poglej dnevnik liquidsoapa -- strežnik je živ, odgovor pa pravi, da se miza sama ni postavila',
      FIXES['restart-liquidsoap']);
  }
  return result('liquidsoap', 'liquidsoap (telnet)', STATUS.OK,
    `mešalna miza živi (telnet "uptime": ${text.slice(0, 60)})`);
}

// -- 10. predvajalne liste -------------------------------------------------------
// Tretje: radio.liq diha s tremi .m3u seznami -- now_playing.m3u (terminirana
// oddaja, piše updateNowPlaying.js), filler.m3u (napolnilni seznam, piše
// generateFillerPlaylist.js) in imaging/emergency.m3u (nujni seznam, ZADNJA
// rezerva pred tišino). Če sta PRAZNA prva dva OBENOV, program pade na
// nujni seznam -- to je še vedno radio, a brez izbire, zato operater naj to
// ve PRED oddajo, ne po njej. Opozorilo, nikoli napaka: nujni seznam je
// ravno tu, da program ne umre, in prav ta odpornostna stopnja šteje kot
// "preživel", ne "mrtev".
// Štejemo ne-prazne, ne-komentar vrstice (m3u konvencija: '#' je komentar,
// prazne vrstice so okras). Obe poti prinese CLI (ista izpeljava kot
// config.paths.nowPlayingPath/fillerPath); branje gre SKOZ injiciran
// readFileImpl, da so testi deterministični -- brez injekcije je pošten
// preskok, ne tihih izmišljenih števk.
export async function checkM3u({ nowPlayingPath = null, fillerPath = null, readFileImpl = null } = {}) {
  if (!nowPlayingPath || !fillerPath) {
    return result('m3u', 'predvajalne liste', STATUS.SKIP,
      'preskočeno -- poti do .m3u seznamov nista podani (izpeljava iz dataDir živi v CLI-ju)');
  }
  if (typeof readFileImpl !== 'function') {
    return result('m3u', 'predvajalne liste', STATUS.SKIP,
      'preskočeno -- bralnik datotek ni podan (injekcija CLI-ja ali testov)');
  }
  const counts = await Promise.all([nowPlayingPath, fillerPath].map(async (file) => {
    let text;
    try { text = await readFileImpl(file, 'utf8'); } catch { return null; } // manjka -> null, ne 0
    return text.split(/\r?\n/).filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('#');
    }).length;
  }));
  const [nowCount, fillerCount] = counts; // Promise.all ohranja vrstni red seznamov
  const fmt = (n) => n === null ? 'manjka' : `${n} ${slPlural(n, 'vnos', 'vnosa', 'vnosov')}`;
  const detail = `now_playing.m3u: ${fmt(nowCount)} · filler.m3u: ${fmt(fillerCount)}`;
  if ((nowCount ?? 0) === 0 && (fillerCount ?? 0) === 0) {
    return result('m3u', 'predvajalne liste', STATUS.WARN,
      `${detail} -- program bi padel na nujni seznam (imaging/emergency.m3u)`,
      'zgeneriraj vsaj filler.m3u (npm run generate-filler-playlist); now_playing.m3u osveži npm run update-now-playing',
      FIXES['regenerate-filler']);
  }
  return result('m3u', 'predvajalne liste', STATUS.OK, detail);
}

// fs.statfs obstaja od Node 18.15 (naš engine je >= 24, a modul rad teče tudi
// kje drugje); kjer ni na voljo ali kjer klic pade (čudna platforma,
// odvezan disk), preprosto ni kaj meriti -- podatek o prostoru IZPUSTIMO iz
// detaila, ne da bi si izmislili številko.
function defaultStatfs() {
  return typeof fsp.statfs === 'function' ? fsp.statfs : null;
}

// Hoja po urnem arhivu: ISTA pravila kot studioArchivesApi.js (dan imenik
// /^\d{4}-\d{2}-\d{2}$/, urna datoteka /^\d{2}-00\.mp3$/), ker je to ISTA
// mapa -- drugačen števec bi o istih datotekah povedal drugo številko.
// Vrstni red je sortiran (readdir ni), da je izpis determinističen; datoteke,
// ki med hojo izginejo (Liquidsoap ravno preklaplja uro), ta ura pač ne
// prispeva k vsoti.
async function sumArchiveBytes(root) {
  let days = [];
  try {
    days = (await fsp.readdir(root)).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  } catch {
    return { bytes: 0, dayCount: 0, exists: false };
  }
  let bytes = 0;
  for (const day of days) {
    let files = [];
    try { files = await fsp.readdir(path.join(root, day)); } catch { continue; }
    for (const file of files.sort()) {
      if (!/^\d{2}-00\.mp3$/.test(file)) continue; // ni urna datoteka -- jo pustimo pri miru
      try { bytes += (await fsp.stat(path.join(root, day, file))).size; } catch { /* raztrgana med pisanjem */ }
    }
  }
  return { bytes, dayCount: days.length, exists: true };
}

// -- 11. shramba (arhiv/disk) ----------------------------------------------------
// Četrto, dva dela, oba poštena:
//   (i)  urni MP3 arhiv (blok zapiše streamsLiqWriter.js, briše studio
//        Arhiv): če preseže 20 GB, zadrževanje ni več milo napihnjeno, ampak
//        se mora resno obrezati. Arhiv izklopljen (config.archive.enabled
//        !== true -- ISTA stroga pretvorba kot streamsLiqWriter.archiveEnabled,
//        da tipkana vrednost ne prižige napačne sonde) -> del (i) je v
//        detailu pošteno preskočen, ne izmišljen.
//   (ii) prosto mesto na disku (fs.statfs na dataDir): pod 2 GB ledger, klipi
//        in arhiv ne morejo več rasti. Štejemo bavail (kar je na voljo
//        navadnemu procesu, enako kot df-jev "Available") -- rezervirani
//        bloki za root nam ne pomagajo.
// Če svarita OBENOGA arhiv in disk, popravi kaže na ARHIV: to je tisto, kar
// operater lahko zares zbriše, in praviloma je ravno vzrok.
export async function checkStorage({
  archiveRoot = null,
  archiveEnabled = false,
  dataDir = null,
  statfsImpl = defaultStatfs(),
} = {}) {
  const parts = [];
  let status = STATUS.OK;
  let hint = null;
  let fix = null;
  let archiveMeasured = false;

  if (archiveEnabled !== true) {
    parts.push('arhiv izklopljen (config.archive.enabled !== true), velikost arhiva ni preverjena');
  } else if (!archiveRoot || typeof archiveRoot !== 'string') {
    parts.push('arhiv je vklopljen, ampak koren arhiva ni podan');
  } else {
    archiveMeasured = true;
    const { bytes, dayCount, exists } = await sumArchiveBytes(archiveRoot);
    if (bytes > STORAGE_LIMITS.archiveWarnBytes) {
      status = STATUS.WARN;
      hint = 'v studiu pobriši starejše dneve (Arhiv) ali zmanjšaj archive.retentionDays v config.json';
      fix = FIXES['prune-archives'];
      parts.push(`arhiv presega 20 GB (${(bytes / 1024 ** 3).toFixed(1)} GB čez ${dayCount} ${slPlural(dayCount, 'dan', 'dnevi', 'dni')}), zadrževanje je milo napihnjeno`);
    } else if (!exists) {
      parts.push(`arhiv: mapa ${archiveRoot} še ne obstaja (nič še ni posnetega)`);
    } else {
      parts.push(`arhiv: ${(bytes / 1024 ** 3).toFixed(1)} GB čez ${dayCount} ${slPlural(dayCount, 'dan', 'dnevi', 'dni')}`);
    }
  }

  // (ii) prostor: samo če imamo impl IN pot; napad statfs pomeni izpust,
  // ne opozorilo (kjer statfs ni, tudi ni lažnega števila).
  let diskMeasured = false;
  if (typeof statfsImpl === 'function' && dataDir && typeof dataDir === 'string') {
    try {
      const st = await statfsImpl(dataDir);
      const freeBytes = Number(st?.bavail ?? 0) * Number(st?.bsize ?? 0);
      diskMeasured = true;
      if (freeBytes < STORAGE_LIMITS.diskFreeWarnBytes) {
        status = STATUS.WARN;
        if (!fix) { // arhiv že drži popravek -- isti vzrok, isti ukrep
          hint = 'pobriši star <dataDir>/cache, odslužene klipe ali arhiv -- ledger mora imeti kam rasti';
          fix = FIXES['free-disk'];
        }
        parts.push(`prosto na disku je le ${(freeBytes / 1024 ** 3).toFixed(1)} GB (meja 2 GB) -- ledger, klipi in arhiv ne morejo rasti`);
      } else {
        parts.push(`prosto na disku: ${(freeBytes / 1024 ** 3).toFixed(1)} GB`);
      }
    } catch {
      // statfs tu ni na voljo / je padel -- brez števila, brez laži
    }
  }

  if (!archiveMeasured && !diskMeasured) {
    return result('storage', 'shramba (arhiv/disk)', STATUS.SKIP,
      `preskočeno -- ${parts.join(' · ')}, prostora na disku pa prav tako ni bilo mogoče izmeriti`);
  }
  return result('storage', 'shramba (arhiv/disk)', status, parts.join(' · '), hint, fix);
}

// -- 12. gostitelj (CPU/spomin) ---------------------------------------------------
// Peto: /proc je Linuxov pogovor z jedrom in edini vir, ki ne laže --
// loadavg pravi, koliko dela čaka, meminfo pa koliko pomnilnika je še na
// voljo. Meji sta mili, ne panika: load1 nad 2×jedri pomeni, da produkcija
// (TTS sinteza, ffmpeg preludi) lahko ZAMUDI -- spomin pod 10 % pa začenja
// tiskati v swap. Oboje je opozorilo: program preživi, samo zvok bo
// kasnil. Gostitelj NIMA popravka v FIXES -- pritisk na škatlo se ne reši
// z enim klikom in boljše je to priznati, kot izmisliti ukrep.
// Branje gre SKOZ injiciran readFileImpl (testi ponaredijo /proc brez
// korena); brez injekcije je preskok, ker bi drugače pravi /proc med teki
// dal različne MemAvailable in izpis ne bi bil determinističen.
export async function checkHost({ readFileImpl = null, cpuCount = os.cpus().length } = {}) {
  if (typeof readFileImpl !== 'function') {
    return result('host', 'gostitelj (CPU/spomin)', STATUS.SKIP,
      'preskočeno -- bralnik /proc ni podan (CLI ga injicira, testi ponaredijo)');
  }
  let loadavgText;
  let meminfoText;
  try {
    [loadavgText, meminfoText] = await Promise.all([
      readFileImpl('/proc/loadavg', 'utf8'),
      readFileImpl('/proc/meminfo', 'utf8'),
    ]);
  } catch {
    // /proc na tej škatli ni berljiv (najbrž ni Linux) -- pošten preskok,
    // ker gostitelja brez /proc ne znamo izmeriti, ne da bi si izmislili.
    return result('host', 'gostitelj (CPU/spomin)', STATUS.SKIP,
      'preskočeno -- /proc/loadavg ali /proc/meminfo ni berljiv (gostitelj najbrž ni Linux)');
  }
  const load1 = Number.parseFloat(String(loadavgText).split(/\s+/)[0]);
  // meminfo: "MemTotal:       16384256 kB" (jedro piše kB, misli KiB)
  const mem = {};
  for (const line of String(meminfoText).split(/\r?\n/)) {
    const m = /^(\w+):\s+(\d+)\s*kB$/.exec(line);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  const memTotal = mem.MemTotal;
  const memAvail = mem.MemAvailable;
  const loadLimit = 2 * cpuCount;
  const problems = [];

  if (Number.isFinite(load1)) {
    if (load1 > loadLimit) {
      problems.push({
        detail: `gostitelj je pod pritiskom -- load1 ${load1.toFixed(2)}, meja ${loadLimit} (2 × ${cpuCount} ${slPlural(cpuCount, 'jedro', 'jedri', 'jeder')}), produkcija lahko zamudi`,
        hint: 'poglej top/htop -- kaj teče poleg postaje? TTS in ffmpeg nad mejo začenjata zamujati',
      });
    }
  }
  if (Number.isFinite(memTotal) && memTotal > 0 && Number.isFinite(memAvail)) {
    const ratio = memAvail / memTotal;
    if (ratio < 0.10) {
      problems.push({
        detail: `pomnilnika je na voljo le ${(ratio * 100).toFixed(1)} % (${(memAvail / 1024 ** 3).toFixed(1)} GB od ${(memTotal / 1024 ** 3).toFixed(1)} GB) -- sinteza in ffmpeg lahko odpovedeta`,
        hint: 'zapri odvečne procese na gostitelju -- pod 10 % pomnilnika se stvari začnejo izgubljati v swap',
      });
    }
  }
  if (problems.length > 0) {
    return result('host', 'gostitelj (CPU/spomin)', STATUS.WARN,
      problems.map((p) => p.detail).join(' · '), problems.map((p) => p.hint).join(' · '));
  }
  // Oba dela v redu -> izpis s številkami (ali s pošteno opombo, kjer /proc
  // ni povedal nič uporabnega -- takrat ne pretendiramo).
  const loadPart = Number.isFinite(load1)
    ? `obremenitev: ${load1.toFixed(2)} (meja ${loadLimit} = 2 × ${cpuCount} ${slPlural(cpuCount, 'jedro', 'jedri', 'jeder')})`
    : 'obremenitev: /proc/loadavg nerazumljiv';
  const memPart = Number.isFinite(memTotal) && Number.isFinite(memAvail) && memTotal > 0
    ? `pomnilnik: ${((memAvail / memTotal) * 100).toFixed(1)} % na voljo (${(memAvail / 1024 ** 3).toFixed(1)} GB od ${(memTotal / 1024 ** 3).toFixed(1)} GB)`
    : 'pomnilnik: MemTotal/MemAvailable ni v /proc/meminfo';
  return result('host', 'gostitelj (CPU/spomin)', STATUS.OK, `${loadPart} · ${memPart}`);
}

// -- 13. dnevnik napak (24 h) -----------------------------------------------------
// Šesto: logger.js vsako vrstico začne z '[ISO]' časovnim žigom
// (toLocalISOString -- lokalni ISO z realnim odmikom, še vedno parseable),
// rotacija pa starejšo kopijo preimenuje v <ime>.log.1. Štejemo vrstice z
// 'ERROR' (dobesedno, velike črke -- logger jih tako piše) iz SAMO
// AKTIVNIH .log datotek: rotirana .log.1 je že zgodovina in bi eno napako
// štela dvakrat. Vrstice z nerazumljivim časovnim žigom NE štejejo
// (konzervativno: raje spregledam napako, kot si jo izmislim); vrstica z
// 'prihodnjim' časom pa ŠTEJE -- ura, ki laže, je sama po sebi napaka in
// zato teh vrstic ne brišemo iz štetja. Nad mejo je opozorilo "nekaj se
// vrti v zanki": 1 napaka je življenje, 20+ na dan je vzorec.
export async function checkErrors({ logsDir = null, nowMs = Date.now(), readFileImpl = null } = {}) {
  if (!logsDir || typeof logsDir !== 'string') {
    return result('errors', 'dnevnik napak (24 h)', STATUS.SKIP,
      'preskočeno -- pot do mape z logi ni podana (izpeljava iz dataDir živi v CLI-ju)');
  }
  if (typeof readFileImpl !== 'function') {
    return result('errors', 'dnevnik napak (24 h)', STATUS.SKIP,
      'preskočeno -- bralnik datotek ni podan (injekcija CLI-ja ali testov)');
  }
  let names = [];
  try {
    names = (await fsp.readdir(logsDir)).filter((name) => name.endsWith('.log')).sort();
  } catch {
    return result('errors', 'dnevnik napak (24 h)', STATUS.SKIP,
      `${logsDir} ne obstaja -- logi se ustvarijo ob prvem zagonu, do takrat ni kaj pregledovati`);
  }
  if (names.length === 0) {
    return result('errors', 'dnevnik napak (24 h)', STATUS.SKIP,
      `v ${logsDir} ni aktivnih .log datotek (samo rotirane .log.1?) -- ni kaj pregledovati`);
  }
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  let count = 0;
  for (const name of names) {
    let text;
    try { text = await readFileImpl(path.join(logsDir, name), 'utf8'); } catch { continue; } // datoteka je ravno rotirala
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.includes('ERROR')) continue;
      const m = /^\[([^\]]+)\]/.exec(line);
      if (!m) continue; // brez časovnega žiga -- ne moremo vedeti, ali je sveža
      const ts = Date.parse(m[1]);
      if (!Number.isFinite(ts)) continue; // nerazumljiv čas -- konservativno ne šteje
      if (ts >= cutoff) count += 1;
    }
  }
  const plural = slPlural(count, 'napaka', 'napaki', 'napak');
  if (count > ERROR_WARN_COUNT) {
    return result('errors', 'dnevnik napak (24 h)', STATUS.WARN,
      `${count} ${plural} v 24 h -- nekaj se vrti v zanki`,
      `preglej ${logsDir}/*.log za vzorec -- isti prostor vsakič pomeni zanko v kodi, ne smolo`,
      FIXES['inspect-logs']);
  }
  return result('errors', 'dnevnik napak (24 h)', STATUS.OK,
    `${count} ${plural} v 24 h čez ${names.length} ${slPlural(names.length, 'dnevnik', 'dnevnika', 'dnevnikov')} -- pod mejo ${ERROR_WARN_COUNT}`);
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
  // Injekcijske šive šestih novih preverjanj (SUB/WAVE 4-c) prinesejo CLI oz.
  // testi SAMI: doctor jim NE da privzetkov, ki bi vlekli config ali /proc.
  // telnetClient potegne config na vrhu modula (zlomljen config.json bi sesel
  // kar preverjanje), bralnik /proc pa bi brez injekcije med teki vrnil
  // različne MemAvailable in izpis ne bi bil determinističen. Brez šive je
  // pošten preskok -- nikoli tiha izmišljena števila niti lažna opozorila.
  sendCommandImpl = null,
  readFileImpl = null,
  // statfs je prav tako šiv, ne privzete vrata: pravi fs.statfs bi v testih
  // peskovnika vrnil RESNIČNE bajte prostora, ki se med dvema tekoma lahko
  // razlikujejo (disk med tem zraste) -- determinizem bi bil loterija. CLI
  // prinese pravi fs.promises.statfs, testi fiko ali null (izpust).
  statfsImpl = null,
  // Izpeljave iz configa prav tako prinese CLI (glej komentar z vrha
  // datoteke): doctor ne sme brati configa, zato dobi POTI/NIZE že
  // sestavljene. Z zlomljenim configom so vsi null in spodnja vrata
  // ('preskočeno -- config ni berljiv') zadnjo besedo.
  nowPlayingPath = null,
  fillerPath = null,
  archiveRoot = null,
  logsDir = null,
  icecastUrl = null,
  telnetPort = null,
  archiveEnabled = false,
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
    // Šest novih (SUB/WAVE 4-c) -- vsako pod istim configOk pokrovom kot
    // ostale: zlomljen config.json pomeni "ne vem", ne "vse ušerno".
    configOk
      ? safe('icecast', 'icecast (oddajnik)', () => checkIcecast({ icecastUrl, fetchImpl }))
      : result('icecast', 'icecast (oddajnik)', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('liquidsoap', 'liquidsoap (telnet)', () => checkLiquidsoap({ sendCommandImpl, telnetPort }))
      : result('liquidsoap', 'liquidsoap (telnet)', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('m3u', 'predvajalne liste', () => checkM3u({ nowPlayingPath, fillerPath, readFileImpl }))
      : result('m3u', 'predvajalne liste', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('storage', 'shramba (arhiv/disk)', () => checkStorage({ archiveRoot, archiveEnabled, dataDir, statfsImpl }))
      : result('storage', 'shramba (arhiv/disk)', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('host', 'gostitelj (CPU/spomin)', () => checkHost({ readFileImpl }))
      : result('host', 'gostitelj (CPU/spomin)', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
    configOk
      ? safe('errors', 'dnevnik napak (24 h)', () => checkErrors({ logsDir, nowMs, readFileImpl }))
      : result('errors', 'dnevnik napak (24 h)', STATUS.SKIP, 'preskočeno -- config ni berljiv'),
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
// CLI: src/cli/doctorCli.js (npm run doctor) -- ta izpelje vse configne
//   poti/nize (nowPlayingPath, fillerPath, archiveRoot, logsDir, icecastUrl,
//   telnetPort, archiveEnabled), injicira telnetClient.sendCommand in
//   fs.promises.readFile ter pusti fetch/nowMs na privzetkah tu.
//   Opozorila novih preverjanj nosijo hint/fix (Finding model, FIXES zgoraj).
