// Tests for P4 #31 predvečerna diagnostika (src/auto/doctor.js):
//   A. config check: Error -> fail, disabled/missing block -> warn, healthy -> ok,
//   B. dataDir: ok / missing -> warn / path-is-a-file -> fail (root-proof),
//   C. tts: clips counted, empty clips -> warn, piper key file present/absent,
//      edge honest "checked at airtime", unknown mode -> warn,
//   D. library: local counts with slPlural, local-zero -> FAIL vs auto-zero
//      -> WARN (Plex is primary), plex no counting, missing dirs -> warn,
//   E. ledger: reuses readAiredFile -- corrupt counted, stale >7d warns,
//      slPlural 1 vnos / 2 vnosa / 5 vnosov,
//   F. corpora floors == test-pinned integrity; orderResults stability;
//      exit code + verdict mapping,
//   G. runDoctor end-to-end on a sandbox: healthy -> no fails, determinism
//      (two runs byte-identical), broken config -> fail + skips + corpus OK,
//   H. feeds: dead probe -> WARN, NIKOLI fail (the P4 #28-#30 contract, pinned);
//      any HTTP answer (even 4xx) counts as reachable; skip without --net.
// SUB/WAVE 4-c nadgradnja (Finding model + šest novih preverjanj):
//   I. FIXES zaprt nabor {id,label} + CHECK_ORDER 20 vnosov (zamrznjeno),
//   J. icecast: vsak HTTP odgovor -> ok, mrtva povezava -> warn + fix,
//   K. liquidsoap: živ "uptime" -> ok z izrezkom, napaka/prazno/ERROR -> warn,
//   L. m3u: štetje ne-komentar vrstic, obe prazni -> warn (nujni seznam),
//   M. storage: arhiv 20 GB meja (NAD, ne NA), disk 2 GB meja, statfs izpust,
//   N. host: load1/mem meje, /proc neberljiv -> preskok,
//   O. errors: sveže/stare/nečasovne/.log.1 vrstice, 21+ -> warn,
//   P. runDoctor sestava: šest preskokov ob zlomljenem configu, polna
//      injekcija -> 20 rezultatov, hint/fix SAMO na opozorilih, determinizem.
// Val 26 (doktor dohiti postajo) -- pet novih preverjanj + PRAVI šivi:
//   Q. station: zdrav urnik s prepiši, manjkajoč -> warn, pokvarjen JSON ->
//      FAIL, ne-seznam -> FAIL (loadSchedule vrže), neznan dan/slabi datumi/
//      nevzdržne pojavitve -> warn z imeni,
//   R. imaging: štetje kipov IN etrnih m3u, prazna plast -> warn, kipi z
//      praznim m3u -> "tik ne teče", promosi OPT-IN,
//   S. beds: izklopljene -> OK, F2 gumbi (padli na privzeto), pometanje
//      generiranih postelj (operaterjeve NIKOLI preštete), knjiga sprožitev,
//      produceLead coerces / retention ne (asimetrija izvira, pripeta),
//   T. wheel: izklopljen -> ok, padli koraki/dayparti -> warn, rezervirano
//      ime, koraki v nedoločene bazene,
//   U. backup: brez dir -> skip, sveža/stara kopija, datirane mape,
//      retentionDays mirror resolveRetentionDays,
//   V. PRAVI šivi: setupTestConfig + dinamični uvoz -- parseWheelTime pozna
//      "24:00" senčilo, URNIK je odpuščujoč tam kjer je kolo strogo,
//      GENERATED_BED_RE ne ujame operaterjevih imen,
//   W. runDoctor sestava: brez novih šivov -> pošteni preskoki + beds OK,
//      zlomljen config -> preskoki z istim vzorcem, polna postaja -> 20
//      rezultatov + determinizem.
// Val 33 (dnevni profili govora):
//   X. tempo: fail-open resolucija daypartProsody (neznana imena blokov,
//      šmetane oblike, neznani gumbi) dobi glas PRED oddajo; timeBlocks je
//      injektiran šiv (pravi bralnik pride iz CLI-ja, kot pri Val 26).
// No test touches the network -- fetchImpl is always stubbed; /proc, statfs
// in telnet so injicirane fike; datoteke so pravi tmp peskovniki.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  STATUS,
  CHECK_ORDER,
  CORPUS_FLOORS,
  FIXES,
  STORAGE_LIMITS,
  checkConfig,
  checkDataDir,
  checkTts,
  checkLibrary,
  checkLedger,
  checkCorpora,
  checkFeeds,
  checkIcecast,
  checkLiquidsoap,
  checkM3u,
  checkStorage,
  checkHost,
  checkErrors,
  checkStation,
  checkImaging,
  checkBeds,
  checkWheel,
  checkBackup,
  checkPrehodi,
  checkVoiceDaypart,
  orderResults,
  doctorExitCode,
  doctorVerdict,
  runDoctor,
  slPlural,
} from '../src/auto/doctor.js';
import { setupTestConfig } from './fixtures.mjs';

// Repo root -- za preverjanje, da poti v cron vzorcu kažejo na obstoječe
// datoteke (bramba proti preimenovanju CLI-ja brez posodobitve vzorca).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
}

const healthyConfig = (dir) => ({
  dataDir: path.join(dir, 'data'),
  stationName: 'Test Stanica',
  autoRadio: {
    enabled: true,
    music: { source: 'local', localDirs: [path.join(dir, 'glasba')], audioExtensions: ['.mp3', '.flac'] },
    voice: { mode: 'clips', clipsDir: 'voice-clips', edgeFallback: 'none' },
  },
});

// Val 26: PRAVI šivi produkcijske slovnice. setupTestConfig napiše scratch
// config.json (obstoječega hrani in obnovi ob izhodu), ŠELE NATO dinamično
// uvozimo module, ki potegnejo config na vrhu (clockwheel/formatClock/
// scheduleUtil). Memoizirano -- ena namestitev na datoteko; testi tako pripnejo
// DOKAZANO prave bralce, ne zrcalna dvojnika slovnic (dva HH:MM parserja sta
// valu 25 izrecno prepovedana, doctor naj jih ne goji nazaj skozi teste).
let realSeamsCache = null;
async function realSeams() {
  if (realSeamsCache) return realSeamsCache;
  setupTestConfig('doctor-val26');
  const { parseWheelTime, clockwheelConfig } = await import('../src/scheduler/clockwheel.js');
  const { GENERATED_BED_RE } = await import('../src/scheduler/formatClock.js');
  const { timeToMinutes } = await import('../src/scheduler/scheduleUtil.js');
  realSeamsCache = { parseWheelTime, clockwheelConfig, GENERATED_BED_RE, timeToMinutes };
  return realSeamsCache;
}

describe('P4 #31 doctor -- config', () => {
  test('healthy config -> ok with station name', () => {
    const r = checkConfig({ stationName: 'Radio Markec', autoRadio: { voice: { mode: 'edge' } } });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /Radio Markec/);
    assert.ok(!r.detail.includes('zastarelo'), 'no legacy note on a clean config');
  });

  test('import Error -> fail carrying the message', () => {
    const r = checkConfig(new Error('config.json not found'));
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.detail, /config\.json not found/);
  });

  // Val 28 ("samo skripte brez AI modelov"): the AI layer is gone, so a
  // config that still carries its keys (lmStudio, chatterbox,
  // autoRadio.enabled -- in EITHER value) is not a mode choice anymore,
  // it is dead weight the doctor honestly names as deletable. The station
  // itself runs the single deterministic pipeline either way.
  test('legacy AI keys (lmStudio/chatterbox/enabled) -> still ok, with an honest stale note', () => {
    const r = checkConfig({
      stationName: 'Radio Markec',
      lmStudio: { url: 'http://x:1234', model: 'qwen' },
      chatterbox: { url: 'http://x:8004' },
      autoRadio: { enabled: false, voice: { mode: 'edge' } },
    });
    assert.equal(r.status, STATUS.OK, 'the flag is inert -- the pipeline runs regardless');
    assert.match(r.detail, /zastarelo/);
    assert.match(r.detail, /lmStudio/);
    assert.match(r.detail, /chatterbox/);
    assert.match(r.detail, /autoRadio\.enabled/);
  });

  test('missing autoRadio block -> warn (defaults apply, main channel still works)', () => {
    assert.equal(checkConfig({ stationName: 'x' }).status, STATUS.WARN);
    assert.equal(checkConfig(null).status, STATUS.FAIL);
  });
});

describe('P4 #31 doctor -- dataDir', () => {
  test('existing writable dir -> ok', () => {
    const dir = tmpDir();
    const r = checkDataDir(dir);
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /zapisljiva/);
  });

  test('missing dir -> warn (modules create it lazily), NOT fail', () => {
    const r = checkDataDir(path.join(tmpDir(), 'ne-obstaja'));
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /še ne obstaja/);
  });

  test('dataDir pointing at a FILE -> fail (root-proof unwritable case)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'datoteka-ne-mapa');
    fs.writeFileSync(file, 'x');
    const r = checkDataDir(file);
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.detail, /ni mapa/);
  });
});

describe('P4 #31 doctor -- tts', () => {
  test('clips mode counts wav files -> ok', async () => {
    const dir = tmpDir();
    const clips = path.join(dir, 'voice-clips');
    fs.mkdirSync(clips);
    fs.writeFileSync(path.join(clips, 'open.wav'), 'x');
    fs.writeFileSync(path.join(clips, 'close.wav'), 'x');
    const cfg = { autoRadio: { voice: { mode: 'clips', clipsDir: 'voice-clips' } } };
    const r = await checkTts(cfg, dir);
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /klipi: 2 datoteki v/);
  });

  test('clips mode with empty/missing dir -> warn (speech skips, music plays on)', async () => {
    const dir = tmpDir();
    const cfg = { autoRadio: { voice: { mode: 'clips', clipsDir: 'voice-clips' } } };
    const r = await checkTts(cfg, dir);
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /prazna ali manjka/);
  });

  test('piper key-style voice present on disk -> ok; absent -> warn with honest note', async () => {
    const dir = tmpDir();
    const cfg = { dataDir: path.join(dir, 'data'), autoRadio: { voice: { mode: 'piper', defaultPiperVoice: 'sl_SI-artur-medium' } } };
    const absent = await checkTts(cfg, cfg.dataDir);
    assert.equal(absent.status, STATUS.WARN);
    assert.match(absent.detail, /naloži jo ob prvi sintezi/);
    const piperDir = path.join(dir, 'data', 'piper');
    fs.mkdirSync(piperDir, { recursive: true });
    fs.writeFileSync(path.join(piperDir, 'sl_SI-artur-medium.onnx'), 'x');
    const present = await checkTts(cfg, cfg.dataDir);
    assert.equal(present.status, STATUS.OK);
    assert.match(present.detail, /je na disku/);
  });

  test('edge mode -> ok with honest "checked at airtime" note', async () => {
    const cfg = { autoRadio: { voice: { mode: 'edge', edgeFallback: 'espeak' } } };
    const r = await checkTts(cfg, tmpDir());
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /v režiji/);
  });

  test('unknown mode -> warn', async () => {
    const r = await checkTts({ autoRadio: { voice: { mode: 'chatterbox' } } }, tmpDir());
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /neznani način/);
  });
});

describe('P4 #31 doctor -- library', () => {
  test('local source counts audio files with slPlural', async () => {
    const dir = tmpDir();
    const lib = path.join(dir, 'glasba');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(lib, 'b.flac'), 'x');
    const r = await checkLibrary({ autoRadio: { music: { source: 'local', localDirs: [lib], audioExtensions: ['.mp3', '.flac'] } } });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /2 skladbi v 1\/1 mapi/);
  });

  test('local-zero -> FAIL, auto-zero -> WARN (Plex is primary)', async () => {
    const dir = tmpDir();
    const lib = path.join(dir, 'prazna');
    fs.mkdirSync(lib);
    const local = await checkLibrary({ autoRadio: { music: { source: 'local', localDirs: [lib], audioExtensions: ['.mp3'] } } });
    assert.equal(local.status, STATUS.FAIL);
    const auto = await checkLibrary({ autoRadio: { music: { source: 'auto', localDirs: [lib], audioExtensions: ['.mp3'] } } });
    assert.equal(auto.status, STATUS.WARN);
  });

  test('plex source -> ok without counting, missing localDirs -> warn', async () => {
    const plex = await checkLibrary({ autoRadio: { music: { source: 'plex', localDirs: [] } } });
    assert.equal(plex.status, STATUS.OK);
    const autoEmpty = await checkLibrary({ autoRadio: { music: { source: 'auto', localDirs: [] } } });
    assert.equal(autoEmpty.status, STATUS.WARN);
    const localEmpty = await checkLibrary({ autoRadio: { music: { source: 'local', localDirs: [] } } });
    assert.equal(localEmpty.status, STATUS.FAIL);
  });

  test('one of two dirs missing -> warn with existing count', async () => {
    const dir = tmpDir();
    const lib = path.join(dir, 'obstaja');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, 'a.mp3'), 'x');
    const r = await checkLibrary({ autoRadio: { music: { source: 'local', localDirs: [lib, path.join(dir, 'manjka')], audioExtensions: ['.mp3'] } } });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /1\/2 mapah/);
  });
});

