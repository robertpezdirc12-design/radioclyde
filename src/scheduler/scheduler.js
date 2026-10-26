#!/usr/bin/env node
// The scheduling half of the station: owns every timing decision. Each job
// is a plain exported async function living in its own module -- so each
// stays independently testable/dry-runnable -- wired here to its own
// interval. A crash inside any one job's tick is caught and logged without
// touching the others; heavy/slow work (LLM calls, TTS synthesis) still
// runs serialized via lib/concurrency.js's runSerialized, never overlapping.
//
// startScheduler() is called once, from src/server/index.js's startup, in
// the same process as the Fastify web/studio server -- there is no longer a
// separate radioclyde-scheduler process. Kept independently runnable below
// (`node src/scheduler/scheduler.js`) for local debugging.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import * as scheduleUtil from './scheduleUtil.js';
import { checkScheduleChanged } from './scheduleWatch.js';
import { checkAndTriggerScripts } from './scheduleScripts.js';
import { checkAndTriggerDirect, rebuildIncompleteOccurrences } from './scheduleDirect.js';
import { checkAndTriggerPrewarmAudio } from './schedulePrewarmAudio.js';
import { updateNowPlaying } from './updateNowPlaying.js';
import { generateFillerPlaylist } from './generateFillerPlaylist.js';
import { cleanupOldShows } from './cleanupOldShows.js';
import { backupStation } from './backupStation.js';
import { restartChatterbox } from './restartChatterbox.js';
import { writeImagingPlaylists } from './imagingPlaylists.js';
import { producePromoClips } from './promoProducer.js';
import { formatClockTick } from './formatClock.js';
import { runAutocueScan } from './autocueScan.js';
import { pushDispatchTick } from './pushDispatch.js';
import { sampleNow } from '../analytics/listenerSamples.js';

const log = createLogger('station');

// Cadence guard for every() registration below. The ?. + ?? chains already
// saved the missing-key case, but 10 of 14 jobs still passed garbage
// straight through: an explicit 0/negative -> setInterval(0) = a 1ms tick
// storm, and a string like 'abc' -> 'abc' * 60000 = NaN -> setInterval(NaN)
// ALSO clamps to 1ms. The four Math.max(1, ...) sites didn't help either --
// Math.max(1, 'abc') is NaN (?? only catches null/undefined, and Number
// coercion inside Math.max turns junk into NaN before the max runs). One
// central refusal instead: finite AND > 0 passes through (fractional values
// included -- nowPlayingCheckIntervalMinutes defaults to 0.1 = 6 s, which
// must keep working), anything else falls back to the job's default.
export function cadence(value, fallbackMinutes) {
  const n = Number(value ?? fallbackMinutes);
  return Number.isFinite(n) && n > 0 ? n : fallbackMinutes;
}

function every(minutes, label, fn) {
  const tick = async () => {
    try {
      await fn();
    } catch (err) {
      log(`${label} ERROR: ${err.stack || err.message}`);
    }
  };
  tick(); // run once immediately at startup, then on the interval
  setInterval(tick, minutes * 60 * 1000);
}

