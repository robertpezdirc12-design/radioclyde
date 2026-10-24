// Beds (P3 #12, integration table row 12): announcements OVER the music.
// radio.liq mixes a request.queue(id="beds") source over the program via
// the builtin smooth_add (verified against v2.2.4 src/libs/extra/
// audio.liq): a pushed clip ducks the program to p=0.2 and plays at (1-p),
// mid-track, then the program fades back up -- music under speech with no
// sidechain process. This module is the Node half of the P2 #8 pattern:
// one telnet `beds.push <local-path>` queues a produced clip.
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
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import { sendCommand } from './telnetClient.js';

const log = createLogger('station');

const BEDS_SOURCE_ID = 'beds'; // must match radio.liq's request.queue(id=...)

// Queues `filePath` (absolute, or resolved against the process working
// directory -- Liquidsoap resolves pushed URIs against ITS own cwd, so the
// absolute form is the only deterministic one to send) as a bed. Returns
// { ok:false, error } with Liquidsoap's own answer on any refusal.
export async function pushBedFile(filePath) {
  const localPath = path.resolve(String(filePath ?? ''));
  if (!fs.existsSync(localPath)) {
    return { ok: false, error: `Datoteka za posteljo ne obstaja: ${localPath}` };
  }
  const response = await sendCommand(`${BEDS_SOURCE_ID}.push ${localPath}`);
  if (!/^-?\d+$/.test(response.trim())) {
    return { ok: false, error: `Liquidsoap ni sprejel postelje: "${response.trim() || '(prazen odgovor)'}"` };
  }
  log(`bedQueue: pushed bed ${localPath} -> request #${response.trim()}`);
  return { ok: true, requestId: response.trim(), localPath };
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
// program's fade back up is smooth_add's to_blank transition, not ours --
// skip only ends the special source, Liquidsoap still shapes the edges.
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