describe('P4 #31 doctor -- ledger (reuse of asrun readAiredFile)', () => {
  test('1 vnos / 2 vnosa / 5 vnosov -- slPlural in detail', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'aired.jsonl');
    const entry = { ratingKey: 'rk', artist: 'A', title: 'T', album: 'L', durationMs: 180000, showId: 'jutro', playedAt: '2026-10-25T08:00:00+02:00' };
    fs.writeFileSync(file, JSON.stringify(entry) + '\n');
    assert.match(checkLedger(file).detail, /^1 vnos,/);
    fs.writeFileSync(file, Array.from({ length: 2 }, () => JSON.stringify(entry)).join('\n') + '\n');
    assert.match(checkLedger(file).detail, /^2 vnosa,/);
    fs.writeFileSync(file, Array.from({ length: 5 }, () => JSON.stringify(entry)).join('\n') + '\n');
    const r = checkLedger(file);
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /^5 vnosov,/);
  });

  test('corrupt lines counted as warning; missing file -> warn (new station)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'aired.jsonl');
    fs.writeFileSync(file, '{"broken":\n' + '{"ratingKey":"rk","artist":"A","title":"T","album":"L","durationMs":1,"showId":"j","playedAt":"2026-10-25T08:00:00+02:00"}\n');
    const r = checkLedger(file);
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /1 pokvarjena vrstica/);
    const missing = checkLedger(path.join(dir, 'ne-obstaja.jsonl'));
    assert.equal(missing.status, STATUS.WARN);
    assert.match(missing.detail, /še ne obstaja/);
  });

  test('ledger silent for 7+ days -> warn (scrobbleTrack maybe not writing)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'aired.jsonl');
    const entry = { ratingKey: 'rk', artist: 'A', title: 'T', album: 'L', durationMs: 1, showId: 'j', playedAt: '2026-10-01T08:00:00+02:00' };
    fs.writeFileSync(file, JSON.stringify(entry) + '\n');
    const nowMs = Date.parse('2026-10-25T12:00:00+02:00');
    const r = checkLedger(file, { nowMs });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /pred 2[34] dnevi/);
  });
});

describe('P4 #31 doctor -- corpora, ordering, exit, verdict', () => {
  test('real corpora pass floors (mirrors integrity tests)', () => {
    const r = checkCorpora();
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /kviz 40 vprašanj/);
    assert.match(r.detail, /glasba \d+ dejstev prek \d+ dni/);
  });

  test('tampered floors -> fail naming the shortfall', () => {
    const r = checkCorpora({ quizCount: 10, musicCount: 3, rockCount: 1 });
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.detail, /kviz 10\/40/);
    assert.match(r.detail, /zanimivosti 1\/20/);
  });

  test('orderResults is CHECK_ORDER-stable and fills unknown ids as skip', () => {
    const results = orderResults([
      { id: 'feeds', label: 'omrežni viri', status: 'ok', detail: 'x' },
      { id: 'neznano', label: 'y', status: 'ok', detail: 'y' },
    ]);
    assert.deepEqual(results.map((r) => r.id), CHECK_ORDER.map((c) => c.id));
    assert.equal(results.find((r) => r.id === 'feeds').status, 'ok');
    for (const r of results) {
      if (r.id !== 'feeds') assert.equal(r.status, 'skip');
    }
  });

  test('exit code: any fail -> 1, otherwise 0', () => {
    assert.equal(doctorExitCode([{ status: 'fail' }]), 1);
    assert.equal(doctorExitCode([{ status: 'ok' }, { status: 'warn' }, { status: 'skip' }]), 0);
  });

  test('verdict messages name the counts and skip the lying "all green"', () => {
    assert.match(doctorVerdict([{ status: 'fail' }]), /^NAPAKA: 1 preverjanje na tleh/);
    assert.match(doctorVerdict([{ status: 'warn' }, { status: 'warn' }]), /0 napak, 2 opozorili/);
    assert.match(doctorVerdict([{ status: 'skip' }]), /preskočen/);
    assert.match(doctorVerdict([{ status: 'ok' }]), /vse zeleno/);
  });

  test('slPlural covers 1 / 2-4 / many incl. 0', () => {
    assert.equal(slPlural(1, 'vnos', 'vnosa', 'vnosov'), 'vnos');
    assert.equal(slPlural(2, 'vnos', 'vnosa', 'vnosov'), 'vnosa');
    assert.equal(slPlural(4, 'vnos', 'vnosa', 'vnosov'), 'vnosa');
    assert.equal(slPlural(5, 'vnos', 'vnosa', 'vnosov'), 'vnosov');
    assert.equal(slPlural(0, 'vnos', 'vnosa', 'vnosov'), 'vnosov');
  });
});

describe('P4 #31 doctor -- runDoctor end-to-end (sandbox, no network)', () => {
  test('healthy sandbox -> no fails, corpus ok, feeds skipped, deterministic', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.autoRadio.music.localDirs[0], { recursive: true });
    fs.writeFileSync(path.join(cfg.autoRadio.music.localDirs[0], 'a.mp3'), 'x');
    const historyDir = path.join(cfg.dataDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    const entry = { ratingKey: 'rk', artist: 'A', title: 'T', album: 'L', durationMs: 1, showId: 'j', playedAt: '2026-10-25T08:00:00+02:00' };
    fs.writeFileSync(path.join(historyDir, 'aired.jsonl'), JSON.stringify(entry) + '\n');

    const nowMs = Date.parse('2026-10-25T12:00:00+02:00');
    const run1 = await runDoctor({ configOrError: cfg, netProbe: false, nowMs });
    assert.equal(run1.exitCode, 0);
    assert.equal(run1.results.find((r) => r.id === 'config').status, 'ok');
    assert.equal(run1.results.find((r) => r.id === 'dataDir').status, 'ok');
    assert.equal(run1.results.find((r) => r.id === 'ledger').status, 'ok');
    assert.equal(run1.results.find((r) => r.id === 'corpus').status, 'ok');
    assert.equal(run1.results.find((r) => r.id === 'feeds').status, 'skip');
    assert.match(run1.verdict, /oddaja preživi|vse zeleno|brez napak/);

    const run2 = await runDoctor({ configOrError: cfg, netProbe: false, nowMs });
    assert.deepEqual(JSON.parse(JSON.stringify(run2.results)), JSON.parse(JSON.stringify(run1.results)));
  });

  test('broken config -> config fail, dependent checks skip (tudi pet Val 26), corpus STILL ok, exit 1', async () => {
    const report = await runDoctor({ configOrError: new Error('config.json not found'), netProbe: false });
    assert.equal(report.exitCode, 1);
    assert.equal(report.results.find((r) => r.id === 'config').status, 'fail');
    for (const id of ['dataDir', 'tts', 'library', 'ledger', 'station', 'imaging', 'beds', 'wheel', 'backup']) {
      assert.equal(report.results.find((r) => r.id === id).status, 'skip', id);
      assert.match(report.results.find((r) => r.id === id).detail, /config ni berljiv/);
    }
    assert.equal(report.results.find((r) => r.id === 'corpus').status, 'ok');
    assert.match(report.verdict, /NAPAKA/);
  });
});

describe('P4 #31 doctor -- feeds probes (the P4 #28-#30 honesty contract)', () => {
  test('dead probe -> WARN, NEVER fail; all HTTP answers count as reachable', async () => {
    const dead = await checkFeeds({ netProbe: true, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(dead.status, STATUS.WARN);
    assert.match(dead.detail, /mrtev usmerjevalnik/);

    const http400 = await checkFeeds({ netProbe: true, fetchImpl: async () => ({ status: 400 }) });
    assert.equal(http400.status, STATUS.OK);
    assert.match(http400.detail, /odgovarjajo vsi/);
  });

  test('partial outage names the dead source and its honest fallback', async () => {
    const calls = [];
    const partial = await checkFeeds({
      netProbe: true,
      fetchImpl: async (url) => {
        calls.push(url);
        if (String(url).includes('arso')) throw new Error('timeout');
        return { status: 200 };
      },
    });
    assert.equal(partial.status, STATUS.WARN);
    assert.match(partial.detail, /ARSO vreme/);
    assert.match(partial.detail, /pošteno vrstico/);
    assert.equal(calls.length, 5);
  });

  test('without --net -> skip (never a network call)', async () => {
    let called = 0;
    const r = await checkFeeds({ netProbe: false, fetchImpl: async () => { called += 1; return { status: 200 }; } });
    assert.equal(r.status, STATUS.SKIP);
    assert.equal(called, 0);
  });

  test('runDoctor with netProbe=true and dead router -> still exit 0 (warns only)', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.autoRadio.music.localDirs[0], { recursive: true });
    fs.writeFileSync(path.join(cfg.autoRadio.music.localDirs[0], 'a.mp3'), 'x');
    const report = await runDoctor({
      configOrError: cfg,
      netProbe: true,
      fetchImpl: async () => { throw new Error('dead'); },
    });
    assert.equal(report.exitCode, 0);
    assert.equal(report.results.find((r) => r.id === 'feeds').status, 'warn');
  });
});

// ---- SUB/WAVE 4-c: Finding model (hint + fix) in šest novih preverjanj ----
// Skupni fiki: brez omrežja, brez /proc, brez telneta, brez statfs -- vse,
// kar bi lahko seglo po pravi škatli, je injicirano, da so izpisi
// deterministični in da test teče tudi na mizi brez interneta.
const GB = 1024 ** 3;

// statfs fake, ki za vsako pot pove isti prostor (bavail*bsize == freeBytes)
const fakeStatfs = (freeBytes) => async () => ({ bsize: 1, blocks: freeBytes * 2, bfree: freeBytes, bavail: freeBytes });

// /proc fake: loadavg z load1 ter meminfo z MemTotal/MemAvailable v kB
const fakeProc = ({ load1, memTotalKb, memAvailKb }) => async (file) => {
  if (file === '/proc/loadavg') return `${load1} 0.10 0.05 1/100 12345\n`;
  if (file === '/proc/meminfo') {
    return `MemTotal:       ${memTotalKb} kB\nMemFree:        ${Math.floor(memTotalKb / 2)} kB\nMemAvailable:   ${memAvailKb} kB\n`;
  }
  throw new Error(`ENOENT: ${file}`);
};

describe('SUB/WAVE 4-c doctor -- Finding model (FIXES, CHECK_ORDER)', () => {
  test('FIXES je ZAPRT nabor {id, label} z nepraznimi nizi in zamrznjenimi id-ji (6 SUB/WAVE + 6 Val 26 + 1 Val 33)', () => {
    assert.deepEqual(Object.keys(FIXES), [
      'check-icecast', 'restart-liquidsoap', 'regenerate-filler', 'prune-archives', 'free-disk', 'inspect-logs',
      'fix-station-json', 'load-imaging-clips', 'fix-format-clock', 'fix-clockwheel', 'check-scheduler', 'fix-backup-config',
      'fix-daypart-prosody',
    ]);
    for (const [id, fix] of Object.entries(FIXES)) {
      assert.equal(fix.id, id, 'id se mora ujemati s ključem');
      assert.equal(typeof fix.label, 'string');
      assert.ok(fix.label.length > 0, `label za ${id} ne sme biti prazna`);
      assert.deepEqual(Object.keys(fix).sort(), ['id', 'label']);
    }
  });

  test('CHECK_ORDER ima 20 vnosov v zamrznjenem redu (7 + 6 za viri + 5 Val 26 za errors + prehodi + tempo)', () => {
    assert.deepEqual(CHECK_ORDER.map((c) => c.id), [
      'config', 'dataDir', 'tts', 'library', 'ledger', 'corpus', 'feeds',
      'icecast', 'liquidsoap', 'm3u', 'storage', 'host', 'errors',
      'station', 'imaging', 'beds', 'wheel', 'backup', 'prehodi', 'tempo',
    ]);
    for (const c of CHECK_ORDER) {
      assert.equal(typeof c.label, 'string');
      assert.ok(c.label.length > 0, `label za ${c.id} ne sme biti prazna`);
    }
  });
});