// Runs once at process start, before the interval jobs get a chance to act,
// so a restart immediately tells you where every upcoming show actually
// stands (no script yet / script done but not directed yet / fully directed)
// instead of that only being inferrable by watching for the next tick to
// either act or silently skip it.
function logStartupStatus() {
  const schedule = scheduleUtil.loadSchedule();
  const now = new Date();
  const horizonMinutes = Math.max(config.schedule?.scriptLeadTimeMinutes ?? 120, 24 * 60);
  const occurrences = scheduleUtil
    .upcomingOccurrences(schedule, now, horizonMinutes)
    .sort((a, b) => a.minutesUntil - b.minutesUntil);

  if (occurrences.length === 0) {
    log(`Startup: no shows scheduled in the next ${horizonMinutes}min.`);
    return;
  }

  log(`Startup: ${occurrences.length} show occurrence(s) scheduled in the next ${horizonMinutes}min:`);
  for (const { show, weekday, date, timeKey, minutesUntil } of occurrences) {
    const readiness = scheduleUtil.occurrenceReadiness(weekday, show.id, date, timeKey);

    let status;
    if (readiness === 'directed') {
      status = 'directed -- ready to air';
    } else if (readiness === 'script') {
      status =
        minutesUntil <= (config.schedule?.directLeadTimeMinutes ?? 15)
          ? 'script ready -- direct/audio job should pick it up this tick'
          : `script ready, awaiting audio creation (director triggers ${config.schedule?.directLeadTimeMinutes}min before air)`;
    } else {
      status =
        minutesUntil <= (config.schedule?.scriptLeadTimeMinutes ?? 120)
          ? 'no script yet -- producer should pick it up this tick'
          : `not yet due (script production triggers ${config.schedule?.scriptLeadTimeMinutes}min before air)`;
    }
    log(`  "${show.id}" airs ${weekday} ${date} ${show.startTime} (in ${minutesUntil}min): ${status}`);
  }
}

