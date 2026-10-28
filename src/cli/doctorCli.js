#!/usr/bin/env node
// Predvečerna diagnostika (P4 #31) -- EN ukaz, ki operaterju PRED terminirano
// uro pove, ali bo oddaja preživela: konfiguracija, podatkovna mapa, govor,
// knjižnica, ledger, korpusi, (z --net) dostopnost virov IN šest SUB/WAVE
// preverjanj (4-c): icecast (oddajnik), liquidsoap (telnet), predvajalne
// liste, shramba (arhiv/disk), gostitelj (CPU/spomin) in dnevnik napak
// (24 h). Opozorila teh šestih nosijo tudi »namig« (kje poglej) in »popravi«
// (kaj stori) -- Finding model SUB/WAVE, izpisan pod vrstico najdenja.
//
// Val 26 (doktor dohiti postajo): PET novih preverjanj za površino, ki je
// zrasla po SUB/WAVE valu in bralci namenoma tiho odpustijo napake --
// urnik (station.json: pokvarjen JSON, ne-seznami, slabi datumski prepiši,
// pojavitve brez veljavnega časa), imaging plasti (kipi v mapah IN etrne
// m3u datoteke, promosi OPT-IN), formatna ura (F2 gumbi postelj, pometanje
// generiranih kipov, knjiga sprožitev), kolo (clockwheel drop-and-count)
// in rezervne kopije (starost najnovejše datirane mape).
//
//   npm run doctor [-- --net] [-- --json] [-- --cron [--minutes-before=15]]
//
// --net   sproži omrežne preverjanje virov (ARSO, RTV x2, Wikidata, Open-Meteo)
//         s kratkim časovnim zamikom; mrtvi vir je OPOZORILO, ne napaka --
//         točno tako kot v programu (P4 #28–#30: rubrika poje pošteno vrstico,
//         radio igra dalje). Brez --net je ta blok označen kot preskočen.
//         (Icecast/liquidsoap sondi NE gresta pod --net: to sta LAN storitvi
//         postaje same -- njun padec je ravno tisto, kar moraš izvedeti
//         obvezno, ne opcijsko.)
// --json  strojni izpis (ena sam JSON objekt na stdout) za cron/monitoring;
//         rezultati grejo skozi nespremenjeni (hint/fix prisotata sama, kjer
//         ju preverjanje nosi).
// --cron  ne sondira ničesar: iz station.json izračuna crontab vzorec -- vsak
//         DISTINCT začetek termina dobi en predhodni pregled (privzeto
//         --minutes-before=15). Čista matematika živi v src/lib/cronVzorec.js
//         (prečkaje polnoči premakne dan-of-teden nazaj; polni teden se strne
//         v *). Urnik spremeniš -> poženi --cron -> prilepi v crontab -e.
//
// Zakaj dinamičen import configa: zlomljen config.json je STANJE, ki ga
// doctor mora sporočiti -- statičen import bi pomenil crash pred prvo
// vrstico izpisa. Z try/catch ga ujamemo in ga kot NAPAKO poročamo
// prek checkConfig(Error), ostale preverjanja pa korektno preskočimo.
// IZJEMA telnetClient (spodaj): tudi on potegne config na vrhu, zato ga
// uvozimo dinamično ŠELE, ko je config prebrano, pod istim try/catch duhom.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { parseArgs } from '../lib/args.js';

const args = parseArgs(process.argv.slice(2));
const netProbe = Boolean(args.net);
const asJson = Boolean(args.json);

const statusMarker = { ok: 'OK', warn: 'OPZ', fail: 'NAPAKA', skip: 'PRESK' };

function renderHuman({ results, verdict }) {
  const lines = [];
  lines.push('Radio Markec -- predvečerna diagnostika');
  lines.push('='.repeat(60));
  for (const r of results) {
    const marker = (statusMarker[r.status] ?? r.status).padEnd(6, ' ');
    lines.push(`  ${marker} ${r.label.padEnd(24, ' ')} ${r.detail}`);
    // Finding model (SUB/WAVE 4-c): namig pove, KJE poglej, popravi pa KAJ
    // stori. Izpisana samo, če ju najdenje res nosi -- stara preverjanja in
    // vsi ok/skip rezultati ostanejo brez podvrstic, enako kot doslej.
    if (r.hint) lines.push(`    namig: ${r.hint}`);
    if (r.fix) lines.push(`    popravi: ${r.fix.label}`);
  }
  lines.push('='.repeat(60));
  lines.push(`Sklep: ${verdict}`);
  return lines.join('\n');
}

let configOrError = null;
try {
  configOrError = (await import('../config/index.js')).config;
} catch (err) {
  configOrError = err instanceof Error ? err : new Error(String(err));
}

