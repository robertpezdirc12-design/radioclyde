#!/usr/bin/env node
// Promo producer (Paket B2, docs/programming-research.md §5, row B2): the job
// behind the FOURTH imaging layer (imaging/promos.m3u + radio.liq's
// promo_source, docs/imaging-layer.md). Unlike the three sibling layers --
// whose clips are produced out-of-band by the operator -- this layer's clips
// are AUTO-PRODUCED FROM THE REAL SCHEDULE:
//
//   nextOccurrences(loadSchedule())  ->  renderSlot('promo'/'promoHost') from
//   templates.js's pools  ->  synthesizeWithEdge (Edge TTS, the same
//   no-model voice path the whole station already uses)  ->  ONE ebur128 pass
//   (lib/autocue.js's analyzeTrack)  ->  the loudness correction BAKED into
//   the file via ffmpeg's volume filter.
//
// Why baked and not annotated: imaging clips never carry liq_amplify metadata
// (docs/autocue-loudness.md: "govor / jingle / ID / stinger / emergency |
// nikoli ne nosijo polja -- fiksna producentska glasnost") -- radio.liq's
// amplify(override="liq_amplify") is a pass-through for entries without the
// field, so a promo that wants to sit at the station target must have the
// correction in the bytes themselves. Same measurement machinery as the music
// (analyzeTrack/amplifyDbFor, target from config.autocue?.targetLufs ?? -16),
// just applied at production time instead of playlist time.
//
// Every file this job writes lands via atomic tmp+rename (the
// writeImagingPlaylists discipline, imagingPlaylists.js:83-105), and the tmp
// names NEVER end in an audio extension ON PURPOSE: buildImagingEntries lists
// the layer directory by extension (imagingPlaylists.js:33/:66), so a
// half-written "promo_x.tmp-123.mp3" must never be visible to the scan -- a
// torn clip that airs half a sentence is worse than a clip that isn't there
// yet.
//
// Deterministic file naming (promo_<showId>_<date>_<timeKey>.mp3) is the
// re-work guard: a clip for an occurrence that already exists on disk is
// reused untouched -- schedulePrewarmAudio.js's .prewarmed marker philosophy
// (a marker that makes the second pass free), except here the produced
// artifact IS the marker. Stale GENERATED clips (their occurrence slid out of
// the horizon window) are pruned after the loop; operator-placed clips are
// untouchable by that sweep -- see the load-bearing comment at the pattern.
//
// The job ends with writeImagingPlaylists() so the .m3u refreshes NOW instead
// of waiting for the imaging tick (<= 30 min later); the rewrite is cheap,
// idempotent (byte-identical skip) and safe to call from here.
//
// OFF unless imaging.promos.enabled === true (F2: an absent block means the
// feature is off, no tick work at all -- and scheduler.js does not even
// REGISTER the job, so the station behaves byte-identically to pre-B2).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { loadSchedule, nextOccurrences, absoluteStart } from './scheduleUtil.js';
// resolveShowInfo: the H1 title + primary host out of the show's brief -- the
// exact import precedent is src/scheduler/pushDispatch.js:14 (a scheduler job
// resolving display names the same way /api/schedule does), so a promo says
// "Markec Podkast", not "markec-podkast".
import { resolveShowInfo } from '../server/showName.js';
// slovenianWeekdayPhrase -> "v sredo": ALWAYS the weekday-name form, never
// "danes"/"jutri" -- a promo clip lives in the pool for hours, so a relative
// word produced at 22:00 rots after midnight; the weekday name stays true
// whenever the clip airs (lib/time.js's own contract comment).
import { slovenianWeekdayPhrase } from '../lib/time.js';
// A scheduler job importing the PURE template module is precedented by the
// produce.js chain (auto/produce.js -> templates.js); nothing here touches
// the LLM producer.
import { renderSlot, stationName } from '../auto/templates.js';
import { synthesizeWithEdge } from '../auto/edgeTts.js';
import { analyzeTrack, amplifyDbFor } from '../lib/autocue.js';
import { writeImagingPlaylists } from './imagingPlaylists.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