describe('SUB/WAVE 4-c doctor -- icecast (oddajnik)', () => {
  test('vsak HTTP odgovor (tudi 500) -> ok; merimo dostopnost, ne pravilnost', async () => {
    const r = await checkIcecast({
      icecastUrl: 'http://localhost:8001/status-json.xsl',
      fetchImpl: async () => ({ status: 500 }),
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /oddajnik odgovarja na http:\/\/localhost:8001\/status-json\.xsl/);
    assert.match(r.detail, /merimo dostopnost, ne pravilnost/);
    assert.ok(!('hint' in r) && !('fix' in r), 'ok brez namiga in popravka');
  });

  test('mrtva povezava -> warn "poslušalci trenutno ne slišijo ničesar", program igra dalje + fix', async () => {
    const r = await checkIcecast({
      icecastUrl: 'http://localhost:8001/status-json.xsl',
      fetchImpl: async () => { throw new Error('fetch failed'); },
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /poslušalci trenutno ne slišijo ničesar/);
    assert.match(r.detail, /program igra dalje/);
    assert.equal(typeof r.hint, 'string');
    assert.ok(r.hint.length > 0);
    assert.deepEqual(r.fix, FIXES['check-icecast']);
  });

  test('brez config.icecast bloka -> preskok s pošteno razlago (brez sonde)', async () => {
    const r = await checkIcecast({});
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /config\.icecast ni nastavljen/);
  });
});

describe('SUB/WAVE 4-c doctor -- liquidsoap (telnet)', () => {
  test('živ odgovor na "uptime" -> ok z izrezkom odgovora', async () => {
    const r = await checkLiquidsoap({ sendCommandImpl: async () => '5432.5', telnetPort: 1234 });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /uptime/);
    assert.match(r.detail, /5432\.5/);
    assert.ok(!('fix' in r) && !('hint' in r));
  });

  test('zavržena povezava -> warn + fix restart-liquidsoap + namig', async () => {
    const r = await checkLiquidsoap({
      sendCommandImpl: async () => { throw new Error('connect ECONNREFUSED'); },
      telnetPort: 1234,
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /ne odgovarja/);
    assert.equal(typeof r.hint, 'string');
    assert.ok(r.hint.length > 0);
    assert.deepEqual(r.fix, FIXES['restart-liquidsoap']);
  });

  test('"ERROR:" odgovor in prazen odgovor -> warn (strežnik živi, miza pa ne)', async () => {
    const err = await checkLiquidsoap({ sendCommandImpl: async () => 'ERROR: no such command', telnetPort: 1234 });
    assert.equal(err.status, STATUS.WARN);
    assert.deepEqual(err.fix, FIXES['restart-liquidsoap']);
    const empty = await checkLiquidsoap({ sendCommandImpl: async () => '   \n', telnetPort: 1234 });
    assert.equal(empty.status, STATUS.WARN);
    assert.deepEqual(empty.fix, FIXES['restart-liquidsoap']);
  });

  test('brez telnet porta v configu / brez odjemalca -> preskok', async () => {
    const noPort = await checkLiquidsoap({ sendCommandImpl: async () => 'x' });
    assert.equal(noPort.status, STATUS.SKIP);
    assert.match(noPort.detail, /telnetPort ni nastavljen/);
    const noImpl = await checkLiquidsoap({ telnetPort: 1234 });
    assert.equal(noImpl.status, STATUS.SKIP);
    assert.match(noImpl.detail, /odjemalec ni podan/);
  });
});

describe('SUB/WAVE 4-c doctor -- predvajalne liste (m3u)', () => {
  test('obe listi napolnjeni -> ok s štetjem obeh (ne-prazne, ne-komentar vrstice)', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'now_playing.m3u'), '# trenutna oddaja\nskladba-1.mp3\n\nskladba-2.mp3\n');
    fs.writeFileSync(path.join(dir, 'filler.m3u'), 'filler-1.mp3\nfiller-2.mp3\nfiller-3.mp3\n');
    const r = await checkM3u({
      nowPlayingPath: path.join(dir, 'now_playing.m3u'),
      fillerPath: path.join(dir, 'filler.m3u'),
      readFileImpl: fsp.readFile,
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /now_playing\.m3u: 2 vnosa/);
    assert.match(r.detail, /filler\.m3u: 3 vnosa/);
  });

  test('samo ena obstaja -> ok, manjkajoča pošteno zapisana v detailu', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'now_playing.m3u'), 'samo-ta.mp3\n');
    const r = await checkM3u({
      nowPlayingPath: path.join(dir, 'now_playing.m3u'),
      fillerPath: path.join(dir, 'filler.m3u'),
      readFileImpl: fsp.readFile,
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /now_playing\.m3u: 1 vnos/);
    assert.match(r.detail, /filler\.m3u: manjka/);
  });

  test('obe prazni/manjkajoči -> warn "program bi padel na nujni seznam" + fix + namig', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'now_playing.m3u'), '# samo komentarji\n\n');
    const r = await checkM3u({
      nowPlayingPath: path.join(dir, 'now_playing.m3u'),
      fillerPath: path.join(dir, 'filler.m3u'),
      readFileImpl: fsp.readFile,
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /program bi padel na nujni seznam/);
    assert.equal(typeof r.hint, 'string');
    assert.ok(r.hint.length > 0);
    assert.deepEqual(r.fix, FIXES['regenerate-filler']);
  });

  test('brez poti ali brez bralnika -> preskok (injekcija je dolžnost CLI-ja/testov)', async () => {
    assert.equal((await checkM3u({})).status, STATUS.SKIP);
    const r = await checkM3u({ nowPlayingPath: 'a', fillerPath: 'b' });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /bralnik datotek ni podan/);
  });
});

describe('SUB/WAVE 4-c doctor -- shramba (arhiv/disk)', () => {
  test('majhen arhiv in dovolj prostora -> ok z obema številoma', async () => {
    const dir = tmpDir();
    const archiveRoot = path.join(dir, 'archive');
    fs.mkdirSync(path.join(archiveRoot, '2026-10-24'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, '2026-10-24', '10-00.mp3'), '12345678'); // 8 B
    fs.writeFileSync(path.join(archiveRoot, '2026-10-24', 'opombe.txt'), 'ne urna datoteka'); // ne šteje
    fs.mkdirSync(path.join(archiveRoot, 'ni-datum'), { recursive: true }); // ne šteje
    const r = await checkStorage({ archiveRoot, archiveEnabled: true, dataDir: dir, statfsImpl: fakeStatfs(50 * GB) });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /arhiv: 0\.0 GB čez 1 dan/);
    assert.match(r.detail, /prosto na disku: 50\.0 GB/);
    assert.ok(!('fix' in r));
  });

  test('arhiv čez 20 GB -> warn "arhiv presega 20 GB" + fix prune-archives; TOČNO 20 GB še NI prekoračeno', async () => {
    const dir = tmpDir();
    const archiveRoot = path.join(dir, 'archive');
    fs.mkdirSync(path.join(archiveRoot, '2026-10-24'), { recursive: true });
    const hourFile = path.join(archiveRoot, '2026-10-24', '10-00.mp3');
    fs.writeFileSync(hourFile, 'x');
    // redka (sparse) datoteka: velikost je točno meja + 1 bajt, na disku pa
    // ne zavzame nič -- meja je NAD 20 GB, +1 bajt jo sproži ...
    fs.truncateSync(hourFile, STORAGE_LIMITS.archiveWarnBytes + 1);
    const over = await checkStorage({ archiveRoot, archiveEnabled: true, dataDir: dir, statfsImpl: fakeStatfs(50 * GB) });
    assert.equal(over.status, STATUS.WARN);
    assert.match(over.detail, /arhiv presega 20 GB/);
    assert.match(over.detail, /zadrževanje je milo napihnjeno/);
    assert.equal(typeof over.hint, 'string');
    assert.ok(over.hint.length > 0);
    assert.deepEqual(over.fix, FIXES['prune-archives']);
    // ... točno 20 GB pa meje (še) ni prekoračilo
    fs.truncateSync(hourFile, STORAGE_LIMITS.archiveWarnBytes);
    const exact = await checkStorage({ archiveRoot, archiveEnabled: true, dataDir: dir, statfsImpl: fakeStatfs(50 * GB) });
    assert.equal(exact.status, STATUS.OK);
  });

  test('prosto pod 2 GB -> warn + fix free-disk; TOČNO 2 GB še ni', async () => {
    const dir = tmpDir(); // tmpDir() mapo že ustvari (mkdtemp) -- dataDir obstaja
    const below = await checkStorage({ archiveEnabled: false, dataDir: dir, statfsImpl: fakeStatfs(STORAGE_LIMITS.diskFreeWarnBytes - 1) });
    assert.equal(below.status, STATUS.WARN);
    assert.match(below.detail, /prosto na disku je le/);
    assert.deepEqual(below.fix, FIXES['free-disk']);
    const exact = await checkStorage({ archiveEnabled: false, dataDir: dir, statfsImpl: fakeStatfs(STORAGE_LIMITS.diskFreeWarnBytes) });
    assert.equal(exact.status, STATUS.OK);
  });

  test('arhiv izklopljen -> del (i) pošteno preskočen v detailu (ne izmišljen)', async () => {
    const dir = tmpDir();
    const r = await checkStorage({ archiveRoot: path.join(dir, 'arhiv'), archiveEnabled: false, dataDir: dir, statfsImpl: fakeStatfs(10 * GB) });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /arhiv izklopljen/);
    assert.match(r.detail, /velikost arhiva ni preverjena/);
    assert.match(r.detail, /prosto na disku: 10\.0 GB/);
  });

  test('statfs ni na voljo ali pade -> podatek o prostoru IZPUSTIJO (ni lažnega števila)', async () => {
    const dir = tmpDir();
    const archiveRoot = path.join(dir, 'archive');
    fs.mkdirSync(path.join(archiveRoot, '2026-10-24'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, '2026-10-24', '09-00.mp3'), 'x');
    const absent = await checkStorage({ archiveRoot, archiveEnabled: true, dataDir: dir, statfsImpl: null });
    assert.equal(absent.status, STATUS.OK);
    assert.ok(!absent.detail.includes('prosto na disku'), 'brez statfs brez števila');
    const throwing = await checkStorage({
      archiveRoot, archiveEnabled: true, dataDir: dir,
      statfsImpl: async () => { throw new Error('ENOSYS'); },
    });
    assert.equal(throwing.status, STATUS.OK);
    assert.ok(!throwing.detail.includes('prosto na disku'), 'padel statfs tudi ne laže');
  });

  test('nič merjenega (arhiv izklopljen, statfs odsoten) -> preskok, ne izmišljena števila', async () => {
    const r = await checkStorage({ archiveEnabled: false, statfsImpl: null });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /preskočeno/);
    assert.doesNotMatch(r.detail, /\d+\.\d GB/);
  });
});

describe('SUB/WAVE 4-c doctor -- gostitelj (CPU/spomin)', () => {
  test('zdrav /proc -> ok s številkami obremenitve in pomnilnika', async () => {
    const r = await checkHost({
      readFileImpl: fakeProc({ load1: '0.52', memTotalKb: 16777216, memAvailKb: 8388608 }),
      cpuCount: 4,
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /obremenitev: 0\.52 \(meja 8 = 2 × 4 jedri\)/);
    assert.match(r.detail, /pomnilnik: 50\.0 % na voljo \(8\.0 GB od 16\.0 GB\)/);
    assert.ok(!('fix' in r));
  });

  test('load1 nad 2×jedri -> warn "gostitelj je pod pritiskom ... produkcija lahko zamudi"; brez fixa (ni ukrepa v naboru)', async () => {
    const r = await checkHost({
      readFileImpl: fakeProc({ load1: '8.01', memTotalKb: 16777216, memAvailKb: 8388608 }),
      cpuCount: 4,
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /gostitelj je pod pritiskom/);
    assert.match(r.detail, /produkcija lahko zamudi/);
    assert.equal(typeof r.hint, 'string');
    assert.ok(r.hint.length > 0);
    assert.ok(!('fix' in r), 'gostitelj nima popravka v FIXES -- pošteno brez');
  });

  test('meja obremenitve: load1 točno 2×jedri še NI prekoračena', async () => {
    const r = await checkHost({
      readFileImpl: fakeProc({ load1: '8.00', memTotalKb: 16777216, memAvailKb: 8388608 }),
      cpuCount: 4,
    });
    assert.equal(r.status, STATUS.OK);
  });

  test('pomnilnik pod 10 % -> warn; točno 10 % še ni', async () => {
    const below = await checkHost({
      readFileImpl: fakeProc({ load1: '0.10', memTotalKb: 10000000, memAvailKb: 900000 }),
      cpuCount: 4,
    });
    assert.equal(below.status, STATUS.WARN);
    assert.match(below.detail, /pomnilnika je na voljo le 9\.0 %/);
    const exact = await checkHost({
      readFileImpl: fakeProc({ load1: '0.10', memTotalKb: 10000000, memAvailKb: 1000000 }),
      cpuCount: 4,
    });
    assert.equal(exact.status, STATUS.OK);
  });

  test('/proc neberljiv (gostitelj ni Linux) -> preskok s pošteno opombo', async () => {
    const r = await checkHost({ readFileImpl: async () => { throw new Error('ENOENT'); } });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /ni berljiv/);
    assert.match(r.detail, /ni Linux/);
  });

  test('brez injiciranega bralnika -> preskok (pravi /proc bi bil nedeterminističen)', async () => {
    const r = await checkHost({});
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /bralnik \/proc ni podan/);
  });
});

