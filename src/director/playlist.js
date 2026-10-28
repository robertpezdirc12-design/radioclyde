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
import { amplifyAnnotate, crossfadeAnnotate, fadeInAnnotate, transitionFlagAnnotate, autocueFor, rampStampFor } from '../lib/autocue.js';

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
//
// Val 32 (ramp talk / hit-the-post): a single-clip intro/quizIntro run whose
// next track has a MEASURED intro window additionally carries liq_ramp="1"
// plus liq_cross_duration="<speech duration>" (the SAME field the tail pass
// stamps on music -- "transition OUT of this entry lasts this long"; here it
// sizes the whole speech clip as the cross buffer, which is what starts the
// incoming track under the talk on 2.4.6). Without a ramp object the line is
// byte-identical to the pre-Val-32 format. The fields are inert on 2.2.4
// (nothing there parses them) -- the seam stays sequential on that build.
export function annotateSpeechEntry(filePath, showTitle, stationName, personas, ramp = null) {
  const fields = [`source_tag="${SOURCE_TAG.speech}"`, 'liq_fade_in="0"'];
  if (ramp?.dur) {
    fields.push('liq_ramp="1"', `liq_cross_duration="${ramp.dur}"`);
  }
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
//
// Val 32 (ramp talk): `ramp` truthy marks the track whose INTRO a
// ramp-stamped speech run talks over. dj_transitions.liq's ramp branch
// requires the marker on BOTH sides of the seam before it leaves the
// hard-cut contract -- an unmarked incoming (filler rotation, listener
// requests, hand-built playlists) never ramps even when the outgoing
// speech happens to carry liq_ramp, because the window was never verified
// for THAT track. Without it the line is byte-identical.
export function annotateTrackEntry(filePath, ramp = false) {
  const fields = [
    `source_tag="${SOURCE_TAG.music}"`,
    `liq_fade_in="${fadeInAnnotate(filePath) ?? TRACK_FADE_IN_SECONDS}"`,
  ];
  if (ramp) fields.push('liq_ramp="1"');
  fields.push(...transitionFlagAnnotate(filePath));
  const amplify = amplifyAnnotate(filePath);
  if (amplify) fields.push(`liq_amplify="${amplify}"`);
  const cross = crossfadeAnnotate(filePath);
  if (cross) fields.push(`liq_cross_duration="${cross}"`);
  return `annotate:${fields.join(',')}:${filePath}`;
}

// Val 32: walk the assembled segment list and decide, per speech->track
// seam, whether the speech ramps over the track's intro. The decision itself
// is rampStampFor's (lib/autocue.js -- pure, tested there); this owns the
// SEAM WALK: a ramp candidate is a speech run immediately followed by a real
// track (not the jingle, not another run -- runs are maximal so that never
// happens, but the guard is free). `durations` is the MEASURED per-segment
// length array director/index.js already collects; `slotsFor` maps a run's
// path to its dj slots (a spliced open+intro run is station business and
// stays sequential); `vocalFor` is the autocue index seam (tests inject a
// stub; production reads the real side index).
//
// Returns { speech: Map<runPath, {dur}>, tracks: Set<trackPath> } -- feed the
// Map to annotateSpeechEntry's ramp argument and the Set to
// annotateTrackEntry's. An empty result means the playlist annotates exactly
// as it did before Val 32.
export function resolveRampSeams({
  segments,
  speechPaths,
  jinglePath,
  durations,
  slotsFor,
  vocalFor = (p) => autocueFor(p)?.vocal,
}) {
  const speech = new Map();
  const tracks = new Set();
  for (let i = 0; i + 1 < segments.length; i += 1) {
    const p = segments[i];
    const next = segments[i + 1];
    if (!speechPaths.has(p) || speechPaths.has(next) || next === jinglePath) continue;
    const stamp = rampStampFor({
      slots: slotsFor(p),
      speechSeconds: durations?.[i],
      vocal: vocalFor(next),
    });
    if (!stamp) continue;
    speech.set(p, stamp);
    tracks.add(next);
  }
  return { speech, tracks };
}