// autocue.js:63-64's timeout/maxBuffer/windowsHide discipline, sized for
// SHORT clips: a promo is a single spoken sentence, so 60 s of ffmpeg is
// already generous, and the ebur128 stderr of a ~5 s file is tiny -- but the
// same constants' spirit (a wedged process must never hang the tick, a long
// stderr must never look like "ffmpeg failed") keeps the guard honest.
const FFMPEG_TIMEOUT_MS = 60_000;
const FFMPEG_MAX_BUFFER = 32 * 1024 * 1024;

// ONLY filenames matching this pattern are ever removed by this job. See the
// load-bearing comment at pruneStalePromos().
const GENERATED_PROMO_RE = /^promo_.+_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/;

// The clips themselves. Test seams (the MCP ctx precedent, src/mcp/tools.js
// :45-48: production callers pass nothing, tests inject fakes so no test
// ever touches the network or ffmpeg): synthesize/analyze/run are exactly
// synthesizeWithEdge / analyzeTrack / promisify(execFile) in production.
export async function producePromoClips({
  synthesize = synthesizeWithEdge,
  analyze = analyzeTrack,
  run = execFileAsync,
} = {}) {
  // F2 gating: absent block = feature off. Unlike most optional knobs (which
  // default ON to preserve behavior), this one defaults OFF -- a layer that
  // SPEAKS on air must never appear unannounced on an existing install.
  if (config.imaging?.promos?.enabled !== true) {
    return { skipped: true };
  }

  const horizonMs = (config.imaging?.promos?.horizonHours ?? 18) * 3600_000;
  const maxClips = config.imaging?.promos?.maxClips ?? 8;
  // No in-flight guard needed (contrast schedulePrewarmAudio.js:34's
  // inFlight set, which exists because ITS horizon is 24h of whole-show TTS
  // and ticks can genuinely overlap): this job's work is bounded --
  // maxClips (default 8) single-sentence Edge calls + at most one short
  // ffmpeg pass each, seconds of work against a 30-min default cadence.
  // every()'s own per-tick try/catch covers the rest.

  // Request 30 occurrences, THEN filter to the horizon and cap at maxClips.
  // 30 because nextOccurrences' walk cap is 14 days but a REQUEST of
  // maxClips could underfill: e.g. a Sunday-evening window whose next few
  // days are dark would return fewer than maxClips occurrences even though
  // in-window shows exist further out; asking for a healthy surplus lets the
  // horizon filter do the trimming. nextOccurrences already excludes shows
  // that started earlier today (scheduleUtil.js:356) -- and Val 28 C3 adds
  // the belt to those braces: the window filter demands a STRICTLY FUTURE
  // start, so even a show starting THIS minute (nextOccurrences' skip is
  // `< nowMinutes`, an equal minute passes) never gets a promo produced
  // while it airs, and a clip whose show has since started falls out of the
  // window -> pruneStalePromos sweeps it at this same tick -> the m3u
  // refresh below takes it out of rotation. Residual honesty: between a
  // show's start and this job's next tick (<= 30 min) an already-produced
  // promo can still air once or twice -- the pool is randomize without
  // memory, and this job is the only pruner. Documented, accepted, bounded.
  const raw = nextOccurrences(loadSchedule(), new Date(), 30);
  const now = Date.now();
  const inWindow = raw.filter((occ) => {
    const start = absoluteStart(occ.date, occ.show.startTime);
    return start > now && start - now <= horizonMs;
  });
  const occurrences = inWindow.slice(0, maxClips);

  fs.mkdirSync(config.paths.imagingPromosDir, { recursive: true });

  let produced = 0;
  let reused = 0;
  const errors = [];

  for (const occ of occurrences) {
    const finalPath = path.join(
      config.paths.imagingPromosDir,
      `promo_${occ.show.id}_${occ.date}_${occ.timeKey}.mp3`
    );
    // Deterministic name = the re-work skip: the file's existence IS the
    // .prewarmed marker (schedulePrewarmAudio.js philosophy) -- a repeat tick
    // with an unchanged schedule produces zero Edge calls.
    if (fs.existsSync(finalPath)) {
      reused++;
      continue;
    }

    const { name, host } = resolveShowInfo(occ.show, occ.show.specialTitle ?? occ.show.id);
    // null dayWord (an unparseable date) -> still produce: substitute()
    // (templates.js:434-439) blanks a null/empty value, so the sentence
    // loses ONLY the day phrase ("Na Radio Markec ob 20:00: ...") -- a promo
    // without the day is still true, and the alternative (skip) would mute
    // the layer over a cosmetic gap. Never a fabricated day.
    const dayWord = slovenianWeekdayPhrase(occ.date) ?? '';
    const slot = host ? 'promoHost' : 'promo';
    const values = {
      station: stationName(),
      show: name,
      host,
      dayWord,
      time: occ.show.startTime,
    };
    // Stable seed -> stable variant pick across ticks (the hash-based
    // variantFrom, templates.js:429-432); the seed names every axis of the
    // occurrence so two different shows/dates never collide.
    const seed = `promo|${occ.show.id}|${occ.date}|${occ.timeKey}`;
    const body = renderSlot(slot, { values, seed });

    // Tmp names WITHOUT an audio extension, ON PURPOSE: buildImagingEntries
    // scans by extension (imagingPlaylists.js:33/:66) -- a half-written
    // promo_x.tmp-123.mp3 must never be visible to the m3u scan.
    const tmpEdge = `${finalPath}.tmp-${process.pid}`;
    let tmpGain = null;
    try {
      // persona null -> edgeVoiceForPersona resolves the GLOBAL Edge voice
      // (edgeTts.js:31-34: personaCfg ?? {} -> config.autoRadio.voice.
      // edgeVoice ?? 'sl-SI-RokNeural'); prosody cascades the same way
      // (edgeProsodyForPersona, edgeTts.js:41-50). One knob, one meaning.
      const persona = config.imaging?.promos?.persona ?? null;
      await synthesize(body, tmpEdge, persona);

      // Loudness: measure, then bake. amplifyDbFor's contract
      // (lib/autocue.js:106-117): one-decimal dB, negative side unclamped,
      // positive side clamped by maxGainDb (6), target
      // config.autocue?.targetLufs ?? -16.
      try {
        const { lufs } = await analyze(tmpEdge);
        const { amplify } = amplifyDbFor(lufs);
        if (amplify === 0) {
          // Already on target -- land the measured bytes untouched.
          fs.renameSync(tmpEdge, finalPath);
        } else {
          tmpGain = `${finalPath}.tmp2-${process.pid}`;
          try {
            // '-f mp3' is LOAD-BEARING: ffmpeg picks the output muxer from the
            // filename's extension, and the tmp name is extension-less ON
            // PURPOSE (see the tmpEdge comment above -- the m3u scan must
            // never see a half-written clip). Without the explicit format the
            // real ffmpeg dies with "Unable to choose an output format" and
            // every clip would silently land unmeasured via the fallback
            // below -- caught live in the Val 21 orchestrator E2E (2026-10-25),
            // where injected-fake unit tests could not see it. Input needs no
            // hint: ffmpeg probes Edge's MP3 bytes by content.
            await run(
              'ffmpeg',
              ['-y', '-i', tmpEdge, '-filter:a', `volume=${amplify}dB`, '-f', 'mp3', tmpGain],
              { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER, windowsHide: true }
            );
            fs.renameSync(tmpGain, finalPath);
          } catch (runErr) {
            // ffmpeg failed: land the UNCORRECTED clip anyway -- a
            // slightly-off-level promo beats no promo, and the
            // broadcast-bus limiter still catches peaks (radio.liq:651-653,
            // the compress() before output.icecast).
            log(
              `Promo "${occ.show.id}" (${occ.date} ${occ.timeKey}) gain pass failed (${runErr?.message ?? runErr}) -- landing unmeasured, station unaffected.`
            );
            fs.renameSync(tmpEdge, finalPath);
          }
        }
      } catch (analyzeErr) {
        // ebur128 failed (no ffmpeg / unparseable output): same honest
        // degradation -- the clip lands, the station is unaffected, and the
        // NEXT tick re-measures nothing (the file exists, so it is reused
        // as-is; retuning means deleting the clip).
        log(
          `Promo "${occ.show.id}" (${occ.date} ${occ.timeKey}) loudness unmeasured (${analyzeErr?.message ?? analyzeErr}) -- station unaffected.`
        );
        fs.renameSync(tmpEdge, finalPath);
      }
      produced++;
    } catch (err) {
      // Synthesize threw (Edge down / rate-limited / empty audio):
      // skip-not-fail -- the clip simply does not exist in the pool, and
      // the next tick retries it because the file never landed.
      errors.push({ show: occ.show.id, message: err?.message ?? String(err) });
      log(
        `Promo "${occ.show.id}" (${occ.date} ${occ.timeKey}) Edge TTS failed: ${err?.message ?? err} -- clip skipped, next tick retries.`
      );
    } finally {
      // Cleanup discipline: neither tmp may ever survive the tick. force:
      // true keeps this a no-op after a successful rename moved the file.
      fs.rmSync(tmpEdge, { force: true });
      if (tmpGain) fs.rmSync(tmpGain, { force: true });
    }
  }

  const removed = pruneStalePromos(inWindow);

  // Refresh the m3u NOW (cheap + idempotent) so a fresh clip reaches air on
  // the next watch reload instead of <= 30 min later at the imaging tick.
  await writeImagingPlaylists();

  log(
    `Promo producer: ${produced} produced, ${reused} reused, ${removed} removed stale, ${errors.length} error(s) (window ${occurrences.length}).`
  );
  return { produced, reused, removed, errors, windowCount: occurrences.length };
}

