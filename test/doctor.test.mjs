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
// No test touches the network -- fetchImpl is always stubbed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  STATUS,
  CHECK_ORDER,
  CORPUS_FLOORS,
  checkConfig,
  checkDataDir,
  checkTts,
  checkLibrary,
  checkLedger,
  checkCorpora,
  checkFeeds,
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