describe('SUB/WAVE 4-c doctor -- dnevnik napak (24 h)', () => {
  const NOW = Date.parse('2026-10-25T12:00:00+02:00');

  function writeLogs(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  }

  test('sveže ERROR vrstice štejejo; stare, nečasovne in ne-ERROR ne; .log.1 se sploh ne bere', async () => {
    const dir = tmpDir();
    writeLogs(dir, {
      'station.log': [
        '[2026-10-25T11:00:00+02:00] ERROR tokrat je hudo',               // sveža -> šteje
        '[2026-10-24T10:00:00+02:00] ERROR staro je čez 24 h',            // 26 h nazaj -> ne
        '[21.10.2026 11:00] ERROR brez razumljivega ISO časa',            // nečasovna -> ne
        '[2026-10-25T11:30:00+02:00] vse v redu, ni napake',              // ni ERROR -> ne
      ].join('\n') + '\n',
      'station.log.1': '[2026-10-25T11:45:00+02:00] ERROR rotirana kopija -- ne šteje dvakrat\n',
    });
    const r = await checkErrors({ logsDir: dir, nowMs: NOW, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /^1 napaka v 24 h/);
    assert.match(r.detail, /čez 1 dnevnik/);
  });

  test('več kot 20 napak v 24 h -> warn "nekaj se vrti v zanki" + fix inspect-logs', async () => {
    const dir = tmpDir();
    const lines = Array.from({ length: 21 }, (_, i) => `[2026-10-25T0${i % 10}:00:00+02:00] ERROR napaka ${i}`);
    writeLogs(dir, { 'web.log': lines.join('\n') + '\n' });
    const r = await checkErrors({ logsDir: dir, nowMs: NOW, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /^21 napak v 24 h/);
    assert.match(r.detail, /nekaj se vrti v zanki/);
    assert.equal(typeof r.hint, 'string');
    assert.ok(r.hint.length > 0);
    assert.deepEqual(r.fix, FIXES['inspect-logs']);
  });

  test('manjkajoča mapa / brez aktivnih .log datotek -> preskok', async () => {
    const r = await checkErrors({ logsDir: path.join(tmpDir(), 'ni-je'), nowMs: NOW, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /ne obstaja/);
    const empty = tmpDir(); // že ustvarjena, a PRAZNA mapa
    fs.writeFileSync(path.join(empty, 'station.log.1'), '[2026-10-25T11:00:00+02:00] ERROR samo rotirana\n');
    const r2 = await checkErrors({ logsDir: empty, nowMs: NOW, readFileImpl: fsp.readFile });
    assert.equal(r2.status, STATUS.SKIP);
    assert.match(r2.detail, /ni aktivnih \.log datotek/);
  });

  test('brez poti ali brez bralnika -> preskok', async () => {
    assert.equal((await checkErrors({ nowMs: NOW })).status, STATUS.SKIP);
    const r = await checkErrors({ logsDir: tmpDir(), nowMs: NOW }); // prazna mapa, brez bralnika
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /bralnik datotek ni podan/);
  });
});

describe('SUB/WAVE 4-c doctor -- runDoctor sestava (šest novih pod istim pokrovom)', () => {
  test('zlomljen config -> vseh šest novih + pet Val 26 + prehodi + tempo preskoči z istim vzorcem "config ni berljiv"', async () => {
    const report = await runDoctor({ configOrError: new Error('config.json not found'), netProbe: false });
    for (const id of ['icecast', 'liquidsoap', 'm3u', 'storage', 'host', 'errors', 'station', 'imaging', 'beds', 'wheel', 'backup', 'prehodi', 'tempo']) {
      const r = report.results.find((x) => x.id === id);
      assert.equal(r.status, STATUS.SKIP, id);
      assert.match(r.detail, /preskočeno -- config ni berljiv/, id);
    }
  });

  test('brez injekcij -> pošteni preskoki (nobenega pravega omrežja, /proc, statfs ali novih poti)', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const report = await runDoctor({ configOrError: cfg, netProbe: false });
    const ids = ['icecast', 'liquidsoap', 'm3u', 'storage', 'host', 'errors', 'station', 'imaging', 'wheel', 'backup', 'tempo'];
    for (const id of ids) {
      assert.equal(report.results.find((r) => r.id === id).status, STATUS.SKIP, id);
    }
    assert.match(report.results.find((r) => r.id === 'host').detail, /bralnik \/proc ni podan/);
    assert.match(report.results.find((r) => r.id === 'icecast').detail, /config\.icecast ni nastavljen/);
    // beds so EDINI novi, ki ne rabi poti za svoj odgovor: izklopljene je
    // podprto stanje (OPT-IN), ne vrzel -- OK z opombo, ne preskok.
    assert.equal(report.results.find((r) => r.id === 'beds').status, STATUS.OK);
    assert.match(report.results.find((r) => r.id === 'beds').detail, /izklopljene \(OPT-IN\)/);
  });

  test('polna injekcija -> 20 rezultatov v zamrznjenem redu, hint/fix SAMO na opozorilih, determinizem', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.autoRadio.music.localDirs[0], { recursive: true });
    fs.writeFileSync(path.join(cfg.autoRadio.music.localDirs[0], 'a.mp3'), 'x');
    const clips = path.join(cfg.dataDir, 'voice-clips');
    fs.mkdirSync(clips);
    fs.writeFileSync(path.join(clips, 'open.wav'), 'x');
    fs.mkdirSync(path.join(cfg.dataDir, 'history'), { recursive: true });
    const entry = { ratingKey: 'rk', artist: 'A', title: 'T', album: 'L', durationMs: 1, showId: 'j', playedAt: '2026-10-25T08:00:00+02:00' };
    fs.writeFileSync(path.join(cfg.dataDir, 'history', 'aired.jsonl'), JSON.stringify(entry) + '\n');
    fs.writeFileSync(path.join(cfg.dataDir, 'now_playing.m3u'), '# trenutna\nskladba-1.mp3\nskladba-2.mp3\n');
    // Val 28: filler z IZMERJENIMI prehodi (fade-in 0.5 = izmerjen hladni
    // začetek, washout na velikem repu) -- polna postaja ima merjeno plast
    // pripravljeno, zato je tudi prehodi OK.
    fs.writeFileSync(
      path.join(cfg.dataDir, 'filler.m3u'),
      'annotate:source_tag="music",liq_fade_in="0.5":/tmp/filler-1.mp3\n'
        + 'annotate:source_tag="music",liq_fade_in="2",liq_washout="1":/tmp/filler-2.mp3\n'
        + 'annotate:source_tag="music",liq_fade_in="2":/tmp/filler-3.mp3\n'
    );
    const logsDir = path.join(cfg.dataDir, 'logs');
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, 'station.log'), '[2026-10-25T11:00:00+02:00] ERROR ena sama, ne vzorec\n');
    const archiveRoot = path.join(cfg.dataDir, 'archive');
    fs.mkdirSync(path.join(archiveRoot, '2026-10-24'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, '2026-10-24', '10-00.mp3'), 'x');

    // /proc fake IN pravi bralnik za datoteke v enem -- doctor dobi en
    // readFileImpl, ki zná oboje (točno tako, kot bi ga sestavil resen CLI
    // z zunanjim /proc, le da tu brez korena).
    const readFileImpl = async (file, enc) => {
      if (file === '/proc/loadavg') return '0.10 0.10 0.05 1/100 12345\n';
      if (file === '/proc/meminfo') return 'MemTotal:       16777216 kB\nMemAvailable:   8388608 kB\n';
      return fsp.readFile(file, enc);
    };
    const inputs = () => ({
      configOrError: cfg,
      netProbe: false,
      nowMs: Date.parse('2026-10-25T12:00:00+02:00'),
      fetchImpl: async () => ({ status: 200 }),
      sendCommandImpl: async () => { throw new Error('connect ECONNREFUSED'); }, // mrtva miza -> warn z fixom
      readFileImpl,
      statfsImpl: fakeStatfs(50 * GB),
      nowPlayingPath: path.join(cfg.dataDir, 'now_playing.m3u'),
      fillerPath: path.join(cfg.dataDir, 'filler.m3u'),
      archiveRoot,
      archiveEnabled: true,
      logsDir,
      icecastUrl: 'http://localhost:8001/status-json.xsl',
      telnetPort: 1234,
      // Val 33: dnevni profili govora -- polna postaja jih ima vklopljene
      // (zdrav profil, PRAVI bralnik blokov po isti disciplini kot doctorCli).
      daypartProsody: { morning: { edgeRate: '-3%' }, night: { edgeRate: '-11%', piperLengthScale: 1.15 } },
      timeBlocks: {
        morning: { start: '05:00', end: '10:00' },
        daytime: { start: '10:00', end: '17:00' },
        evening: { start: '17:00', end: '23:00' },
        night: { start: '23:00', end: '05:00' },
      },
    });

    const report = await runDoctor(inputs());
    assert.deepEqual(report.results.map((r) => r.id), CHECK_ORDER.map((c) => c.id));
    assert.equal(report.exitCode, 0); // opozorilo, ne napaka
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    assert.equal(byId.config.status, 'ok');
    assert.equal(byId.icecast.status, 'ok');
    assert.equal(byId.liquidsoap.status, 'warn');
    assert.equal(byId.m3u.status, 'ok');
    assert.equal(byId.prehodi.status, 'ok');
    assert.match(byId.prehodi.detail, /2\/3 vnosa nosi izmerjene prehode \(67 %\)/);
    assert.match(byId.prehodi.detail, /washout 1/);
    assert.equal(byId.storage.status, 'ok');
    assert.equal(byId.host.status, 'ok');
    assert.equal(byId.errors.status, 'ok');
    assert.equal(byId.tempo.status, 'ok');
    assert.match(byId.tempo.detail, /morning \(edgeRate\)/);
    assert.match(byId.tempo.detail, /night \(edgeRate, piperLengthScale\)/);
    assert.deepEqual(byId.liquidsoap.fix, FIXES['restart-liquidsoap']);
    // Finding model: hint/fix nosijo SAMO opozorila -- ok/skip brez njiju
    for (const r of report.results) {
      if (r.status === 'warn') {
        assert.equal(typeof r.hint, 'string', `${r.id}: opozorilo potrebuje namig`);
        assert.ok(r.hint.length > 0, `${r.id}: namig ne sme biti prazen`);
      } else {
        assert.ok(!('hint' in r) && !('fix' in r), `${r.id}: ok/skip brez namiga in popravka`);
      }
    }
    // determinizem: isti vhodi -> bajtno isti izpis
    const report2 = await runDoctor(inputs());
    assert.deepEqual(JSON.parse(JSON.stringify(report2.results)), JSON.parse(JSON.stringify(report.results)));
    assert.equal(report2.verdict, report.verdict);
  });
});

// ---- Val 26: doktor dohiti postajo -- pet novih preverjanj -------------------
// Q. station (station.json) -- pokvarjenost, ki jo fail-open bralci tiho
// pogoltnejo, tu dobi glas. timeToMinutes je fika z ISTO semantiko kot
// scheduleUtil (split/Number/NaN); PRAVI bralnik je pripet v V bloku.
const fakeTimeToMinutes = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};