// Stale-clip sweep. CRITICAL, load-bearing rule: ONLY files matching the
// GENERATED pattern (/^promo_.+_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})\.mp3$/) are
// ever removed by this job -- operator-placed clips (ANY other filename:
// "moj-promo.mp3", "prireditve_december.mp3", anything) are untouchable by
// this job, forever. The greedy .+ swallows underscores in show ids, so the
// date/timeKey groups bind from the RIGHT end of the name. A generated clip
// is stale when no in-window occurrence carries its `<date>_<timeKey>` --
// e.g. the schedule changed, or the show slid past the horizon. A clip for an
// in-window occurrence that fell past maxClips is NOT stale (it still speaks
// a true sentence about a future show), so the key set is the FULL window,
// not the sliced work list.
function pruneStalePromos(inWindow) {
  const liveKeys = new Set(inWindow.map((occ) => `${occ.date}_${occ.timeKey}`));
  let names;
  try {
    names = fs.readdirSync(config.paths.imagingPromosDir);
  } catch {
    return 0; // no promos dir at all (cannot happen after the mkdir above, but honest)
  }
  let removed = 0;
  for (const name of names) {
    const m = GENERATED_PROMO_RE.exec(name);
    if (!m) continue; // operator clip -- never touched (see rule above)
    const key = `${m[1]}_${m[2]}`;
    if (liveKeys.has(key)) continue;
    fs.unlinkSync(path.join(config.paths.imagingPromosDir, name));
    removed++;
    log(`Removed stale promo clip ${name} (occurrence out of window).`);
  }
  return removed;
}

async function main() {
  const result = await producePromoClips();
  // `skipped === true` is the gated-off flag (strict identity, not
  // truthiness -- a real run's numbers are all numeric).
  if (result.skipped === true) {
    console.log('Promo producer skipped: imaging.promos.enabled is not true.');
    return;
  }
  console.log(
    `Promo producer: ${result.produced} produced, ${result.reused} reused, ${result.removed} removed stale, ${result.errors.length} error(s), window ${result.windowCount}.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
