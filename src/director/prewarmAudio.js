// Downtime-only pass: synthesizes and caches every `dj` segment's speech
// ahead of air time, so directShow()'s own near-air-time run -- triggered by
// scheduleDirect.js on its usual directLeadTimeMinutes clock, unchanged --
// finds the dj-audio cache already warm and only has to do what genuinely
// can't be done early: resolve `live` segments (weather/time) and assemble
// the occurrence. Never touches `live` segments itself, and never writes
// playlist.m3u -- this only ever populates the per-show/date dj-audio cache
// that directShow() already reads from (see director/djAudio.js).
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import { loadValidatedScript } from './scriptLoader.js';
import { getCachedDjAudio } from './djAudio.js';
import { restartChatterbox } from '../scheduler/restartChatterbox.js';

const log = createLogger('station');

export async function prewarmShowAudio({ id, weekday, date }) {
  const { parsed, showDateDir } = await loadValidatedScript({ id, weekday, date });
  const djAudioDir = path.join(showDateDir, 'dj-audio');
  fs.mkdirSync(djAudioDir, { recursive: true });

  const djSegments = parsed.segments.filter((s) => s.type === 'dj');
  let warmed = 0;
  let skipped = 0;
  // Same track association directShow() uses for pre-generated clip lookup
  // (director/index.js): intro/quizIntro look AHEAD to the next track segment,
  // recap/quizReveal take the track that just passed. The script's own track
  // segments carry artist/title, which is all resolvePreGeneratedClip needs
  // -- no Plex round-trip, so prewarm stays a purely local pass. Without
  // this, track-keyed intro/recap clips could never resolve during prewarm
  // and synthesized at direct time instead -- defeating the whole point.
  let currentTrack = null;
  for (const [i, seg] of parsed.segments.entries()) {
    if (seg.type === 'track') {
      currentTrack = { artist: seg.artist, title: seg.title, ratingKey: String(seg.ratingKey) };
      continue;
    }
    if (seg.type !== 'dj') continue;
    // slot/seed/track must match directShow()'s own call exactly, so prewarm
    // fills the exact cache entries directShow will hit (persona clip
    // selection in autoRadio clips mode keys off slot+seed).
    let segTrack = null;
    if (seg.slot === 'intro' || seg.slot === 'quizIntro') {
      for (let j = i + 1; j < parsed.segments.length; j++) {
        if (parsed.segments[j].type === 'track') {
          const t = parsed.segments[j];
          segTrack = { artist: t.artist, title: t.title, ratingKey: String(t.ratingKey) };
          break;
        }
      }
    } else if (seg.slot === 'recap' || seg.slot === 'quizReveal') {
      segTrack = currentTrack;
    }
    const { cached, skipped: segSkipped } = await getCachedDjAudio(
      djAudioDir,
      i,
      seg.persona,
      seg.body,
      seg.slot ?? 'dj',
      seg.seed ?? `${parsed.title}|${i}`,
      segTrack
    );
    if (segSkipped) skipped++;
    else if (!cached) warmed++;
  }

  // Same reasoning as directShow()'s own restartChatterbox call: reclaim
  // whatever accumulated in the process's memory/swap during this show's TTS
  // rather than leaving it resident until the next one. Best-effort -- a
  // failure here shouldn't block the prewarm pass from moving on to the next
  // show. No-ops under autoRadio (no Chatterbox to restart).
  try {
    await restartChatterbox();
  } catch (err) {
    log(`[${id}] NOTE: Chatterbox restart failed after prewarm: ${err.message}`);
  }

  log(`[${id}] Prewarmed dj audio for ${weekday} ${date}: ${warmed}/${djSegments.length} segment(s) synthesized${skipped ? `, ${skipped} skipped (no-model voice mode with no audio for the slot)` : ''} (rest already cached).`);
  return { warmed, total: djSegments.length, skipped };
}