describe('Val 26 doctor -- station (station.json)', () => {
  const writeStation = (dir, obj) => {
    const file = path.join(dir, 'station.json');
    fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return file;
  };

  test('zdrav urnik z vejica-ključi, ne-strogim "6:00" in prepiši -> ok s številkami', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, {
      station: { name: 'Test' },
      schedule: {
        'monday,wednesday': [{ id: 'a', startTime: '20:00', durationMinutes: 60 }],
        friday: [{ id: 'b', startTime: '6:00', durationMinutes: 30 }],
        dates: { '2026-12-25': [{ id: 'd', startTime: '10:00', durationMinutes: 60 }] },
      },
    });
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.OK);
    // "6:00" runtime velja (timeToMinutes je odpuščujoč) -- doctor ne sme biti
    // strožji od postaje, ki jo opisuje.
    assert.match(r.detail, /2 terminirani oddaji na teden/);
    assert.match(r.detail, /1 nadomeščen dan/);
    assert.ok(!('hint' in r) && !('fix' in r), 'ok brez namiga in popravka');
  });

  test('manjkajoč station.json -> warn "še ne obstaja" (nova postaja, ne napaka)', async () => {
    const r = await checkStation({ stationFilePath: path.join(tmpDir(), 'station.json'), readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /še ne obstaja -- urnik je prazen/);
  });

  test('pokvarjen JSON -> FAIL "se ne prebere" + hint + fix (nobena oddaja ne bo terminirana)', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, '{"schedule": {"monday": [,,,');
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.detail, /se ne prebere/);
    assert.match(r.detail, /NOBENA oddaja ne bo terminirana/);
    assert.equal(typeof r.hint, 'string');
    assert.deepEqual(r.fix, FIXES['fix-station-json']);
  });

  test('veljaven JSON, a ne-objekt / brez schedule -> warn z opombo oblike', async () => {
    const d1 = tmpDir();
    const r1 = await checkStation({ stationFilePath: writeStation(d1, '"samo niz"'), readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r1.status, STATUS.WARN);
    assert.match(r1.detail, /ni objekt/);
    const d2 = tmpDir();
    const r2 = await checkStation({ stationFilePath: writeStation(d2, { station: {} }), readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r2.status, STATUS.WARN);
    assert.match(r2.detail, /schedule blok manjka/);
    assert.deepEqual(r2.fix, FIXES['fix-station-json']);
  });

  test('ne-seznam pod delovnim dnem -> FAIL (loadSchedule vrže TypeError ob vsakem branju)', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, { schedule: { monday: 'oops', friday: [{ id: 'a', startTime: '20:00' }] } });
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.detail, /urnik pod ključem "monday" ni seznam/);
    assert.match(r.detail, /ob vsakem branju vrže napako/);
    assert.deepEqual(r.fix, FIXES['fix-station-json']);
  });

  test('neznan dnevni žeton -> warn po imenu; vejica-ključi se razširijo s trim', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, { schedule: { boats: [{ id: 'a', startTime: '09:00' }], ' monday ,tuesday': [{ id: 'b', startTime: '20:00' }] } });
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /neznan\(i\) dnevni ključ\(i\): "boats"/);
    // " monday ,tuesday" se razširi s trim -> NI neznan žeton (pripet tudi
    // prek V bloka z realim bralnikom, tu na fiki z isto semantiko)
    assert.ok(!r.detail.includes('"monday"'));
    assert.ok(!r.detail.includes('"tuesday"'));
  });

  test('slabi datumski prepiši -> warn z imeni (vzorec + koledarski povratni izlet)', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, {
      schedule: {
        monday: [{ id: 'a', startTime: '20:00' }],
        dates: { '2026-13-45': [{ id: 'x', startTime: '10:00' }], '2026-1-5': [{ id: 'y', startTime: '11:00' }], '2026-12-25': [{ id: 'd', startTime: '12:00' }] },
      },
    });
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /neveljavan\(i\) datumski prepiš\(i\): "2026-13-45", "2026-1-5"/);
    assert.match(r.detail, /1 nadomeščen dan/); // samo 2026-12-25 je preživel
  });

  test('nevzdržne pojavitve (brez id / brez časa / črn čas) -> warn s številom', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, {
      schedule: { monday: [
        { id: 'dobra', startTime: '20:00' },
        {},
        { id: 'y', startTime: 'abc' },
        { startTime: '21:00' },
      ] },
    });
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /3 pojavitvi brez veljavnega id\/startTime/);
    assert.match(r.detail, /te oddaje nikoli ne bodo terminirane/);
  });

  test('prazen urnik -> warn (sveža namestitev ali namerni temni teden)', async () => {
    const dir = tmpDir();
    const stationFile = writeStation(dir, { schedule: {} });
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: fakeTimeToMinutes });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /urnik je prazen/);
  });

  test('brez poti ali brez bralnikov -> preskok', async () => {
    assert.equal((await checkStation({})).status, STATUS.SKIP);
    const noReader = await checkStation({ stationFilePath: 'x' });
    assert.equal(noReader.status, STATUS.SKIP);
    assert.match(noReader.detail, /časovni bralnik ni podan/);
  });
});

// R. imaging plasti -- merimo OBOJE: kipe v mapi (vir) in vrstice v m3u (eter)
describe('Val 26 doctor -- imaging plasti', () => {
  const mkImaging = (dir) => {
    const dirs = { id: path.join(dir, 'id'), stingers: path.join(dir, 'stingers'), emergency: path.join(dir, 'emergency'), promos: path.join(dir, 'promos') };
    const m3us = { id: path.join(dir, 'id.m3u'), stingers: path.join(dir, 'stingers.m3u'), emergency: path.join(dir, 'emergency.m3u'), promos: path.join(dir, 'promos.m3u') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    return { dirs, m3us };
  };
  const m3uLine = (tag, file) => `annotate:source_tag="${tag}",liq_fade_in="0":${file}\n`;

  test('vse plasti napolnjjene -> ok s številkami; promosi izklopljeni so poštena opomba', async () => {
    const dir = tmpDir();
    const { dirs, m3us } = mkImaging(dir);
    // Val 28 C2: 4 kipi na plast -- pod 4 bi zdaj opozorilo o tankem vrtenju
    // (radio.liq randomize brez spomina).
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(dirs.id, `id${i}.mp3`), 'x');
      fs.writeFileSync(path.join(dirs.stingers, `s${i}.mp3`), 'x');
    }
    fs.writeFileSync(path.join(dirs.emergency, 'e1.wav'), 'x');
    fs.writeFileSync(m3us.id, m3uLine('id', '/tmp/a.mp3'));
    fs.writeFileSync(m3us.stingers, m3uLine('stinger', '/tmp/s1.mp3') + m3uLine('stinger', '/tmp/s2.mp3'));
    fs.writeFileSync(m3us.emergency, m3uLine('emergency', '/tmp/e.wav'));
    const r = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, promosEnabled: false, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /ID-ji \(polna ura\): 4/);
    assert.match(r.detail, /stingerji: 4/);
    assert.match(r.detail, /nujna rezerva: 1/);
    assert.match(r.detail, /promosi: izklopljeni \(OPT-IN\)/);
    assert.ok(!('hint' in r) && !('fix' in r));
  });

  // Val 28 C2: širina vrtenja -- radio.liq izbira iz plasti z mode="randomize"
  // BREZ spomina, zato 1-3 kipi pomenijo isti posnetek uro za uro. Nujna
  // rezerva je izvzeta (njena naloga je preživetje, ne pestrost).
  test('tanka plast (2 kipa) -> warn o vrtenju + fix load-imaging-clips; nujna rezerva se ne pritoži', async () => {
    const dir = tmpDir();
    const { dirs, m3us } = mkImaging(dir);
    fs.writeFileSync(path.join(dirs.id, 'id1.mp3'), 'x');
    fs.writeFileSync(path.join(dirs.id, 'id2.mp3'), 'x');
    for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(dirs.stingers, `s${i}.mp3`), 'x');
    fs.writeFileSync(path.join(dirs.emergency, 'e1.wav'), 'x');
    fs.writeFileSync(m3us.id, m3uLine('id', '/tmp/a.mp3'));
    fs.writeFileSync(m3us.stingers, m3uLine('stinger', '/tmp/s1.mp3'));
    fs.writeFileSync(m3us.emergency, m3uLine('emergency', '/tmp/e.wav'));
    const r = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, promosEnabled: false, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /ID-ji \(polna ura\): 2/);
    assert.match(r.detail, /tanko vrtenje \(2 kipa\)/);
    assert.doesNotMatch(r.detail, /nujna rezerva: tanko/);
    assert.deepEqual(r.fix, FIXES['load-imaging-clips']);
  });

  test('prazna mapa ID-jev -> warn "molčijo, postaja igra dalje" + fix load-imaging-clips', async () => {
    const dir = tmpDir();
    const { dirs, m3us } = mkImaging(dir);
    fs.writeFileSync(path.join(dirs.stingers, 's1.mp3'), 'x');
    fs.writeFileSync(path.join(dirs.emergency, 'e1.wav'), 'x');
    fs.writeFileSync(m3us.stingers, m3uLine('stinger', '/tmp/s1.mp3'));
    fs.writeFileSync(m3us.emergency, m3uLine('emergency', '/tmp/e.wav'));
    const r = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /ID-ji \(polna ura\): 0/);
    assert.match(r.detail, /molčijo/);
    assert.deepEqual(r.fix, FIXES['load-imaging-clips']);
  });

  test('prazna nujna rezerva -> warn "ob padcu VSEH virov je spredaj tišina"', async () => {
    const dir = tmpDir();
    const { dirs, m3us } = mkImaging(dir);
    fs.writeFileSync(path.join(dirs.id, 'id1.mp3'), 'x');
    fs.writeFileSync(path.join(dirs.stingers, 's1.mp3'), 'x');
    fs.writeFileSync(m3us.id, m3uLine('id', '/tmp/a.mp3'));
    fs.writeFileSync(m3us.stingers, m3uLine('stinger', '/tmp/s.mp3'));
    const r = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /nujna rezerva je prazna -- ob padcu VSEH virov je spredaj tišina/);
  });

  test('kipi v mapi, a m3u prazen/pogrešan -> warn "imaging tik ne teče" + fix check-scheduler', async () => {
    const dir = tmpDir();
    const { dirs, m3us } = mkImaging(dir);
    fs.writeFileSync(path.join(dirs.id, 'id1.mp3'), 'x');
    fs.writeFileSync(path.join(dirs.stingers, 's1.mp3'), 'x');
    fs.writeFileSync(path.join(dirs.emergency, 'e1.wav'), 'x');
    fs.writeFileSync(m3us.id, '# še prazen\n');
    // stingers.m3u in emergency.m3u sploh ne nastaneta -- null, ne 0
    const r = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /m3u je prazen ali pogrešan -- imaging tik \(30 min\) ne teče/);
    assert.deepEqual(r.fix, FIXES['check-scheduler']);
  });

  test('promosi vklopljeni: prazni -> warn; napolnjeni -> ok del "vklopljeni"', async () => {
    const dir = tmpDir();
    const { dirs, m3us } = mkImaging(dir);
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(dirs.id, `id${i}.mp3`), 'x');
      fs.writeFileSync(path.join(dirs.stingers, `s${i}.mp3`), 'x');
    }
    fs.writeFileSync(path.join(dirs.emergency, 'e1.wav'), 'x');
    fs.writeFileSync(m3us.id, m3uLine('id', '/tmp/a.mp3'));
    fs.writeFileSync(m3us.stingers, m3uLine('stinger', '/tmp/s.mp3'));
    fs.writeFileSync(m3us.emergency, m3uLine('emergency', '/tmp/e.wav'));
    const empty = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, promosEnabled: true, readFileImpl: fsp.readFile });
    assert.equal(empty.status, STATUS.WARN);
    assert.match(empty.detail, /promosi so vklopljeni, a mapa je prazna/);
    fs.writeFileSync(path.join(dirs.promos, 'promo_vecer_2026-10-26_18-00.mp3'), 'x');
    fs.writeFileSync(m3us.promos, m3uLine('promo', '/tmp/p.mp3'));
    const full = await checkImaging({ imagingDirs: dirs, imagingM3us: m3us, promosEnabled: true, readFileImpl: fsp.readFile });
    assert.equal(full.status, STATUS.OK);
    assert.match(full.detail, /promosi: 1 \(vklopljeni\)/);
  });

  test('brez poti plasti -> preskok (izpeljava živi v CLI-ju)', async () => {
    assert.equal((await checkImaging({})).status, STATUS.SKIP);
    const r = await checkImaging({ imagingDirs: {} });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /poti plasti niso podane/);
  });
});

