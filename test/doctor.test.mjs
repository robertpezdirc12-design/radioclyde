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
//   I. FIXES zaprt nabor {id,label} + CHECK_ORDER 13 vnosov (zamrznjeno),
//   J. icecast: vsak HTTP odgovor -> ok, mrtva povezava -> warn + fix,
//   K. liquidsoap: živ "uptime" -> ok z izrezkom, napaka/prazno/ERROR -> warn,
//   L. m3u: štetje ne-komentar vrstic, obe prazni -> warn (nujni seznam),
//   M. storage: arhiv 20 GB meja (NAD, ne NA), disk 2 GB meja, statfs izpust,
//   N. host: load1/mem meje, /proc neberljiv -> preskok,
//   O. errors: sveže/stare/nečasovne/.log.1 vrstice, 21+ -> warn,
//   P. runDoctor sestava: šest preskokov ob zlomljenem configu, polna
//      injekcija -> 13 rezultatov, hint/fix SAMO na opozorilih, determinizem.
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
  orderResults,
  doctorExitCode,
  doctorVerdict,
  runDoctor,
  slPlural,
} from '../src/auto/doctor.js';

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

describe('P4 #31 doctor -- config', () => {
  test('healthy enabled config -> ok with station name', () => {
    const r = checkConfig({ stationName: 'Radio Markec', autoRadio: { enabled: true } });
    assert.equal(r.status, STATUS.OK);
    assert.match(r.detail, /Radio Markec/);
  });

  test('import Error -> fail carrying the message', () => {
    const r = checkConfig(new Error('config.json not found'));
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.detail, /config\.json not found/);
  });

  test('disabled or missing autoRadio block -> warn (main channel still works)', () => {
    assert.equal(checkConfig({ autoRadio: { enabled: false } }).status, STATUS.WARN);
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

  test('broken config -> config fail, dependent checks skip, corpus STILL ok, exit 1', async () => {
    const report = await runDoctor({ configOrError: new Error('config.json not found'), netProbe: false });
    assert.equal(report.exitCode, 1);
    assert.equal(report.results.find((r) => r.id === 'config').status, 'fail');
    for (const id of ['dataDir', 'tts', 'library', 'ledger']) {
      assert.equal(report.results.find((r) => r.id === id).status, 'skip', id);
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
  test('FIXES je ZAPRT nabor {id, label} z nepraznimi nizi in zamrznjenimi id-ji', () => {
    assert.deepEqual(Object.keys(FIXES), [
      'check-icecast', 'restart-liquidsoap', 'regenerate-filler', 'prune-archives', 'free-disk', 'inspect-logs',
    ]);
    for (const [id, fix] of Object.entries(FIXES)) {
      assert.equal(fix.id, id, 'id se mora ujemati s ključem');
      assert.equal(typeof fix.label, 'string');
      assert.ok(fix.label.length > 0, `label za ${id} ne sme biti prazna`);
      assert.deepEqual(Object.keys(fix).sort(), ['id', 'label']);
    }
  });

  test('CHECK_ORDER ima 13 vnosov v zamrznjenem redu (starih 7 + novih 6 za viri)', () => {
    assert.deepEqual(CHECK_ORDER.map((c) => c.id), [
      'config', 'dataDir', 'tts', 'library', 'ledger', 'corpus', 'feeds',
      'icecast', 'liquidsoap', 'm3u', 'storage', 'host', 'errors',
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
  test('zlomljen config -> vseh šest novih preskoči z istim vzorcem "config ni berljiv"', async () => {
    const report = await runDoctor({ configOrError: new Error('config.json not found'), netProbe: false });
    for (const id of ['icecast', 'liquidsoap', 'm3u', 'storage', 'host', 'errors']) {
      const r = report.results.find((x) => x.id === id);
      assert.equal(r.status, STATUS.SKIP, id);
      assert.match(r.detail, /preskočeno -- config ni berljiv/, id);
    }
  });

  test('brez injekcij -> šest poštenih preskokov (nobenega pravega omrežja, /proc ali statfs)', async () => {
    const dir = tmpDir();
    const cfg = healthyConfig(dir);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const report = await runDoctor({ configOrError: cfg, netProbe: false });
    const ids = ['icecast', 'liquidsoap', 'm3u', 'storage', 'host', 'errors'];
    for (const id of ids) {
      assert.equal(report.results.find((r) => r.id === id).status, STATUS.SKIP, id);
    }
    assert.match(report.results.find((r) => r.id === 'host').detail, /bralnik \/proc ni podan/);
    assert.match(report.results.find((r) => r.id === 'icecast').detail, /config\.icecast ni nastavljen/);
  });

  test('polna injekcija -> 13 rezultatov v zamrznjenem redu, hint/fix SAMO na opozorilih, determinizem', async () => {
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
    fs.writeFileSync(path.join(cfg.dataDir, 'filler.m3u'), 'filler-1.mp3\nfiller-2.mp3\nfiller-3.mp3\n');
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
    });

    const report = await runDoctor(inputs());
    assert.deepEqual(report.results.map((r) => r.id), CHECK_ORDER.map((c) => c.id));
    assert.equal(report.exitCode, 0); // opozorilo, ne napaka
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    assert.equal(byId.config.status, 'ok');
    assert.equal(byId.icecast.status, 'ok');
    assert.equal(byId.liquidsoap.status, 'warn');
    assert.equal(byId.m3u.status, 'ok');
    assert.equal(byId.storage.status, 'ok');
    assert.equal(byId.host.status, 'ok');
    assert.equal(byId.errors.status, 'ok');
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

