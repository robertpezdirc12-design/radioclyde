// The auto producer: the no-AI counterpart of generateScript.js's
// runProducerPipeline. Same input contract ({ id, descriptionText,
// durationMinutes, date }) and same outputs (markdown script, tracks, debug
// transcript) -- only the phases differ:
//
//   A. Track selection -- auto/briefQuery.js parses the brief's
//      "## Track Selection" section deterministically, then
//      trackSelection/queue.js's buildTrackQueue() picks real tracks with
//      the auto rules layered on (artist cooldown, popularity mix, decade
//      spread) -- the exact same selection code the AI-mode station uses.
//   B. Research -- none. Facts come from the track's own library metadata
//      (album, year, genre); no Wikipedia fetch, no extraction pass.
//   C+D. Script assembly -- auto/scriptBuilder.js walks the tracklist and
//      renders every spoken line from config templates.
//   E. Review pass -- skipped by construction (templates can't drift).
//
// Written to be called from generateScript.js's mode branch, so the
// scheduler/studio/CLI paths all switch to it through one flag
// (config.autoRadio.enabled) with no other wiring.
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { parseScript, renderScript } from '../script/format.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { buildTrackQueue } from '../producer/trackSelection/queue.js';
import { parseShowBrief } from '../producer/showBrief.js';
import { recordPlayed } from '../producer/history.js';
import { produceTrackQueryDeterministic } from './briefQuery.js';
import { listGenreTagsAny, listAlbumGenreTagsAny } from './librarySource.js';
import { artistCooldownFilter, popularityShare, timeBlockKey } from './rules.js';
import { buildSegmentsAuto } from './scriptBuilder.js';

const log = createLogger('station');

export async function runAutoProducerPipeline({ id, descriptionText, durationMinutes, date }) {
  const debug = {};

  const brief = parseShowBrief(descriptionText, {
    defaultRepeatWindowDays: config.scripts?.defaultRepeatWindowDays ?? 7,
  });
  debug.brief = { ...brief, text: undefined };
  if (!brief.primaryPersona) {
    throw Object.assign(new Error(`Show "${id}"'s brief has no "**Personas:**" line -- at least one persona is required.`), { debug });
  }
  if (!brief.trackSelectionText) {
    throw Object.assign(
      new Error(`Show "${id}"'s brief has no "## Track Selection" section -- required to resolve a real tracklist.`),
      { debug }
    );
  }

  debug.mode = 'auto';

  log(`[${id}] Phase A (auto): resolving track selection deterministically...`);
  const [genreTags, albumGenreTags] = await Promise.all([listGenreTagsAny(), listAlbumGenreTagsAny()]);
  debug.genreTags = genreTags;
  const { query } = produceTrackQueryDeterministic({
    trackSelectionText: brief.trackSelectionText,
    genreTags,
    albumGenreTags,
  });
  debug.trackQuery = query;

  const cooldown = artistCooldownFilter();
  debug.cooldownHours = cooldown.cooldownHours;
  const popularShare = popularityShare();

  const trackQueueResult = await buildTrackQueue({
    ...query,
    targetDurationMinutes: durationMinutes,
    repeatWindowDays: brief.repeatWindowDays,
    excludeArtists: cooldown.excludeArtists,
    popularShare,
    decadeSpread: config.autoRadio?.rules?.decadeSpread ?? true,
  });
  debug.trackQueueResult = {
    poolSize: trackQueueResult.poolSize,
    estimatedMusicMs: trackQueueResult.estimatedMusicMs,
    estimatedTotalMs: trackQueueResult.estimatedTotalMs,
    targetMs: trackQueueResult.targetMs,
    trackCount: trackQueueResult.tracks.length,
    cooldownExcluded: trackQueueResult.cooldownExcluded ?? 0,
    popularShare: trackQueueResult.popularShare ?? null,
    decadeSpread: trackQueueResult.decadeSpread ?? false,
  };
  const tracks = trackQueueResult.tracks;
  if (tracks.length === 0) {
    throw Object.assign(new Error(`Track selection for "${id}" resolved zero tracks.`), { debug });
  }
  log(
    `[${id}] Phase A done (auto): ${tracks.length} tracks, cooldown excluded ${debug.trackQueueResult.cooldownExcluded}, ` +
      `pool ${trackQueueResult.poolSize}.`
  );

  log(`[${id}] Phase C+D (auto): rendering template segments...`);
  const block = timeBlockKey();
  debug.timeBlock = block;
  const { segments } = buildSegmentsAuto({ tracks, brief, showId: id, date });
  debug.segments = segments.length;
  log(`[${id}] Phase D done (auto): ${segments.length} segments assembled (time block: ${block ?? 'n/a'}).`);

  const knownRatingKeys = new Map(tracks.map((t) => [String(t.ratingKey), t]));
  const title = brief.title || id;
  const markdown = renderScript({ title, durationMinutes, segments });
  const validation = parseScript(markdown, {
    requiredDurationMinutes: durationMinutes,
    personas: loadPersonas(),
    knownRatingKeys,
  });
  debug.validation = validation.ok
    ? { ok: true, warnings: validation.warnings }
    : { ok: false, issues: validation.issues, warnings: validation.warnings };
  if (!validation.ok) {
    log(`[${id}] WARNING: validation issues (written anyway): ${validation.issues.join(' | ')}`);
  }
  if (validation.warnings?.length) {
    log(`[${id}] NOTE: ${validation.warnings.join(' | ')}`);
  }

  return { markdown, tracks, debug };
}

// Called by generateScript.js right after its own recordPlayed loop would
// run in AI mode -- same recording rule (only at finalization), same entry
// shape, so artist cooldown and station-wide repeat exclusion see auto-mode
// shows exactly like AI-mode ones.
export function recordAutoPlayedTracks(tracks, showId) {
  for (const track of tracks) {
    recordPlayed({ ratingKey: track.ratingKey, artist: track.artist, title: track.title, album: track.album }, showId);
  }
}