// R2. prehodi (merjena plast) [Val 28] -- resnica o etu je .m3u: štejemo
// vnose, ki dejansko letijo in nosijo IZMERJEN žig (liq_fade_in drugačen od
// privzetega 2 s, liq_cross_duration na repu, ali efekt
// sweep/washout/dissolve). Brez poti/bralnika -> pošten preskok; prazen
// filler ali filler brez izmerjenih žigov -> opozorilo (autocue ne teče);
// zdrav filler -> OK s pokritostjo in ločenimi številkami učinkov.
describe('Val 28 doctor -- prehodi (merjena plast)', () => {
  const line = (group, file) => `annotate:${group}:${file}\n`;

  test('brez poti ali bralnika -> preskok', async () => {
    assert.equal((await checkPrehodi({})).status, STATUS.SKIP);
    assert.equal((await checkPrehodi({ fillerPath: '/tmp/x.m3u' })).status, STATUS.SKIP);
    assert.equal((await checkPrehodi({ readFileImpl: fsp.readFile })).status, STATUS.SKIP);
  });

  test('manjkajoč filler.m3u -> preskok (to že pove preverjanje seznamov)', async () => {
    const dir = tmpDir();
    const r = await checkPrehodi({ fillerPath: path.join(dir, 'filler.m3u'), readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /filler\.m3u še ne obstaja/);
  });

  test('prazen filler -> warn z fixom regenerate-filler', async () => {
    const dir = tmpDir();
    const filler = path.join(dir, 'filler.m3u');
    fs.writeFileSync(filler, '# samo komentar\n\n');
    const r = await checkPrehodi({ fillerPath: filler, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /filler\.m3u je prazen/);
    assert.deepEqual(r.fix, FIXES['regenerate-filler']);
  });

  test('gole poti brez žigov -> warn "ravni prehodi" s fixom check-scheduler', async () => {
    const dir = tmpDir();
    const filler = path.join(dir, 'filler.m3u');
    fs.writeFileSync(filler, 'filler-1.mp3\nfiller-2.mp3\n');
    const r = await checkPrehodi({ fillerPath: filler, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /0\/2 vnosa nosi izmerjene prehode \(0 %\)/);
    assert.match(r.detail, /vsak prehod je raven/);
    assert.deepEqual(r.fix, FIXES['check-scheduler']);
  });

  test('izmerjeni vnosi -> ok s pokritostjo + ločenimi učinki (fade 2 s srednji pas NE šteje)', async () => {
    const dir = tmpDir();
    const filler = path.join(dir, 'filler.m3u');
    fs.writeFileSync(
      filler,
      line('source_tag="music",liq_fade_in="0.5"', '/tmp/a.mp3') // izmerjen hladni začetek
        + line('source_tag="music",liq_fade_in="2"', '/tmp/b.mp3') // srednji pas: NE izmerjen
        + line('source_tag="music",liq_fade_in="2",liq_washout="1"', '/tmp/c.mp3') // učinek
        + line('source_tag="music",liq_fade_in="3.2",liq_cross_duration="8.5"', '/tmp/d.mp3') // oboje
    );
    const r = await checkPrehodi({ fillerPath: filler, readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /3\/4 vnosa nosi izmerjene prehode \(75 %\)/);
    assert.match(r.detail, /washout 1/);
    assert.match(r.detail, /dissolve 0/);
    assert.match(r.detail, /sweep 0/);
    assert.match(r.detail, /2\.4\.6\+/);
    assert.ok(!('fix' in r), 'ok brez popravka');
  });
});

// S. beds (formatna ura) -- F2 gumbi, pometanje, knjiga; asimetrija izvira
// (produceLead COERCES, retention NE) je tu pripeta, ker je dokazano vedenje.
describe('Val 26 doctor -- formatna ura (postelje)', () => {
  const NOW = new Date(2026, 9, 26, 12).getTime();
  const WHEEL_TIME = (text) => {
    if (text === '24:00') return 24 * 60;
    const s = String(text ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return null;
    const [h, min] = s.split(':').map(Number);
    return h * 60 + min;
  };

  test('izklopljene -> OK s pošteno opombo (OPT-IN ni vrzel)', async () => {
    const r = await checkBeds({ bedsEnabled: false });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /izklopljene \(OPT-IN\)/);
    assert.ok(!('hint' in r) && !('fix' in r));
  });

  test('vklopljene z zdravimi gumbi, svežim kipom in knjigo -> ok', async () => {
    const dir = tmpDir();
    const bedsDir = path.join(dir, 'beds');
    fs.mkdirSync(bedsDir);
    const fresh = path.join(bedsDir, 'weather_2026-10-26_11-15.mp3');
    fs.writeFileSync(fresh, 'x');
    fs.utimesSync(fresh, new Date(NOW - 30 * 60_000), new Date(NOW - 30 * 60_000));
    const ledger = path.join(dir, 'beds-fired.jsonl');
    fs.writeFileSync(ledger, JSON.stringify({ key: 'k1' }) + '\n' + JSON.stringify({ key: 'k2' }) + '\npokvarjena vrstica\n');
    const r = await checkBeds({
      bedsEnabled: true,
      imagingBedsRaw: { weatherMinutes: [15, 45], weatherDaypart: { from: '06:00', to: '22:00' } },
      bedsDir,
      bedsLedgerPath: ledger,
      parseWheelTimeImpl: WHEEL_TIME,
      generatedBedRe: /^(weather|nextshow)(?:_.+)?_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/,
      readFileImpl: fsp.readFile,
      nowMs: NOW,
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /vklopljene/);
    assert.match(r.detail, /vreme ob: 15, 45/);
    assert.match(r.detail, /okno vremena: 06:00-22:00/);
    assert.match(r.detail, /knjiga sprožitev: 2/); // pokvarjena vrstica se tolerantly preskoči
  });

  test('weatherMinutes: šmetani vnosi -> warn "ven [0, 59]"; ne-seznam -> warn "ni seznam"; [] -> namerno izklopljeno (OK)', async () => {
    const junk = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherMinutes: [15, 75, 'x'] }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(junk.status, STATUS.WARN);
    assert.match(junk.detail, /2 vnosa v weatherMinutes sta ven \[0, 59\]/);
    assert.deepEqual(junk.fix, FIXES['fix-format-clock']);
    const notArray = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherMinutes: '15' }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(notArray.status, STATUS.WARN);
    assert.match(notArray.detail, /weatherMinutes ni seznam -- padel na privzeto \[15, 45\]/);
    const off = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherMinutes: [] }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(off.status, STATUS.OK);
    assert.match(off.detail, /vreme: izklopljeno \(prazen seznam, namerno\)/);
  });

  test('weatherDaypart: slaba oblika / obrnjeno okno -> warn "teče ves dan"; odsotno -> "ves dan" (OK)', async () => {
    const bad = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherDaypart: { from: '06:00', to: 'zzz' } }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(bad.status, STATUS.WARN);
    assert.match(bad.detail, /weatherDaypart "06:00"-"zzz" je nerazumljen -- okno ne velja, vreme teče ves dan/);
    const flipped = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherDaypart: { from: '22:00', to: '06:00' } }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(flipped.status, STATUS.WARN);
    assert.match(flipped.detail, /nerazumljen/);
    const absent = await checkBeds({ bedsEnabled: true, imagingBedsRaw: {}, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(absent.status, STATUS.OK);
    assert.match(absent.detail, /okno vremena: ves dan/);
  });

  test('ASIMETRIJA IZVIRA (formatClock.js): produceLeadMinutes "4" (string) je VELJAVEN, clipRetentionHours "2" (string) je ŠMETAN', async () => {
    const lead = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { produceLeadMinutes: '4' }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(lead.status, STATUS.OK, 'Number() pretvorba -- runtime sprejme string');
    const retention = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { clipRetentionHours: '2' }, parseWheelTimeImpl: WHEEL_TIME });
    assert.equal(retention.status, STATUS.WARN, 'Number.isFinite brez pretvorbe -- runtime pade na privzeti 2 h');
    assert.match(retention.detail, /clipRetentionHours je nerazumljen -- padel na privzeti 2 h/);
  });

  test('pometanje: zastarela GENERIRANA postelja -> warn; operaterjeva datoteka NIKOLI prešteta', async () => {
    const dir = tmpDir();
    const bedsDir = path.join(dir, 'beds');
    fs.mkdirSync(bedsDir);
    const OLD = new Date(NOW - 10 * 3600_000); // 10 h -- čez privzeti 2 h
    const stale = path.join(bedsDir, 'weather_2026-10-25_10-15.mp3');
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, OLD, OLD);
    const operatorFile = path.join(bedsDir, 'moja_postelja.mp3'); // operaterjeva -- nedotakljiva
    fs.writeFileSync(operatorFile, 'x');
    fs.utimesSync(operatorFile, OLD, OLD);
    const r = await checkBeds({
      bedsEnabled: true,
      imagingBedsRaw: {},
      bedsDir,
      generatedBedRe: /^(weather|nextshow)(?:_.+)?_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/,
      nowMs: NOW,
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /1 generirana postelja je čez zadrževanje -- pometanje ni pometalo/);
    assert.deepEqual(r.fix, FIXES['check-scheduler']);
  });

  test('clipRetentionHours 0 = večno: zastarela generirana postelja NI opozorilo', async () => {
    const dir = tmpDir();
    const bedsDir = path.join(dir, 'beds');
    fs.mkdirSync(bedsDir);
    const OLD = new Date(NOW - 30 * 24 * 3600_000);
    const stale = path.join(bedsDir, 'nextshow_vecer_2026-09-01_20-00.mp3');
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, OLD, OLD);
    const r = await checkBeds({
      bedsEnabled: true,
      imagingBedsRaw: { clipRetentionHours: 0 },
      bedsDir,
      generatedBedRe: /^(weather|nextshow)(?:_.+)?_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/,
      nowMs: NOW,
    });
    assert.equal(r.status, STATUS.OK);
  });

  test('knjiga sprožitev manjka -> poštena opomba, ne opozorilo (svež vklop)', async () => {
    const r = await checkBeds({ bedsEnabled: true, imagingBedsRaw: {}, bedsLedgerPath: path.join(tmpDir(), 'beds-fired.jsonl'), readFileImpl: fsp.readFile });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /knjiga sprožitev: še ni je \(svež vklop\?\)/);
  });

  test('brez šivov ne lažemo: okno "nepreverjeno", nikoli izmišljen padec', async () => {
    const r = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherDaypart: { from: '06:00', to: '22:00' } } });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /okno vremena: nepreverjeno \(časovni bralnik ni podan\)/);
  });
});

// T. wheel (clockwheel) -- drop-and-count števke prihajajo iz bralnika (fika
// vrača oblike, kot jih vrača pravi clockwheelConfig)
describe('Val 26 doctor -- kolo (clockwheel)', () => {
  test('brez bralnika -> preskok', () => {
    assert.equal(checkWheel({}).status, STATUS.SKIP);
    assert.match(checkWheel({}).detail, /bralnik kolesa ni podan/);
  });

  test('null (izklopljen) -> ok z opombo o navadni rotaciji', () => {
    const r = checkWheel({ clockwheelConfigImpl: () => null });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /kolo izklopljen -- filler izbira skladbe po navadni rotaciji/);
  });

  test('zdravo kolo -> ok s številkami (koraki · dayparti · bazeni)', () => {
    const r = checkWheel({
      clockwheelConfigImpl: () => ({
        pools: { rock: { genres: ['rock'] }, klasika: { genres: ['classical'] } },
        steps: [{ pool: 'rock', count: 2 }, { pool: 'rotation', count: 3 }],
        dayparts: [{ fromMin: 420, toMin: 1320, steps: [{ pool: 'klasika', count: 1 }] }],
        droppedSteps: 0,
        droppedDayparts: 0,
      }),
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /2 koraka · 1 daypart · 2 bazena/);
    assert.ok(!('hint' in r) && !('fix' in r));
  });

  test('padli koraki in dayparti -> warn s frazno množino + fix fix-clockwheel', () => {
    const r = checkWheel({
      clockwheelConfigImpl: () => ({ pools: {}, steps: [], dayparts: [], droppedSteps: 1, droppedDayparts: 2 }),
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /1 korak je tiho padel \(vsak rabi pool \+ count > 0\)/);
    assert.match(r.detail, /2 dayparta sta tiho padla/);
    assert.deepEqual(r.fix, FIXES['fix-clockwheel']);
  });

  test('rezervirano ime "rotation" med bazeni -> warn "se IGNORIRA"', () => {
    const r = checkWheel({
      clockwheelConfigImpl: () => ({ pools: { rotation: { genres: ['x'] }, rock: {} }, steps: [{ pool: 'rock', count: 1 }], dayparts: [], droppedSteps: 0, droppedDayparts: 0 }),
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /bazen z imenom "rotation" je rezerviran in se IGNORIRA/);
  });

  test('korak v NEDOLOČEN bazen -> warn po imenu (walkWheel "if (!queue) continue")', () => {
    const r = checkWheel({
      clockwheelConfigImpl: () => ({
        pools: { rock: {} },
        steps: [{ pool: 'rock', count: 1 }, { pool: 'jazz', count: 2 }],
        dayparts: [{ fromMin: 420, toMin: 1320, steps: [{ pool: 'pop', count: 1 }] }],
        droppedSteps: 0,
        droppedDayparts: 0,
      }),
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /koraki kažejo na nedoločene bazene: "jazz", "pop"/);
  });

  test('bralnik vrže -> warn, doctor ne pade', () => {
    const r = checkWheel({ clockwheelConfigImpl: () => { throw new Error('kaboom'); } });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /bralnik kolesa je padel: kaboom/);
  });
});

// U. backup (rezervne kopije) -- starost iz IMENA datirane mape, ne mtime
describe('Val 26 doctor -- rezervne kopije', () => {
  const NOW = new Date(2026, 9, 26, 12).getTime();

  test('brez config.backup.dir -> preskok z opombo o DEPLOYMENT_GUIDE', async () => {
    const r = await checkBackup({ nowMs: NOW });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /config\.backup\.dir ni nastavljen/);
    assert.match(r.detail, /DEPLOYMENT_GUIDE/);
  });

  test('sveža kopija -> ok (starost od lokalne polnoči, številka, zadrževanje)', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '2026-10-25'), { recursive: true });
    fs.mkdirSync(path.join(dir, '2026-10-26'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'opombe.txt'), 'ni datirana mapa'); // ne šteje
    const r = await checkBackup({ backupDir: dir, backupIntervalMinutes: 1440, retentionDays: 30, nowMs: NOW });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /zadnja kopija 2026-10-26 \(pred 12 urami\)/);
    assert.match(r.detail, /2 kopiji/);
    assert.match(r.detail, /zadrževanje: 30 dni/);
  });

  test('stara kopija (čez 2x interval) -> warn "čez mejo" + fix check-scheduler', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '2026-10-20'), { recursive: true });
    const r = await checkBackup({ backupDir: dir, backupIntervalMinutes: 1440, nowMs: NOW });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /čez mejo -- pričakovana vsakih 24 h, dovoljena lenoba 48 h/);
    assert.deepEqual(r.fix, FIXES['check-scheduler']);
  });

  test('cilj obstaja, a datiranih map ni -> warn; cilj sploh ne obstaja -> warn "še nobena"', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'samo-datoteka.txt'), 'x');
    const noDated = await checkBackup({ backupDir: dir, nowMs: NOW });
    assert.equal(noDated.status, STATUS.WARN);
    assert.match(noDated.detail, /v cilju ni datiranih kopij/);
    const noDir = await checkBackup({ backupDir: path.join(tmpDir(), 'backups-nope'), nowMs: NOW });
    assert.equal(noDir.status, STATUS.WARN);
    assert.match(noDir.detail, /ne obstaja -- še nobena rezervna kopija/);
  });

  test('retentionDays šmetan -> warn "kopije se hranijo VSE" + fix fix-backup-config; 0 = večno (OK)', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '2026-10-26'), { recursive: true });
    const junk = await checkBackup({ backupDir: dir, retentionDays: -5, nowMs: NOW });
    assert.equal(junk.status, STATUS.WARN);
    assert.match(junk.detail, /backup\.retentionDays je nerazumljen -- kopije se hranijo VSE/);
    assert.deepEqual(junk.fix, FIXES['fix-backup-config']);
    const forever = await checkBackup({ backupDir: dir, retentionDays: 0, nowMs: NOW });
    assert.equal(forever.status, STATUS.OK);
    assert.match(forever.detail, /zadrževanje: večno/);
  });

  test('intervalMinutes šmetan -> privzeti 1440 (ogledalo cadence()), včerajšnja kopija še OK', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '2026-10-25'), { recursive: true });
    const r = await checkBackup({ backupDir: dir, backupIntervalMinutes: 'abc', nowMs: NOW });
    assert.equal(r.status, STATUS.OK); // starost 36 h < 48 h meje privzetega intervala
  });
});

