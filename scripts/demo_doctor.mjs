// Živi demo P4 #31 -- predvečerna diagnostika (doctor). Izpiše tri teke:
//   1. ZDRAV peskovnik (tmp dataDir, ena skladba, svež ledger, klipi) --
//      pričakovano: brez napak, opozorili le tam, kjer je iskrenost (piper
//      glasba še ni prenesena; omrežni viri preskočeni brez --net),
//   2. POKVARJEN peskovnik (config kaže na DATOTEKO namesto mape + pokvarjen
//      ledger + prazni klipi) -- pričakovano: NAPAKA + exit 1,
//   3. ZLOMLJEN config (Error prek checkConfig) -- korpusi vseeno OK, ker
//      so del kode; doctor poroča exit 1 brez padca.
// Vse deterministično (fiksni nowMs), brez omrežja (netProbe=false).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { runDoctor } = await import('../src/auto/doctor.js');

const NOW_MS = Date.parse('2026-10-25T12:00:00+02:00');

function healthySandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-demo-zdrav-'));
  const dataDir = path.join(root, 'data');
  const lib = path.join(root, 'glasba');
  const clips = path.join(dataDir, 'voice-clips');
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(clips, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'ansambel-LOJZOVCI-01.mp3'), 'x');
  fs.writeFileSync(path.join(clips, 'open.wav'), 'x');
  const entry = {
    ratingKey: 'rk-demo', artist: 'Alfi Nipič', title: 'Zadnja štala',
    album: 'Vrni se na staro železniško postajo', durationMs: 189000,
    showId: 'jutro', playedAt: '2026-10-25T07:58:12+02:00',
  };
  fs.writeFileSync(path.join(dataDir, 'history', 'aired.jsonl'), JSON.stringify(entry) + '\n');
  return {
    dataDir,
    stationName: 'Radio Markec (demo)',
    autoRadio: {
      enabled: true,
      music: { source: 'local', localDirs: [lib], audioExtensions: ['.mp3'] },
      voice: { mode: 'piper', defaultPiperVoice: 'sl_SI-artur-medium' },
    },
  };
}

function brokenSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-demo-zlom-'));
  const notADir = path.join(root, 'ta-datoteka-ni-mapa');
  fs.writeFileSync(notADir, 'tukaj je vsebina, ne mapa');
  const history = path.join(root, 'druga-data', 'history');
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(
    path.join(history, 'aired.jsonl'),
    '{"pokvarjena":\n{"ratingKey":"rk","artist":"A","title":"T","album":"L","durationMs":1,"showId":"j","playedAt":"2026-10-20T08:00:00+02:00"}\n',
  );
  return {
    dataDir: notADir, // NAPAKA: kaže na datoteko
    stationName: 'Radio Markec (zlom demo)',
    autoRadio: {
      enabled: true,
      music: { source: 'local', localDirs: [path.join(root, 'ni-je')], audioExtensions: ['.mp3'] },
      voice: { mode: 'clips', clipsDir: 'voice-clips' },
    },
  };
}

function marker(status) {
  return { ok: 'OK    ', warn: 'OPZ   ', fail: 'NAPAKA', skip: 'PRESK ' }[status] ?? status;
}

function render(report) {
  for (const r of report.results) {
    console.log(`  ${marker(r.status)} ${r.label.padEnd(26)} ${r.detail}`);
  }
  console.log(`  Sklep: ${report.verdict}`);
  console.log(`  Exit code: ${report.exitCode}`);
}

console.log('═'.repeat(78));
console.log('DEMO 1/3 -- zdrav peskovnik (piper glasba še ni prenesena: iskreno OPZ, ne laži)');
console.log('═'.repeat(78));
const zdrav = await runDoctor({ configOrError: healthySandbox(), nowMs: NOW_MS });
render(zdrav);

console.log();
console.log('═'.repeat(78));
console.log('DEMO 2/3 -- pokvarjen peskovnik (dataDir = datoteka, pokvarjen ledger, prazni klipi)');
console.log('═'.repeat(78));
const zlom = await runDoctor({ configOrError: brokenSandbox(), nowMs: NOW_MS });
render(zlom);

console.log();
console.log('═'.repeat(78));
console.log('DEMO 3/3 -- zlomljen config.json (Error) -- korpusi vseeno OK, doctor NE pade');
console.log('═'.repeat(78));
const brez = await runDoctor({ configOrError: new Error('config.json not found at ...'), nowMs: NOW_MS });
render(brez);