// --cron mode: čista izpeljava iz urnika, brez sond, exit 0 ob uspehu.
if (args.cron) {
  if (configOrError instanceof Error) {
    console.error(`[NAPAKA] config.json ni uporaben: ${configOrError.message}`);
    process.exit(1);
  }
  const minutesBefore = Number.isFinite(parseInt(args['minutes-before'], 10))
    ? parseInt(args['minutes-before'], 10)
    : 15;
  const { loadSchedule } = await import('../scheduler/scheduleUtil.js');
  const { cronVzorecText } = await import('../lib/cronVzorec.js');
  const { fileURLToPath } = await import('node:url');
  // node:path je zdaj statičen uvoz z vrha (jedrni modul nikoli ne seseta
  // izpisa); tukaj ga le uporabimo, kot prej.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let schedule = {};
  try {
    schedule = loadSchedule();
  } catch (err) {
    console.error(`[NAPAKA] station.json ni uporaben: ${err.message}`);
    process.exit(1);
  }
  process.stdout.write(
    cronVzorecText(schedule, {
      minutesBefore,
      repoRoot,
      logFile: path.join(configOrError.dataDir, 'doctor-cron.log'),
    })
  );
  process.exit(0);
}

// Izpeljava configa za šest novih preverjanj živi TU, ne v doctor.js -- modul
// doctorja ostane brez configa (pravilo z vrha tega komentarja), da teče
// tudi z zlomljenim config.json. Vsaka izpeljava zrcali svoj izvir, da se
// poti nikoli ne razidejo (en vir resnice na stran):
//   nowPlayingPath/fillerPath == config.paths (src/config/index.js)
//   archiveRoot              == archiveDir() (src/server/studioArchivesApi.js)
//   logsDir                  == config.paths.logsDir (src/lib/logger.js)
//   icecastUrl               == getListenerCount() (src/icecast/listeners.js)
//   telnetPort               == config.liquidsoap.telnetPort (telnetClient.js)
//   archiveEnabled           == archiveEnabled() (src/liquidsoap/streamsLiqWriter.js,
//                              strogo === true, da tipkana vrednost ne prižige sonde)
const configOk = !(configOrError instanceof Error) && configOrError && typeof configOrError === 'object';
const dataDir = configOk ? configOrError.dataDir : null;
const icecast = configOk ? configOrError.icecast : null;
const doctorInputs = {
  nowPlayingPath: dataDir ? path.join(dataDir, 'now_playing.m3u') : null,
  fillerPath: dataDir ? path.join(dataDir, 'filler.m3u') : null,
  archiveRoot: dataDir ? path.join(dataDir, 'archive') : null,
  logsDir: dataDir ? path.join(dataDir, 'logs') : null,
  icecastUrl: icecast?.sourceHost && icecast?.port
    ? `http://${icecast.sourceHost}:${icecast.port}/status-json.xsl`
    : null,
  telnetPort: configOk ? configOrError.liquidsoap?.telnetPort ?? null : null,
  archiveEnabled: configOk ? configOrError.archive?.enabled === true : false,
  // Val 26: izpeljave petih dohitevanj. Vsaka zrcali svoj izvir, da se poti
  // nikoli ne razidejo (en vir resnice na stran):
  //   stationFilePath  == config.paths.stationFile (scheduleUtil.js readStationFile)
  //   imagingDirs/M3us == config.paths.imaging* (scheduler/imagingPlaylists.js)
  //   promos/beds      == config.imaging (strog === true, OPT-IN discipline)
  //   beds* poti        == config.paths.bedsDir/bedsFiredLedgerFile (formatClock.js)
  //   backup*          == config.backup (backupStation.js; raw vrednosti,
  //                       ker jih checkBackup ogledalno pretvori sam)
  stationFilePath: configOk ? configOrError.paths?.stationFile ?? null : null,
  imagingDirs: configOk && configOrError.paths ? {
    id: configOrError.paths.imagingIdDir ?? null,
    stingers: configOrError.paths.imagingStingerDir ?? null,
    emergency: configOrError.paths.imagingEmergencyDir ?? null,
    promos: configOrError.paths.imagingPromosDir ?? null,
  } : null,
  imagingM3us: configOk && configOrError.paths ? {
    id: configOrError.paths.imagingIdPath ?? null,
    stingers: configOrError.paths.imagingStingerPath ?? null,
    emergency: configOrError.paths.imagingEmergencyPath ?? null,
    promos: configOrError.paths.imagingPromosPath ?? null,
  } : null,
  promosEnabled: configOk ? configOrError.imaging?.promos?.enabled === true : false,
  bedsEnabled: configOk ? configOrError.imaging?.beds?.enabled === true : false,
  imagingBedsRaw: configOk ? configOrError.imaging?.beds ?? {} : {},
  bedsDir: configOk ? configOrError.paths?.bedsDir ?? null : null,
  bedsLedgerPath: configOk ? configOrError.paths?.bedsFiredLedgerFile ?? null : null,
  backupDir: configOk ? configOrError.backup?.dir ?? null : null,
  backupIntervalMinutes: configOk ? configOrError.backup?.intervalMinutes : undefined,
  retentionDays: configOk ? configOrError.backup?.retentionDays : undefined,
  // Val 33: surova vrednost daypartProsody (obliko in ključe presoja
  // checkVoiceDaypart sam) -- isti vir resnice kot edgeTts.js/piperVoice.js
  // resolucija: autoRadio.voice.daypartProsody.
  daypartProsody: configOk ? configOrError.autoRadio?.voice?.daypartProsody ?? null : null,
};

