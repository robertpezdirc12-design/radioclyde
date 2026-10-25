// Beds (P3 #12/#13, integration table rows 12-13): announcements OVER the
// music. radio.liq mixes a request.queue(id="beds") source over the program
// via the sidechain ducker (P3 #13): rms.smooth measures the clip's actual
// loudness, the program ducks to 0.2 only while the clip actually sounds
// (attack ~20 ms, release ~0.5 s, hysteresis so inter-word gaps don't pump
// the music) and breathes back during pauses -- music under speech with no
// optional dependency, no ffmpeg filter process (the roadmap's literal
// "sidechaincompress" turned out to be an ffmpeg FILTER, not a Liquidsoap
// operator -- no such operator exists in any LS 2.x, verified upstream).
// This module is the Node half of the P2 #8 pattern: one telnet
// `beds.push <local-path>` queues a produced clip. The telnet layer is
// byte-identical to P3 #12 -- only the mixing mechanism changed.
//
// Wire contract verified against the v2.2.4 source (src/libs/request.liq,
// same file the requests layer uses -- every request.queue registers the
// same three commands under its own id):
//   <id>.push <uri>  replies with the new request's NUMERIC id,
//   <id>.queue       replies with space-separated ids (empty when idle),
//   <id>.skip        replies "Done." after cutting the current bed.
// server.ml splits command/args at the FIRST space, so paths with spaces
// arrive intact. Errors come back as "ERROR: ..." strings -- never treated
// as success here.
//
// Honesty contract: a bed push is a direct operator action on a produced
// clip. There is no moderation layer and no config toggle to update -- the
// telnet answer IS the outcome, and it is surfaced verbatim on failure.
// Beds intentionally skip the scrobble side-index registration
// requestQueue.js does: a bed is station speech (weather, ID, promo), never
// a music track, so registering it would only teach scrobbleTrack.js to
// scrobble a spoken clip.
//
// Tih uvod (lead-in, SUB/WAVE radio.liq:1722-1746): pred vsako posteljo se
// v vrsto najprej potisne 0,8 s posebej umerjenega rjavega šuma, da se
// duker povsem zgosti ŠE PRED prvo besedo (napad ~20 ms naredi svoje v
// prvih ~60 ms, a uvod pokriva celotno rampanje + izravnavo rms.smooth).
// DEVIACIJA od subwave: njihov smooth_add duha na PRIPRAVLJENOST vira, zato
// jim zadošča čista tišina; naš duker pa duha na IZMERJENO glasnost
// (radio.liq duck_update: level >= 0.02 duha, level < 0.008 POPUŠČA), torej
// bi čisto tihov uvod program celo ODdugal. Zato je uvod rjavi šum,
// umerjen na RMS ~0.03 (-30,3 dBFS, izmerjeno na tem stroju): nad pragom
// duhanja 0,02 z rezervo, a spektralno v nizkih frekvencah in ~31 dB pod
// mešanico -- pod zigovanim programom nezaslišen. Konstanti sta subwaveovi
// dobesedno (0,8 s); amplitudo je treba preumeriti SAMO ob spremembi pragov
// dukerja v radio.liq (0,02 / 0,008).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { sendCommand } from './telnetClient.js';

const execFileAsync = promisify(execFile);

const log = createLogger('station');

const BEDS_SOURCE_ID = 'beds'; // must match radio.liq's request.queue(id=...)

const LEAD_IN_SECONDS = 0.8; // subwave leadin.wav duration, verbatim
const LEAD_IN_AMPLITUDE = 0.21; // measured: RMS -30.3 dBFS, peak -18.6 dBFS, DC 0.002

// Zgenerira (enkrat, na disku se cachira) uvodni posnetek v
// <dataDir>/beds-leadin.wav. Vrne absolutno pot ali null ob napaki -- null
// pomeni POŠTEN odered: postelja gre v vrsto brez uvoda, duker pa naredi
// svojih prvih ~60 ms napada čez prvo besedo (današnje vedenje). runner je
// šiv za teste.
export async function ensureBedsLeadIn({ runner = execFileAsync } = {}) {
  const leadInPath = path.join(config.dataDir, 'beds-leadin.wav');
  try {
    const st = fs.statSync(leadInPath);
    if (st.isFile() && st.size > 1000) return leadInPath; // ~141 kB za 0,8 s stereo 44,1 kHz s16
  } catch {
    // še ni ga -- zgeneriramo spodaj
  }
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    await runner('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i',
      `anoisesrc=color=brown:amplitude=${LEAD_IN_AMPLITUDE}:duration=${LEAD_IN_SECONDS}:sample_rate=44100`,
      '-ac', '2', '-ar', '44100',
      leadInPath,
    ]);
    return leadInPath;
  } catch (err) {
    log(`bedQueue: uvodni posnetek se ni zgeneriral (${err?.message ?? err}) -- postelja gre brez njega`);
    return null;
  }
}

