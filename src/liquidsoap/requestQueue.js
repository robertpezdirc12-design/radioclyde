// Listener requests reaching the air (P2 #8, integration table row 8).
// Before this module an approved request simply SAT in requests.jsonl -- the
// owner could approve it, but getting the song on air meant manual heroics.
// This closes the loop with Liquidsoap's request.queue (radio.liq, id
// "requests"): one telnet `requests.push <local-path>` queues the file, and
// the track-sensitive fallback plays it at the next track boundary, with no
// competition from the now_playing.m3u reload.
//
// Semantics verified against the v2.2.4 source (src/libs/request.liq):
// `push <uri>` replies with the new request's NUMERIC id, so a numeric
// response here means "queued" and anything else is surfaced as an error
// string rather than guessed at.
//
// Honesty contract (mirrors requestsStore.js): queueing is an explicit owner
// action on an ALREADY approved request -- it never changes the listener
// visible status, only the note, and every outcome (queued / not found in
// library / Liquidsoap unreachable) is written back into that note so the
// studio dashboard shows the truth without a round trip.
import fs from 'node:fs';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { sendCommand } from './telnetClient.js';
import { fetchAllTracksAny } from '../auto/librarySource.js';
import { toLocalPath } from '../plex/musicLibrary.js';
import { mergeTrackRatingKeys } from '../plex/ratingKeyIndex.js';
import { getRequest, updateRequestStatus } from '../server/requestsStore.js';
import { prefetchLyrics } from '../lyrics/lyricsService.js';

const log = createLogger('station');

const REQUESTS_SOURCE_ID = 'requests'; // must match radio.liq's request.queue(id=...)

// Same normalization localLibrary.js uses for matching: case- and
// diacritics-folded, so a listener typing "Tomas Loko" still matches a
// library file tagged "Tomaž Loko".
function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Best match among library tracks for a free-text (artist, title) pair:
// fold-equal title is required; artist is required only when the listener
// actually wrote one (the request form leaves it optional). Ties (same
// normalized title, e.g. reissues under several ratingKeys) resolve the way
// dedupeByTitle keeps them station-wide: the highest ratingCount wins.
// Returns the track or null -- never throws, never approximates (a
// "close enough" pick would play the WRONG song on air).
export function pickBestMatch(tracks, { title, artist }) {
  const wantedTitle = fold(title);
  if (!wantedTitle) return null;
  const wantedArtist = fold(artist);
  const matching = tracks.filter(
    (t) =>
      fold(t.title) === wantedTitle &&
      (!wantedArtist || fold(t.artist) === wantedArtist)
  );
  if (matching.length === 0) return null;
  return matching.sort((a, b) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0))[0];
}

// Resolves a listener's free-text request against the whole music library
// (Plex or local -- whichever the station runs). null = not in the library.
export async function resolveRequestTrack({ title, artist }) {
  const all = await fetchAllTracksAny();
  return pickBestMatch(all, { title, artist });
}

// A resolved track's playable local path -- auto-radio local-library tracks
// carry localPath directly, Plex tracks go through the config-mapped
// conversion (same rule as scheduler/generateFillerPlaylist.js).
function trackLocalPath(t) {
  const p = t.localPath ?? toLocalPath(t.plexPath);
  if (!p || !fs.existsSync(p)) {
    throw new Error(`Datoteka za "${t.artist} - ${t.title}" ni dosegljiva na disku (${p ?? 'brez poti'}).`);
  }
  return p;
}