// Pravi telnet odjemalec (sendCommand iz src/liquidsoap/telnetClient.js) se
// uvozi ŠELE, ko je config znan dober: modul potegne config STATIČNO na vrhu,
// zato bi zlomljen config.json sesel ta uvoz -- in z njim cel CLI -- pred
// izpisom. Doctor.js ga namerno NE pozna (injiciran šiv); spodaj ga stroga
// preverjanja preskočijo pošteno, če uvoz kljub vsemu pade.
let sendCommandImpl = null;
if (configOk) {
  try {
    ({ sendCommand: sendCommandImpl } = await import('../liquidsoap/telnetClient.js'));
  } catch {
    sendCommandImpl = null; // praktično nedosegljivo (config je ravno uspel) -- a doctor ne sme pasti
  }
}

// Val 26: PRAVI bralci produkcijske slovnice, isti duh kot telnetClient zgoraj
// (clockwheel/formatClock/scheduleUtil potegnejo config na vrhu modula):
// parseWheelTime + clockwheelConfig (HH:MM slovnica + drop-and-count števke),
// GENERATED_BED_RE (operaterjeve datoteke ostanejo nedotaknjene) in
// timeToMinutes (urnikova časovna toleranca). Val 33 dodaja timeBlocks
// (rules.js -- imena dnevnih delov, proti katerim se preverjajo ključi
// daypartProsody). Doctor sam ostaja brez configa;
// brez šiva njegova preverjanja pošteno povedo "nepreverjeno".
let parseWheelTimeImpl = null;
let clockwheelConfigImpl = null;
let generatedBedRe = null;
let timeToMinutesImpl = null;
let timeBlocksImpl = null;
if (configOk) {
  try {
    ({ clockwheelConfig: clockwheelConfigImpl, parseWheelTime: parseWheelTimeImpl } = await import('../scheduler/clockwheel.js'));
  } catch { /* praktično nedosegljivo -- a doctor ne sme pasti */ }
  try {
    ({ GENERATED_BED_RE: generatedBedRe } = await import('../scheduler/formatClock.js'));
  } catch { /* enako */ }
  try {
    ({ timeToMinutes: timeToMinutesImpl } = await import('../scheduler/scheduleUtil.js'));
  } catch { /* enako */ }
  try {
    ({ timeBlocks: timeBlocksImpl } = await import('../auto/rules.js'));
  } catch { /* enako */ }
}

const { runDoctor } = await import('../auto/doctor.js');
const report = await runDoctor({
  configOrError,
  netProbe,
  sendCommandImpl,
  readFileImpl: fsp.readFile, // pravi bralnik za m3u/host/errors/station/imaging
  statfsImpl: fsp.statfs,      // pravi fs.statfs za prostor na disku (fetch/nowMs že imata privzetka v doctorju)
  parseWheelTimeImpl,          // Val 26: PRAVI HH:MM parser (clockwheel.js)
  clockwheelConfigImpl,        // Val 26: PRAVI bralnik kolesa (clockwheel.js)
  generatedBedRe,              // Val 26: PRAVI vzorec generiranih postelj (formatClock.js)
  timeToMinutesImpl,           // Val 26: PRAVI urnikov časovni bralnik (scheduleUtil.js)
  timeBlocks: timeBlocksImpl ? timeBlocksImpl() : null, // Val 33: PRAVI bralnik dnevnih delov (rules.js)
  ...doctorInputs,
});

if (asJson) {
  console.log(JSON.stringify({
    when: new Date().toISOString(),
    netProbe,
    results: report.results,
    verdict: report.verdict,
    exitCode: report.exitCode,
  }, null, 2));
} else {
  console.log(renderHuman(report));
  if (!netProbe) {
    console.log('(omrežni viri so preskočeni -- poženi "npm run doctor -- --net" za dostopnost)');
  }
}
process.exit(report.exitCode);
