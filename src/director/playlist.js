// Liquidsoap's annotate: protocol (annotate:key="value",...:uri) overrides a
// playlist entry's metadata -- values are double-quoted, so any embedded
// quote/backslash must be escaped or it'd break the annotate parse.
function escapeAnnotateValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// R128 loudness correction for music tracks (lib/autocue.js's side index):
// the same module the scheduler's autocue scan job writes. An empty or
// missing index simply yields no field for any track -- see the comment on
// annotateTrackEntry below for the pass-through contract.
import { amplifyAnnotate } from '../lib/autocue.js';

// radio.liq wraps show_source/filler_source in fade.in(); this is the
// per-track duration that operator uses unless a playlist entry's own
// liq_fade_in metadata (set below) overrides it. Tuned by ear against real
// track assets, 2026-07-29 -- adjust here, not in radio.liq, since every
// entry sets its own override. (There's no equivalent fade.out() in
// radio.liq -- see lib/audio.js's applyFadeOut for why the jingle's fade-out
// is baked into its audio instead of done live.)
const TRACK_FADE_IN_SECONDS = 2;

// DJ speech clips carry no ID3/metadata tags of their own (they're raw
// Chatterbox/ffmpeg output), so plain playlist entries leave Icecast's
// now-playing display frozen on whatever track played last while the DJ is
// talking. Liquidsoap's `annotate:` request protocol lets a playlist entry
// override its own metadata -- used here (station.json's station name as
// artist, this show's title as track title) instead of touching the audio
// files themselves.
//
// `personas` (director/index.js's speechPersonas, deduped/ordered) becomes
// a custom `dj` metadata key -- not a standard ID3 field, just a value
// Liquidsoap's on_metadata hook can read straight off the entry. This is
// what lets radio.liq/plex/scrobbleTrack.js know who's actually talking in
// real time, for the web page's "<persona> talking" display.
//
// liq_fade_in="0" is unconditional (listener feedback, 2026-07-29: the DJ's
// voice should never fade in -- a 0-length fade is a hard cut, not a "skip
// fade" flag, but has the same audible effect) -- explicit rather than
// relying on fade.in's global default staying 0, so speech is protected even
// if that default ever changes for tracks.
export function annotateSpeechEntry(filePath, showTitle, stationName, personas) {
  const fields = ['liq_fade_in="0"'];
  if (showTitle) fields.push(`title="${escapeAnnotateValue(showTitle)}"`);
  if (stationName) fields.push(`artist="${escapeAnnotateValue(stationName)}"`);
  if (personas?.length) fields.push(`dj="${escapeAnnotateValue(personas.join(' & '))}"`);
  return `annotate:${fields.join(',')}:${filePath}`;
}

// The station jingle: same title/artist override as speech, minus the `dj`
// field (it isn't anyone talking) and minus any fade override -- its
// fade-down is physically baked into the audio by director/index.js before
// this ever runs, and it always plays first, so a hard start is fine.
export function annotateJingleEntry(filePath, showTitle, stationName) {
  const fields = [];
  if (showTitle) fields.push(`title="${escapeAnnotateValue(showTitle)}"`);
  if (stationName) fields.push(`artist="${escapeAnnotateValue(stationName)}"`);
  return fields.length ? `annotate:${fields.join(',')}:${filePath}` : filePath;
}

// Real music tracks: fade up at the start. Left to end on radio.liq's
// default (no fade-out) -- only the jingle overrides that.
//
// liq_amplify (when the track has a loudness-analysis entry, lib/autocue.js):
// the R128 correction radio.liq's amplify(override="liq_amplify") applies.
// Tracks without an entry annotate nothing here -- amplify() stays at its
// 1.0 pass-through coefficient for them, so an unscanned library plays
// exactly as it did before the loudness layer existed. Speech/jingle/imaging
// entries below never carry the field: they're produced at fixed loudness
// out-of-band and must not be touched by library measurement.
export function annotateTrackEntry(filePath) {
  const fields = [`liq_fade_in="${TRACK_FADE_IN_SECONDS}"`];
  const amplify = amplifyAnnotate(filePath);
  if (amplify) fields.push(`liq_amplify="${amplify}"`);
  return `annotate:${fields.join(',')}:${filePath}`;
}