// Raw telnet push of a local file onto radio.liq's request queue. Registers
// path->ratingKey in the scrobble side index first: scrobbleTrack.js resolves
// "filename" against that index on air, and a request track never went
// through the playlist writers that normally maintain it -- without this its
// play would air but never scrobble.
export async function pushRequestTrack(track) {
  const localPath = trackLocalPath(track);
  if (track.ratingKey != null) {
    await mergeTrackRatingKeys([[localPath, String(track.ratingKey)]]);
  }
  const response = await sendCommand(`${REQUESTS_SOURCE_ID}.push ${localPath}`);
  // Verified v2.2.4 request.liq: a successful push replies with the numeric
  // request id. Anything else (error text, empty) is Liquidsoap's answer to
  // surface, not something to interpret away.
  if (!/^-?\d+$/.test(response.trim())) {
    return { ok: false, error: `Liquidsoap ni sprejel zahtevka: "${response.trim() || '(prazen odgovor)'}"` };
  }
  log(`requestQueue: pushed "${track.artist} - ${track.title}" (${localPath}) -> request #${response.trim()}`);
  return { ok: true, requestId: response.trim(), localPath };
}

// The whole owner action behind the studio's "Queue" button:
//   approved request -> resolve against the library -> push to Liquidsoap
//   -> write the outcome into the request's note (status stays 'approved').
// Returns null for an unknown id, { ok:false, error } on refusal/failure,
// { ok:true, requestId } once Liquidsoap accepted the file.
export async function queueRequest(id) {
  const entry = getRequest(id);
  if (!entry) return null;
  if (entry.status !== 'approved') {
    return { ok: false, error: 'Samo odobren zahtevek lahko v predvajalno vrsto (najprej Approve).' };
  }
  if (!entry.title) {
    return { ok: false, error: 'Posvetilo brez naslova pesmi ni mogoče postaviti v vrsto.' };
  }

  const note = (text) => updateRequestStatus(id, 'approved', text);

  let track;
  try {
    track = await resolveRequestTrack({ title: entry.title, artist: entry.artist });
  } catch (err) {
    const message = `Knjižnica ni dosegljiva (${err.message}) -- zahtevek ostaja odobren, poskusi znova.`;
    note(message);
    return { ok: false, error: message };
  }
  if (!track) {
    const message = `Skladbe "${entry.artist ? `${entry.artist} - ` : ''}${entry.title}" ni v knjižnici -- zahtevek ostaja odobren brez predvajanja.`;
    note(message);
    return { ok: false, error: message };
  }

  try {
    const pushed = await pushRequestTrack(track);
    if (!pushed.ok) {
      note(pushed.error);
      return pushed;
    }
    note(`V predvajalni vrsti (Liquidsoap request #${pushed.requestId}) -- zaigra na naslednji meji skladbe.`);
    // The request airs at the NEXT track boundary -- minutes away at most:
    // start its owed lyric lookup now (flag-gated, fire-and-forget) so the
    // answer is likely cached before a listener opens the "Besedila" panel.
    // Same shared service the /api/lyrics/current route uses in this process.
    prefetchLyrics([track]);
    return { ok: true, requestId: pushed.requestId, track: { artist: track.artist, title: track.title } };
  } catch (err) {
    const message = `Liquidsoap ni dosegljiv (${err.message}) -- zahtevek ostaja odobren, poskusi znova.`;
    note(message);
    return { ok: false, error: message };
  }
}

// CLI for box-side live verification (same pattern as autocue.js):
//   node src/liquidsoap/requestQueue.js queue <requestId>
//   node src/liquidsoap/requestQueue.js push <file>
//   node src/liquidsoap/requestQueue.js resolve "<artist>" "<title>"
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'queue' && rest[0]) {
    const outcome = await queueRequest(rest[0]);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome && outcome.ok === false) process.exitCode = 1;
    return;
  }
  if (cmd === 'push' && rest[0]) {
    const outcome = await pushRequestTrack({ localPath: rest[0], artist: '(file)', title: '(file)', ratingKey: null });
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'resolve' && rest[1] !== undefined) {
    const track = await resolveRequestTrack({ artist: rest[0], title: rest[1] });
    console.log(track ? `${track.artist} - ${track.title} [${track.localPath ?? track.plexPath}]` : 'ni zadetka v knjižnici');
    if (!track) process.exitCode = 1;
    return;
  }
  console.error('Usage: requestQueue.js queue <requestId> | push <file> | resolve "<artist>" "<title>"');
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