// V. PRAVI šivi -- dokaz, da doctorji testi govorijo produkcijsko slovnico
describe('Val 26 doctor -- PRAVI šivi (dinamični uvoz po setupTestConfig)', () => {
  test('realSeams prinese PRAVE module: "24:00" senčilo, urnik odpuščujoč tam kjer je kolo strogo', async () => {
    const seams = await realSeams();
    assert.equal(typeof seams.parseWheelTime, 'function');
    assert.equal(seams.parseWheelTime('24:00'), 1440);
    assert.equal(seams.parseWheelTime('6:00'), null, 'kolo je strogo nič-polnjeno');
    assert.ok(seams.GENERATED_BED_RE instanceof RegExp);
    assert.equal(seams.GENERATED_BED_RE.test('weather_2026-10-26_10-15.mp3'), true);
    assert.equal(seams.GENERATED_BED_RE.test('nextshow_vecer_2026-10-26_19-55.mp3'), true);
    assert.equal(seams.GENERATED_BED_RE.test('moja_postelja.mp3'), false, 'operaterjeva imena so izven vzorca');
    assert.ok(Number.isNaN(seams.timeToMinutes('abc')));
    assert.equal(seams.timeToMinutes('6:00'), 360, 'URNIK sprejme "6:00" -- drugačna slovnica kot kolo, namerno');
    assert.equal(typeof seams.clockwheelConfig, 'function');
    assert.equal(seams.clockwheelConfig(), null, 'fixture config brez filler.clockwheel -> null, ne padec');
  });

  test('checkStation z REALIM timeToMinutes: "6:00" velja, "abc" ne (ogledalna toleranca)', async () => {
    const { timeToMinutes } = await realSeams();
    const dir = tmpDir();
    const stationFile = path.join(dir, 'station.json');
    fs.writeFileSync(stationFile, JSON.stringify({
      schedule: { monday: [{ id: 'a', startTime: '6:00' }, { id: 'b', startTime: 'abc' }] },
    }));
    const r = await checkStation({ stationFilePath: stationFile, readFileImpl: fsp.readFile, timeToMinutesImpl: timeToMinutes });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /1 pojavitev brez veljavnega id\/startTime -- ta oddaja nikoli ne bo terminirana/);
  });

  test('checkBeds z REALIM parseWheelTime: okno "6:00" je šmetano (stroga slovnica kolesa)', async () => {
    const { parseWheelTime } = await realSeams();
    const r = await checkBeds({ bedsEnabled: true, imagingBedsRaw: { weatherDaypart: { from: '6:00', to: '22:00' } }, parseWheelTimeImpl: parseWheelTime });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /nerazumljen -- okno ne velja, vreme teče ves dan/);
  });
});

// W. runDoctor sestava -- pet novih pod istim pokrovom
describe('Val 26 doctor -- runDoctor sestava (pet novih preverjanj)', () => {
  test('polna postaja (urnik + imaging + postelje + kolo + backup) -> 20 rezultatov, novi OK, determinizem', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.autoRadio.music.localDirs[0], { recursive: true });
    fs.writeFileSync(path.join(cfg.autoRadio.music.localDirs[0], 'a.mp3'), 'x');
    const clips = path.join(cfg.dataDir, 'voice-clips');
    fs.mkdirSync(clips);
    fs.writeFileSync(path.join(clips, 'open.wav'), 'x');
    fs.mkdirSync(path.join(cfg.dataDir, 'history'), { recursive: true });
    const entry = { ratingKey: 'rk', artist: 'A', title: 'T', album: 'L', durationMs: 1, showId: 'j', playedAt: '2026-10-25T08:00:00+02:00' };
    fs.writeFileSync(path.join(cfg.dataDir, 'history', 'aired.jsonl'), JSON.stringify(entry) + '\n');
    fs.writeFileSync(path.join(cfg.dataDir, 'now_playing.m3u'), '# trenutna\nskladba-1.mp3\n');
    // Val 28: izmerjeni prehodi v fillerju (0.5 = izmerjen hladni začetek).
    fs.writeFileSync(
      path.join(cfg.dataDir, 'filler.m3u'),
      'annotate:source_tag="music",liq_fade_in="0.5":/tmp/f1.mp3\n'
        + 'annotate:source_tag="music",liq_fade_in="2",liq_dissolve="1":/tmp/f2.mp3\n'
    );
    const logsDir = path.join(cfg.dataDir, 'logs');
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, 'station.log'), '[2026-10-25T11:00:00+02:00] ERROR ena sama, ne vzorec\n');

    // Val 26: postaja, kakršna je po valu 25 -- urnik, imaging, postelje, kolo, backup
    const nowMs = new Date(2026, 9, 26, 12).getTime();
    const stationFilePath = path.join(cfg.dataDir, 'station.json');
    fs.writeFileSync(stationFilePath, JSON.stringify({
      station: { name: 'Test Stanica' },
      schedule: {
        'monday,wednesday': [{ id: 'vecer', startTime: '20:00', durationMinutes: 60 }],
        friday: [{ id: 'jutro', startTime: '07:30', durationMinutes: 90 }],
      },
    }));
    const imagingDirs = {
      id: path.join(dir, 'imaging', 'id'), stingers: path.join(dir, 'imaging', 'stingers'),
      emergency: path.join(dir, 'imaging', 'emergency'), promos: path.join(dir, 'imaging', 'promos'),
    };
    const imagingM3us = {
      id: path.join(dir, 'imaging', 'id.m3u'), stingers: path.join(dir, 'imaging', 'stingers.m3u'),
      emergency: path.join(dir, 'imaging', 'emergency.m3u'), promos: path.join(dir, 'imaging', 'promos.m3u'),
    };
    fs.mkdirSync(imagingDirs.id, { recursive: true });
    fs.mkdirSync(imagingDirs.stingers, { recursive: true });
    fs.mkdirSync(imagingDirs.emergency, { recursive: true });
    fs.mkdirSync(imagingDirs.promos, { recursive: true });
    // Val 28 C2: 4 kipi na vedno-vklopljeni plasti (tanko vrtenje -> warn).
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(imagingDirs.id, `id${i}.mp3`), 'x');
      fs.writeFileSync(path.join(imagingDirs.stingers, `s${i}.mp3`), 'x');
    }
    fs.writeFileSync(path.join(imagingDirs.emergency, 'e1.wav'), 'x');
    fs.writeFileSync(path.join(imagingDirs.promos, 'promo_vecer_2026-10-26_18-00.mp3'), 'x');
    const m3uLine = (tag, file) => `annotate:source_tag="${tag}",liq_fade_in="0":${file}\n`;
    fs.writeFileSync(imagingM3us.id, m3uLine('id', '/tmp/a.mp3'));
    fs.writeFileSync(imagingM3us.stingers, m3uLine('stinger', '/tmp/s.mp3'));
    fs.writeFileSync(imagingM3us.emergency, m3uLine('emergency', '/tmp/e.wav'));
    fs.writeFileSync(imagingM3us.promos, m3uLine('promo', '/tmp/p.mp3'));
    const bedsDir = path.join(cfg.dataDir, 'beds');
    fs.mkdirSync(bedsDir);
    const freshBed = path.join(bedsDir, 'weather_2026-10-26_11-15.mp3');
    fs.writeFileSync(freshBed, 'x');
    fs.utimesSync(freshBed, new Date(nowMs - 30 * 60_000), new Date(nowMs - 30 * 60_000));
    const bedsLedgerPath = path.join(cfg.dataDir, 'history', 'beds-fired.jsonl');
    fs.writeFileSync(bedsLedgerPath, JSON.stringify({ key: 'k1' }) + '\n');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(path.join(backupDir, '2026-10-25'), { recursive: true });
    fs.mkdirSync(path.join(backupDir, '2026-10-26'), { recursive: true });

    const seams = await realSeams();
    const readFileImpl = async (file, enc) => {
      if (file === '/proc/loadavg') return '0.10 0.10 0.05 1/100 12345\n';
      if (file === '/proc/meminfo') return 'MemTotal:       16777216 kB\nMemAvailable:   8388608 kB\n';
      return fsp.readFile(file, enc);
    };
    const healthyWheel = () => ({
      pools: { rock: { genres: ['rock'] } },
      steps: [{ pool: 'rock', count: 2 }, { pool: 'rotation', count: 3 }],
      dayparts: [],
      droppedSteps: 0,
      droppedDayparts: 0,
    });
    const inputs = () => ({
      configOrError: cfg,
      netProbe: false,
      nowMs,
      fetchImpl: async () => ({ status: 200 }),
      sendCommandImpl: async () => { throw new Error('connect ECONNREFUSED'); }, // mrtva miza -> warn z fixom
      readFileImpl,
      statfsImpl: fakeStatfs(50 * GB),
      nowPlayingPath: path.join(cfg.dataDir, 'now_playing.m3u'),
      fillerPath: path.join(cfg.dataDir, 'filler.m3u'),
      archiveRoot: path.join(cfg.dataDir, 'archive'),
      archiveEnabled: true,
      logsDir,
      icecastUrl: 'http://localhost:8001/status-json.xsl',
      telnetPort: 1234,
      stationFilePath,
      imagingDirs,
      imagingM3us,
      promosEnabled: true,
      bedsEnabled: true,
      imagingBedsRaw: { weatherMinutes: [15, 45], weatherDaypart: { from: '06:00', to: '22:00' } },
      bedsDir,
      bedsLedgerPath,
      backupDir,
      backupIntervalMinutes: 1440,
      retentionDays: 30,
      parseWheelTimeImpl: seams.parseWheelTime,
      generatedBedRe: seams.GENERATED_BED_RE,
      timeToMinutesImpl: seams.timeToMinutes,
      clockwheelConfigImpl: healthyWheel,
    });

    const report = await runDoctor(inputs());
    assert.equal(report.results.length, 20);
    assert.deepEqual(report.results.map((r) => r.id), CHECK_ORDER.map((c) => c.id));
    assert.equal(report.exitCode, 0); // opozorilo (mrtva miza), ne napaka
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    // Val 33: ta postaja nima daypartProsody -> tempo pošteni preskok (ista
    // OPT-IN disciplina kot beds: izklopljeno je podprto stanje)
    assert.equal(byId.tempo.status, STATUS.SKIP);
    assert.match(byId.tempo.detail, /ni nastavljen/);
    assert.equal(byId.station.status, STATUS.OK);
    assert.match(byId.station.detail, /2 terminirani oddaji na teden/);
    assert.equal(byId.imaging.status, STATUS.OK);
    assert.match(byId.imaging.detail, /ID-ji \(polna ura\): 4/);
    assert.match(byId.imaging.detail, /promosi: 1 \(vklopljeni\)/);
    assert.equal(byId.prehodi.status, STATUS.OK);
    assert.match(byId.prehodi.detail, /2\/2 vnosa nosi izmerjene prehode \(100 %\)/);
    assert.match(byId.prehodi.detail, /dissolve 1/);
    assert.match(byId.prehodi.detail, /2\.4\.6\+/);
    assert.equal(byId.beds.status, STATUS.OK);
    assert.match(byId.beds.detail, /vreme ob: 15, 45/);
    assert.match(byId.beds.detail, /okno vremena: 06:00-22:00/);
    assert.match(byId.beds.detail, /knjiga sprožitev: 1/);
    assert.equal(byId.wheel.status, STATUS.OK);
    assert.match(byId.wheel.detail, /2 koraka · 0 daypartov · 1 bazen/);
    assert.equal(byId.backup.status, STATUS.OK);
    assert.match(byId.backup.detail, /zadnja kopija 2026-10-26/);
    assert.match(byId.backup.detail, /zadrževanje: 30 dni/);
    // Finding model: hint/fix nosijo SAMO opozorila (edino opozorilo je mrtva miza)
    for (const r of report.results) {
      if (r.status === 'warn') {
        assert.equal(typeof r.hint, 'string', `${r.id}: opozorilo potrebuje namig`);
        assert.ok(r.hint.length > 0);
      } else {
        assert.ok(!('hint' in r) && !('fix' in r), `${r.id}: ok/skip brez namiga in popravka`);
      }
    }
    // determinizem: isti vhodi -> bajtno isti izpis
    const report2 = await runDoctor(inputs());
    assert.deepEqual(JSON.parse(JSON.stringify(report2.results)), JSON.parse(JSON.stringify(report.results)));
    assert.equal(report2.verdict, report.verdict);
  });
});