// Queues `filePath` (absolute, or resolved against the process working
// directory -- Liquidsoap resolves pushed URIs against ITS own cwd, so the
// absolute form is the only deterministic one to send) as a bed. Returns
// { ok:false, error } with Liquidsoap's own answer on any refusal. Pred
// posteljo potisne tih uvod (glej ensureBedsLeadIn) razen kadar je izklopljen
// ({ leadIn:false }) ali se ne zgenerira -- odpoved uvoda NIKOLI ne ustavi
// postelje same. Zavrnitev postelje prekine verigo: takrat uvoda (ki je že
// v vrsti) operater odstrani z beds.skip, spodaj pa pošteno poročamo
// { leadIn } o tem, kaj je pristalo v vrsti.
export async function pushBedFile(filePath, { leadIn = true, runner = execFileAsync } = {}) {
  const localPath = path.resolve(String(filePath ?? ''));
  if (!fs.existsSync(localPath)) {
    return { ok: false, error: `Datoteka za posteljo ne obstaja: ${localPath}` };
  }
  let leadInPushed = false;
  if (leadIn) {
    const leadInPath = await ensureBedsLeadIn({ runner });
    if (leadInPath) {
      try {
        const leadInResponse = await sendCommand(`${BEDS_SOURCE_ID}.push ${leadInPath}`);
        if (/^-?\d+$/.test(leadInResponse.trim())) {
          leadInPushed = true;
        } else {
          log(`bedQueue: uvod zavrnjen ("${leadInResponse.trim() || '(prazen odgovor)'}") -- postelja gre brez njega`);
        }
      } catch (err) {
        log(`bedQueue: uvod ni uspel (${err?.message ?? err}) -- postelja gre brez njega`);
      }
    }
  }
  const response = await sendCommand(`${BEDS_SOURCE_ID}.push ${localPath}`);
  if (!/^-?\d+$/.test(response.trim())) {
    return { ok: false, error: `Liquidsoap ni sprejel postelje: "${response.trim() || '(prazen odgovor)'}"` };
  }
  log(`bedQueue: pushed bed ${localPath} -> request #${response.trim()}${leadInPushed ? ' (s tihim uvodom)' : ''}`);
  return { ok: true, requestId: response.trim(), localPath, leadIn: leadInPushed };
}

// Verified v2.2.4 request.liq: `<id>.queue` lists the ids of the currently
// playing request (s.queue()) followed by the waiting ones (queue()),
// space-separated. Empty string before END = nothing queued (and nothing
// playing) -- an honest empty list, not an error.
export async function queueBeds() {
  const response = await sendCommand(`${BEDS_SOURCE_ID}.queue`);
  const ids = response.split(/\s+/).filter((s) => /^\d+$/.test(s));
  return { ok: true, queue: ids, raw: response.trim() };
}

// Cuts the CURRENT bed mid-clip ("Done." on success per request.liq). The
// program's release back up is the ducker's release time constant, not ours
// -- skip only ends the request, radio.liq still shapes the mix.
export async function skipBed() {
  const response = await sendCommand(`${BEDS_SOURCE_ID}.skip`);
  const ok = response.trim() === 'Done.';
  if (!ok) return { ok, error: `Liquidsoap ni potrdil skip: "${response.trim() || '(prazen odgovor)'}"` };
  return { ok, raw: response.trim() };
}

// CLI for box-side live verification (same pattern as requestQueue.js):
//   node src/liquidsoap/bedQueue.js push <file>
//   node src/liquidsoap/bedQueue.js queue
//   node src/liquidsoap/bedQueue.js skip
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'push' && rest[0]) {
    const outcome = await pushBedFile(rest[0]);
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'queue') {
    const outcome = await queueBeds();
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (cmd === 'skip') {
    const outcome = await skipBed();
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.ok) process.exitCode = 1;
    return;
  }
  console.error('Usage: bedQueue.js push <file> | queue | skip');
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
