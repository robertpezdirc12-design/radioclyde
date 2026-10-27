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
import { amplifyAnnotate, crossfadeAnnotate, fadeInAnnotate, transitionFlagAnnotate } from '../lib/autocue.js';

// radio.liq wraps show_source/filler_source in fade.in(); this is the
// per-track duration that operator uses unless a playlist entry's own
// liq_fade_in metadata (set below) overrides it. Tuned by ear against real
// track assets, 2026-07-29 -- adjust here, not in radio.liq, since every
// entry sets its own override. (There's no equivalent fade.out() in
// radio.liq -- see lib/audio.js's applyFadeOut for why the jingle's fade-out
// is baked into its audio instead of done live.)
//
// Val 28 B1: this constant is now the DEFAULT, not the verdict -- the
// autocue head pass (lib/autocue.js analyzeHead) measures how each track
// actually begins, and annotateTrackEntry stamps the measured value for the
// regimes it can size (gradual intro 2.5-4.0 s, cold attack 0.5 s). The
// moderate middle and every unmeasured track keep exactly this 2 s, so an
// unscanned library behaves byte-identically to before.
const TRACK_FADE_IN_SECONDS = 2;

// Source-family tags (docs/ready-made-scripts-analysis.md §2.5 -- the
// cookbook's source_tag dispatch pattern, Node half). Every m3u entry this
// repo writes carries exactly one: the dispatcher's one rule is "either side
// not music -> hard cut (sequence)", so the invariant that matters is
// music-vs-everything-else. Nothing on Liquidsoap 2.2.4 reads the field yet
// (verified from source: the metadata resolver needs 2.2.5+) -- it's what
// makes the m3u self-describing and keeps the future radio.liq dispatcher a
// pure consumer of data that's already there. Values are our constants,
// never user data, so no escaping concerns.
export const SOURCE_TAG = {
  music: 'music',
  speech: 'speech',
  jingle: 'jingle',
};

// DJ speech clips carry no ID3/metadata tags of their own (they're raw
// voice-layer/ffmpeg output), so plain playlist entries leave Icecast's
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
  const fields = [`source_tag="${SOURCE_TAG.speech}"`, 'liq_fade_in="0"'];
  if (showTitle) fields.push(`title="${escapeAnnotateValue(showTitle)}"`);
  if (stationName) fields.push(`artist="${escapeAnnotateValue(stationName)}"`);
  if (personas?.length) fields.push(`dj="${escapeAnnotateValue(personas.join(' & '))}"`);
  return `annotate:${fields.join(',')}:${filePath}`;
}

// The station jingle: same title/artist override as speech, minus the `dj`
// field (it isn't anyone talking) and minus any fade override -- its
// fade-down is physically baked into the audio by director/index.js before
// this ever runs, and it always plays first, so a hard start is fine.
// Carries source_tag unconditionally, so the entry is ALWAYS an annotate
// line now (previously a bare path when no title/station was set) --
// scrobbleTrack.js resolves "filename" either way, nothing else read the
// bare form.
export function annotateJingleEntry(filePath, showTitle, stationName) {
  const fields = [`source_tag="${SOURCE_TAG.jingle}"`];
  if (showTitle) fields.push(`title="${escapeAnnotateValue(showTitle)}"`);
  if (stationName) fields.push(`artist="${escapeAnnotateValue(stationName)}"`);
  return `annotate:${fields.join(',')}:${filePath}`;
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
//
// liq_cross_duration (ending-aware crossfade sizing, the SUB/WAVE mechanism):
// ONE number per track meaning "transition OUT of this track lasts this
// long", derived at read time from the tail measurement the autocue scan
// stored (lib/autocue.js tailMetrics -> crossSecondsFor: 8-12 s on measured
// fade-out tails). radio.liq's cross_stamps metadata.map translates it into
// explicit liq_cross_start_duration/liq_cross_end_duration keys per track
// (a single per-track stamp cannot size both sides: cross re-applies
// override keys off its own output) and clears the raw key. Tracks with no
// tail measurement -- cold endings, speech, jingles, requests, old index
// entries from before the tail pass existed -- get NO field here, so
// radio.liq's dj_transition_buffer default (3.5 s) stands: the same
// pass-through contract as liq_amplify above. Values are our own
// 0.1-quantized number strings, never user data, so no escaping concerns.
//
// liq_fade_in (Val 28 B1, entry-aware fade-in sizing): the head pass's
// measured value when it has one (gradual intro 2.5-4.0 s, cold attack
// 0.5 s), else the TRACK_FADE_IN_SECONDS default above. The fade.in
// wrappers are UNGATED in radio.liq, so this stamp is audible on the 2.2.4
// box the station runs today -- one fixed 2 s on every track regardless of
// how it begins was the flattest seam in the station's sound.
//
// Val 28 D1 (transition-effect stamps): the dormant dj_transitions.liq
// layer (sweep/washout/dissolve -- %ifversion >= 2.4.6) is armed here,
// deterministically, from the SAME autocue measurements (see
// lib/autocue.js transitionFlagsFor): an epic fade-out ending carries
// liq_washout, a deep ambient build-in carries liq_dissolve, a hot cold
// start carries liq_sweep. Unmeasured or unremarkable entries carry no
// flag -- the plain linear crossfade stays the workhorse seam, and nothing
// changes on air until the box's Liquidsoap upgrade lights the layer.
export function annotateTrackEntry(filePath) {
  const fields = [
    `source_tag="${SOURCE_TAG.music}"`,
    `liq_fade_in="${fadeInAnnotate(filePath) ?? TRACK_FADE_IN_SECONDS}"`,
  ];
  fields.push(...transitionFlagAnnotate(filePath));
  const amplify = amplifyAnnotate(filePath);
  if (amplify) fields.push(`liq_amplify="${amplify}"`);
  const cross = crossfadeAnnotate(filePath);
  if (cross) fields.push(`liq_cross_duration="${cross}"`);
  return `annotate:${fields.join(',')}:${filePath}`;
}