// ---- P5-odpri: cron vzorec (src/lib/cronVzorec.js) -- čista matematika iz urnika ----
import {
  distinctScheduleStarts,
  shiftedCronTime,
  cronSlotsForSchedule,
  cronVzorecText,
} from '../src/lib/cronVzorec.js';

describe('distinctScheduleStarts', () => {
  test('zbira vsak DISTINCT začetek z množico dni (dow številke)', () => {
    const starts = distinctScheduleStarts({
      monday: [{ startTime: '20:00' }],
      wednesday: [{ startTime: '20:00' }],
      friday: [{ startTime: '07:30' }],
    });
    assert.deepEqual(starts, [
      { startTime: '07:30', dows: [5] },
      { startTime: '20:00', dows: [1, 3] },
    ]);
  });

  test('razširi vejica-ključe ("monday,tuesday") kot loadSchedule()', () => {
    const starts = distinctScheduleStarts({
      'monday,tuesday,wednesday': [{ startTime: '08:00' }],
    });
    assert.deepEqual(starts, [{ startTime: '08:00', dows: [1, 2, 3] }]);
  });

  test('preskoči neznane dni in pokvarjene čase, ne pada', () => {
    const starts = distinctScheduleStarts({
      nedelja: [{ startTime: '09:00' }], // slovensko ime -- ni cron ključ
      saturday: [{ startTime: 'brez-uri' }, {}], // pokvarjeni vnosi -- preskočeni
      sunday: [{ startTime: '09:00' }],
    });
    assert.deepEqual(starts, [{ startTime: '09:00', dows: [0] }]);
  });

  test('prazen/nedefiniran urnik -> prazen seznam', () => {
    assert.deepEqual(distinctScheduleStarts({}), []);
    assert.deepEqual(distinctScheduleStarts(undefined), []);
  });
});

describe('shiftedCronTime', () => {
  test('odšteje minutesBefore znotraj istega dne', () => {
    assert.deepEqual(shiftedCronTime('20:00', 15), { hour: 19, minute: 45, dayShift: 0 });
  });

  test('prečkaje polnoči pade na PREJŠNJI dan (dayShift -1)', () => {
    // ponedeljkov termin 00:05 ima doctor že ob 23:50 v nedeljo
    assert.deepEqual(shiftedCronTime('00:05', 15), { hour: 23, minute: 50, dayShift: -1 });
    assert.deepEqual(shiftedCronTime('00:00', 15), { hour: 23, minute: 45, dayShift: -1 });
  });

  test('minutesBefore=0 ne premakne ničesar; privzeto je 15', () => {
    assert.deepEqual(shiftedCronTime('10:00', 0), { hour: 10, minute: 0, dayShift: 0 });
    assert.deepEqual(shiftedCronTime('10:15', undefined), { hour: 10, minute: 0, dayShift: 0 });
  });

  test('neveljaven čas vrže slovensko napako', () => {
    assert.throws(() => shiftedCronTime('XX:YY', 15), /Neveljaven začetek termina/);
  });
});

describe('cronSlotsForSchedule', () => {
  test('združi iste ure v eno vrstico z združenim dayField', () => {
    // distinctScheduleStarts deduplicira enako uro v EN vnos z dows [1,3] --
    // zato je startTimes eno-, dayField pa dvodnišen
    const slots = cronSlotsForSchedule({
      monday: [{ startTime: '20:00' }],
      wednesday: [{ startTime: '20:00' }],
    });
    assert.deepEqual(slots, [{ hour: 19, minute: 45, dayField: '1,3', startTimes: ['20:00'] }]);
  });

  test('različni začetki isti dan -> dve ločeni vrstici (vzorec je po urah)', () => {
    const slots = cronSlotsForSchedule({
      tuesday: [{ startTime: '20:00' }, { startTime: '19:50' }],
    });
    assert.deepEqual(slots, [
      { hour: 19, minute: 35, dayField: '2', startTimes: ['19:50'] },
      { hour: 19, minute: 45, dayField: '2', startTimes: ['20:00'] },
    ]);
  });

  test('termini tik za polnočjo premaknejo dow za en dan nazaj', () => {
    // ponedeljek 00:05 -> doctor v nedeljo 23:50 (dow 1 -> 0)
    const slots = cronSlotsForSchedule({ monday: [{ startTime: '00:05' }] });
    assert.deepEqual(slots, [{ hour: 23, minute: 50, dayField: '0', startTimes: ['00:05'] }]);
  });

  test('polni teden (vseh 7 dni) se strne v dayField "*"', () => {
    const schedule = {};
    for (const day of ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']) {
      schedule[day] = [{ startTime: '09:00' }];
    }
    const slots = cronSlotsForSchedule(schedule);
    assert.deepEqual(slots, [{ hour: 8, minute: 45, dayField: '*', startTimes: ['09:00'] }]);
  });

  test('izhod je deterministično sortiran (enak klic -> enake bajte)', () => {
    const schedule = {
      friday: [{ startTime: '22:00' }],
      monday: [{ startTime: '07:00' }],
      saturday: [{ startTime: '09:30' }],
    };
    const a = cronSlotsForSchedule(schedule);
    const b = cronSlotsForSchedule(schedule);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((s) => `${s.hour}:${s.minute}`), ['6:45', '9:15', '21:45']);
  });
});

describe('cronVzorecText', () => {
  test('izpiše pripravljene crontab vrstice s slovenskimi komentarji', () => {
    const text = cronVzorecText(
      { monday: [{ startTime: '20:00' }] },
      { minutesBefore: 15, repoRoot: '/repo', logFile: '/data/doctor-cron.log' }
    );
    assert.match(text, /# termin: 20:00/);
    assert.match(text, /45 19 \* \* 1 \/bin\/bash -lc 'cd \/repo && node src\/cli\/doctorCli\.js >> \/data\/doctor-cron\.log 2>&1'/);
    assert.match(text, /# Doctor pred vsako terminirano uro/);
  });

  test('vzorec kaže na doctor CLI, ki RES obstaja (varovalka proti preimenovanju)', () => {
    // Polirni popravek: vzorec je enkrat kazal na izbrisan src/cli/doctor.js --
    // crontab vrstica bi strmoglavila s "Cannot find module" TOČKO, ko jo
    // operater najbolj potrebuje. Modul ostane čist (brez fs), test pa
    // preveri, da pot v vzorcu dejansko kaže na datoteko v repozitoriju.
    const text = cronVzorecText({ monday: [{ startTime: '20:00' }] }, { repoRoot: '/repo', logFile: '/l.log' });
    const match = text.match(/node (src\/cli\/[\w.]+\.js)/);
    assert.ok(match, 'vzorec mora vsebovati node <pot-do-cli>');
    const referenced = path.resolve(REPO_ROOT, match[1]);
    assert.ok(fs.existsSync(referenced), `vzorec kaže na neobstoječo datoteko: ${match[1]}`);
  });

  test('prazen urnik -> poštena opomba, ne prazna črna vrstica', () => {
    const text = cronVzorecText({}, {});
    assert.match(text, /urnik je prazen/);
  });

  test('isti urnik -> bajtno identičen vzorec', () => {
    const schedule = { monday: [{ startTime: '20:00' }], friday: [{ startTime: '08:00' }] };
    assert.equal(cronVzorecText(schedule), cronVzorecText(schedule));
  });
});

// ---- Val 33: dnevni profili govora -- tempo ----------------------------------
// X. checkVoiceDaypart: resolucija daypartProsody je fail-open povsod
//    (rules.js daypartProsodyProfile pogoltne neznana imena blokov, šmetane
//    oblike in neznane gumbe TIHO) -- tu vsaka od teh tihih napak dobi glas
//    PRED oddajo. timeBlocks je INJEKTIRAN šiv: pravi bralnik (rules.js)
//    pride iz CLI-ja, kot pri vseh Val 26 šivih; brez njega pošten preskok.
const VAL33_BLOCKS = {
  morning: { start: '05:00', end: '10:00' },
  daytime: { start: '10:00', end: '17:00' },
  evening: { start: '17:00', end: '23:00' },
  night: { start: '23:00', end: '05:00' },
};

describe('Val 33 doctor -- tempo (dnevni profili govora)', () => {
  test('brez daypartProsody -> preskok z opombo, kje ga vklopiš (izklopljeno je podprto stanje)', () => {
    const r = checkVoiceDaypart({});
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /ni nastavljen/);
    assert.ok(!('hint' in r) && !('fix' in r), 'preskok brez namiga in popravka');
  });

  test('prazen objekt -> preskok (ne napaka: izklopljeno)', () => {
    const r = checkVoiceDaypart({ daypartProsody: {}, timeBlocks: VAL33_BLOCKS });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /je prazen/);
  });

  test('šmetana oblika (tabela / niz / številka) -> opozorilo s popravkom', () => {
    for (const junk of [['morning'], 'morning', 42]) {
      const r = checkVoiceDaypart({ daypartProsody: junk, timeBlocks: VAL33_BLOCKS });
      assert.equal(r.status, STATUS.WARN);
      assert.match(r.detail, /nerazumljive oblike/);
      assert.deepEqual(r.fix, FIXES['fix-daypart-prosody']);
    }
  });

  test('brez bralnika blokov -> pošten preskok (doctor ne ugiba imen blokov)', () => {
    const r = checkVoiceDaypart({ daypartProsody: { morning: { edgeRate: '-3%' } } });
    assert.equal(r.status, STATUS.SKIP);
    assert.match(r.detail, /bralnik dnevnih delov/);
  });

  test('neznan ključ -> opozorilo: profil se nikoli ne izbere, imena blokov v detailu', () => {
    const r = checkVoiceDaypart({ daypartProsody: { jutro: { edgeRate: '-3%' } }, timeBlocks: VAL33_BLOCKS });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /neznan ključ jutro/);
    assert.match(r.detail, /morning, daytime, evening, night/);
    assert.deepEqual(r.fix, FIXES['fix-daypart-prosody']);
  });

  test('neznan gumb v profilu -> opozorilo (tiho brez učinka)', () => {
    const r = checkVoiceDaypart({ daypartProsody: { morning: { rate: '-3%' } }, timeBlocks: VAL33_BLOCKS });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /neznan gumb rate/);
    assert.deepEqual(r.fix, FIXES['fix-daypart-prosody']);
  });

  test('šmetan profil enega bloka -> opozorilo; zdravi bloki ostanejo v povzetku', () => {
    const r = checkVoiceDaypart({
      daypartProsody: { morning: '-3%', night: { edgeRate: '-11%' } },
      timeBlocks: VAL33_BLOCKS,
    });
    assert.equal(r.status, STATUS.WARN);
    assert.match(r.detail, /profil morning je nerazumljive oblike/);
    assert.match(r.detail, /night \(edgeRate\)/);
  });

  test('zdrav profil -> OK s povzetkom gumbov po blokih, brez namiga/popravka', () => {
    const r = checkVoiceDaypart({
      daypartProsody: { morning: { edgeRate: '-3%' }, night: { edgeRate: '-11%', piperLengthScale: 1.15 }, evening: {} },
      timeBlocks: VAL33_BLOCKS,
    });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /morning \(edgeRate\)/);
    assert.match(r.detail, /night \(edgeRate, piperLengthScale\)/);
    assert.match(r.detail, /evening \(prazen profil\)/);
    assert.ok(!('hint' in r) && !('fix' in r), 'OK brez namiga in popravka');
  });

  test('runDoctor žica: configOk + injekciji -> vrstica tempo v zamrznjenem redu', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const report = await runDoctor({
      configOrError: cfg,
      netProbe: false,
      daypartProsody: { night: { edgeRate: '-11%' } },
      timeBlocks: VAL33_BLOCKS,
    });
    const r = report.results.find((x) => x.id === 'tempo');
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /night \(edgeRate\)/);
    // identiteta: label se ujema s CHECK_ORDER (izpis cron/monitoringa)
    const entry = CHECK_ORDER.find((c) => c.id === 'tempo');
    assert.equal(r.label, entry.label);
  });

  test('doctorCli izpeljavi: surova vrednost + PRAVI bralnik blokov (strukturni pini)', () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'doctorCli.js'), 'utf8');
    assert.match(cli, /daypartProsody: configOk \? configOrError\.autoRadio\?\.voice\?\.daypartProsody \?\? null : null/);
    assert.match(cli, /timeBlocks: timeBlocksImpl \? timeBlocksImpl\(\) : null/);
    assert.match(cli, /await import\('\.\.\/auto\/rules\.js'\)/);
  });
});