// Hourly-archive retention (SUB/WAVE's day-granular prune, see
// docs/stream-mounts.md): removes WHOLE <dataDir>/archive/YYYY-MM-DD/ day
// directories once they age past config.archive.retentionDays. Day-granular
// on purpose, exactly like SUB/WAVE's pruneOlderThan: the prune compares
// date strings, never mtimes, so it can never unlink the CURRENT hour's
// still-open file -- the newest thing it will ever remove is yesterday.
// Double guard below: a day dir is removed only when it is older than the
// cutoff AND strictly older than today, so today's and future dirs survive
// even under a negative retentionDays (a hand-edit typo must not be able to
// wipe the live archive). Non-date neighbours in the archive dir are left
// untouched. Missing archive dir (feature never enabled / fresh install)
// and a missing config.archive block are both honest no-ops -- NOT a
// default-30-days sweep, because a station that never opted into the
// archive must not start deleting directories some other tool put there.
const ARCHIVE_DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Takes the archive block as an optional argument (defaulting to the live
// config's) so tests can exercise retention windows without a second
// process -- the every() wiring below calls it with no arguments, which is
// the production path.
export async function pruneArchives(archiveConfig = config.archive) {
  if (!archiveConfig) return { removed: 0 };
  const retentionDays = archiveConfig.retentionDays ?? 30;
  // 0 = keep forever (SUB/WAVE's documented semantics); non-numeric junk is
  // refused rather than guessed at.
  if (!Number.isFinite(retentionDays) || retentionDays === 0) return { removed: 0 };

  const archiveDir = path.join(config.dataDir, 'archive');
  let dayDirs;
  try {
    dayDirs = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ARCHIVE_DATE_DIR_RE.test(e.name));
  } catch {
    return { removed: 0 }; // no archive dir yet (feature off / fresh install)
  }

  const cutoff = scheduleUtil.dateKey(new Date(Date.now() - retentionDays * DAY_MS));
  const today = scheduleUtil.dateKey(new Date());
  let removed = 0;
  for (const entry of dayDirs) {
    // String compare on YYYY-MM-DD keys is a calendar compare. The second
    // condition is the guard that keeps today/future alive no matter what
    // retentionDays said (negative values push the cutoff into the future).
    if (!(entry.name < cutoff && entry.name < today)) continue;
    const target = path.join(archiveDir, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
    removed++;
    log(`Removed ${target} (older than ${retentionDays}d)`);
  }
  if (removed > 0) {
    log(`Archive prune complete: removed ${removed} day director${removed === 1 ? 'y' : 'ies'} (retention ${retentionDays}d).`);
  }
  return { removed };
}

// try/catch here matters more than for a typical exported function: this is
// called from src/server/index.js's startup, in the same process as the
// public site/stream/studio -- a startup-time throw here (e.g. a malformed
// station.json) must not be allowed to take Fastify's own listen() down with
// it. Job-tick errors are already isolated by every()'s own try/catch; this
// guards logStartupStatus()/rebuildIncompleteOccurrences(), which run before
// any job registration.
export function startScheduler() {
  log('Scheduler starting...');
  try {
    logStartupStatus();
  } catch (err) {
    log(`Startup status ERROR: ${err.stack || err.message}`);
  }

  // Fire-and-forget, same as every()'s own immediate tick() below: it chains
  // onto the same runSerialized tail as the scripts/direct jobs (so it never
  // overlaps their TTS/LLM work), but startup itself doesn't block on it.
  rebuildIncompleteOccurrences().catch((err) => log(`Startup rebuild-check ERROR: ${err.stack || err.message}`));

  every(cadence(config.schedule?.scheduleWatchIntervalMinutes, 1), 'schedule_watch', checkScheduleChanged);
  // F2 class of defect, eliminated everywhere below: every cadence knob is
  // optional-chained + defaulted. A hand-edited config missing one of these
  // keys used to read as undefined -> undefined * 60000 = NaN, and
  // setInterval(NaN) clamps to 1 ms -- a runaway tick storm. (A missing whole
  // BLOCK, e.g. no "cleanup" key at all, was even worse: a TypeError at
  // registration that silently killed every job registered after it, inside
  // startScheduler() where every()'s per-tick try/catch can't help.) Defaults
  // are the shipped config.example.json values, so a complete config boots
  // byte-identically to before.
  every(cadence(config.schedule?.scriptCheckIntervalMinutes, 15), 'schedule_scripts', checkAndTriggerScripts);
  every(cadence(config.schedule?.directCheckIntervalMinutes, 2), 'schedule_direct', checkAndTriggerDirect);
  every(cadence(config.schedule?.prewarmCheckIntervalMinutes ?? config.schedule?.scriptCheckIntervalMinutes, 15), 'schedule_prewarm', checkAndTriggerPrewarmAudio);
  // Kept far tighter than the other jobs' intervals -- this is the one that
  // gates on-air continuity: show_source's playlist (radio.liq) empties out
  // the instant a show's real audio ends, and fallback() drops to filler
  // immediately, so whatever gap exists between that moment and this job
  // noticing and rewriting now_playing.m3u is audible dead-air-filler on
  // every single transition (listener report, 2026-08-27). The job itself is
  // cheap (a couple of small local file reads), so polling this often is fine.
  every(cadence(config.schedule?.nowPlayingCheckIntervalMinutes, 0.1), 'now_playing', updateNowPlaying);
  every(cadence(config.filler?.regenerateIntervalMinutes, 360), 'filler', generateFillerPlaylist);
  every(cadence(config.cleanup?.intervalMinutes, 360), 'cleanup', cleanupOldShows);
  every(cadence(config.backup?.intervalMinutes, 1440), 'backup', backupStation);
  // Hourly-archive retention (SUB/WAVE's day-granular prune): default
  // sweep once a day -- day-granular pruning needs no tighter cadence. ?.
  // + ?? like every other optional block: configs without an archive
  // block (the shipped default -- the feature is opt-in) register a
  // no-op tick instead of throwing the F2-class boot TypeError.
  every(cadence(config.archive?.pruneIntervalMinutes, 1440), 'archive_prune', pruneArchives);
  // ?. matters: config.linux.json ships WITHOUT a chatterbox block (auto-radio
  // installs have no Chatterbox to restart), and reading
  // config.chatterbox.restartIntervalMinutes unguarded threw TypeError at boot
  // -- which silently killed every job registered AFTER it (auditor's F2 class
  // of defect, caught by the listener-analytics smoke test on 2026-10-24).
  every(cadence(config.chatterbox?.restartIntervalMinutes, 1440), 'chatterbox_restart', restartChatterbox);
  // Audience memory: one Icecast status poll per minute appended to the
  // listener-samples ledger (analytics/listenerSamples.js) -- the studio
  // Analytics view charts it and joins it with aired.jsonl for per-track
  // impact. Optional-chained + defaulted everywhere so existing configs
  // without an analytics block keep booting exactly as before; the sample
  // itself is also honest on failure (a gap entry, not a skipped tick).
  every(cadence(config.analytics?.sampleIntervalMinutes, 1), 'listener_sample', sampleNow);
  // Imaging layer: refresh the id/stingers/emergency .m3u playlists from their
  // clip directories (scheduler/imagingPlaylists.js -- Liquidsoap watches the
  // files; a rewrite is also what refills an exhausted layer's pool).
  // Optional-chained + defaulted like every other optional block, so configs
  // without an imaging block boot exactly as before (the F2 class of defect
  // caught by the chatterbox regression on 2026-10-24 -- must not come back).
  // The rescan is cheap (four small dir listings); it runs at boot too via
  // every()'s immediate first tick, so the .m3u files exist from the start.
  every(cadence(config.imaging?.checkIntervalMinutes, 30), 'imaging', writeImagingPlaylists);
  // Promo layer (Paket B2): auto-produce schedule-driven promo clips (Edge
  // TTS, loudness-aligned) into imaging/promos/ and refresh promos.m3u.
  // OPT-IN: imaging.promos.enabled === true -- a layer that SPEAKS on air
  // must never appear unannounced on an existing install (degradation
  // ladder stays "layer absent"). ?. + ?? like every optional block (F2).
  // every() receives the job function directly, exactly like the imaging
  // registration above (the job's own seams keep it testable without a
  // wrapper).
  if (config.imaging?.promos?.enabled === true) {
    every(cadence(config.imaging?.promos?.checkIntervalMinutes ?? 30), 'promo_producer', producePromoClips);
  }
  // Format clock (Paket D1): the hourly template spoken as BEDS over the
  // music -- weather at the weatherMinutes marks, the next-show handoff
  // nextShowLeadMinutes before the switch (scheduler/formatClock.js, pushed
  // through the existing beds telnet queue + sidechain ducker; NO radio.liq
  // change). OPT-IN for the same reason as promos: a layer that SPEAKS on
  // air must never appear unannounced on an existing install. The default
  // cadence is FRACTIONAL on purpose (0.1 = 6 s, the nowPlayingCheck
  // precedent -- cadence() passes fractional values through): the fire
  // window is 45 s, so the tick must land inside it reliably, and the
  // no-tick-work path is two file reads (ledger + dir listing).
  if (config.imaging?.beds?.enabled === true) {
    every(cadence(config.imaging?.beds?.tickIntervalMinutes, 0.1), 'format_clock', formatClockTick);
  }
  // R128 loudness alignment (lib/autocue.js + radio.liq's amplify()): one
  // pass over the library per tick, budgeted to maxAnalyzePerRun analyses so
  // a first-ever sweep is spread across ticks. Optional-chained + defaulted
  // like every other optional block: configs without an autocue block boot
  // exactly as before, and a no-ffmpeg or empty-library box simply logs a
  // zero-work scan each tick.
  every(cadence(config.autocue?.checkIntervalMinutes, 60), 'autocue', runAutocueScan);
  // P5 #4 push obvestila: oddaje se zacikajo tocno na startTime, zato je
  // minuto natancnost tu kljucna (leadMinutes se nadalje skraja okno).
  // ?. + ?? povsod: config.linux.json NE vsebuje push bloka, branje brez
  // zašcitne verige bi bilo naslednje ponovitev F2-razreda (TypeError ob
  // zagonu tiho ubije vse jobe registrirane za to vrstico -- analytics
  // regresija 2026-10-24, ki se NE SME vrniti).
  // enabled !== false: config.example.json obljublja "enabled" stikalo, in
  // stikalo, ki ga nic ne bere, je laž -- izklopljen dispatch tick tudi
  // pomeni, da posljalci nikoli ne dobijo obvestil, medtem ko rute se
  // odgovorijo posteno (503). Odsoten blok = prizanesljivo prazen tick
  // (en JSON read), zato default ON ohranja obnasanje obstojecih konfigov.
  if (config.push?.enabled !== false) {
    every(cadence(config.push?.checkIntervalMinutes, 1), 'push_dispatch', pushDispatchTick);
  }

  log('Scheduler started.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startScheduler();
}
