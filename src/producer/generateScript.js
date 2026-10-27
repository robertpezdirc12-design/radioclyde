#!/usr/bin/env node
// The show producer: takes a show-description brief and turns it into a
// validated `.script.md` (per script-format.md) through the deterministic
// auto pipeline -- zero AI model calls anywhere. Every phase is plain code:
//
//   A. Track selection -- auto/briefQuery.js parses the brief's loose
//      "## Track Selection" text deterministically, then
//      trackSelection/queue.js's buildTrackQueue() picks real tracks (with
//      the auto rules layered on: artist cooldown, popularity mix, decade
//      spread, time-of-day genre steering) -- fully deterministic.
//   B. Rubric data -- auto/feeds.js + auto/trivia.js collect real data
//      (weather/sport/news/on-this-day/quiz/poll/trivia); every source
//      nulls out on failure so a show degrades to fewer segments, never
//      to no show.
//   C+D. Script assembly -- auto/scriptBuilder.js walks the tracklist and
//      renders every spoken line from the station's template pools (with
//      the Val 28 C1 fencepost map deciding which boundaries talk at all).
//   E. Review pass -- none by construction (templates can't drift).
//
// History note (Val 28, "samo skripte brez AI modelov"): this file used to
// branch on config.autoRadio.enabled into an AI-mode pipeline that resolved
// the track query, researched Wikipedia facts, wrote every DJ move and
// reviewed the script through an LM Studio model (qwen3.6-35b-a3b), spoken
// by a self-hosted Chatterbox TTS. That whole layer is REMOVED -- the
// deterministic pipeline is the only producer. See docs/auto-radio.md for
// the single-pipeline architecture.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { parseArgs } from '../lib/args.js';
import { toLocalISOString } from '../lib/time.js';
import * as scheduleUtil from '../scheduler/scheduleUtil.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { runAutoProducerPipeline, recordAutoPlayedTracks } from '../auto/produce.js';
import { resolveSpecialTheme, ensureThemedBrief } from '../auto/showCatalog.js';

const log = createLogger('station');

function loadShowEntry(id, date) {
  if (!fs.existsSync(config.paths.stationFile)) return null;
  // Paket C1 (Val 22): a date override can carry shows that exist NOWHERE
  // in the weekly template (a one-off holiday special) -- search the date's
  // own override first, then fall back to the weekly template as before.
  // Without this, an override-only show's generateScript would throw "No
  // show ... found" and the slot would fall to filler.
  if (date) {
    const override = scheduleUtil.loadDateOverrides()[date]?.find((s) => s.id === id);
    if (override) return override;
  }
  const schedule = scheduleUtil.loadSchedule();
  for (const day of Object.keys(schedule)) {
    const match = schedule[day].find((s) => s.id === id);
    if (match) return match;
  }
  return null;
}

// The importable half of the CLI below -- also called in-process,
// serialized, by scheduler/scheduleScripts.js. Takes weekday/date/description/
// duration directly rather than reading process.argv, same split as
// director/index.js's directShow()/cli/directShow.js.
export async function generateScript({ id, weekday, date, descriptionPath, durationMinutes } = {}) {
  const now = new Date();
  weekday = weekday || scheduleUtil.weekdayKey(now);
  date = date || scheduleUtil.dateKey(now);

  if (!descriptionPath || !durationMinutes) {
    const entry = loadShowEntry(id, date);
    if (!entry) {
      throw new Error(
        `No show "${id}" found in ${config.paths.stationFile}, and no description/duration given directly.`
      );
    }
    descriptionPath = descriptionPath || entry.description;
    durationMinutes = durationMinutes || entry.durationMinutes;
    // P4 #18 -- the weekly special slot. loadSchedule() already resolved the
    // entry against the current week, but the script must key on THIS
    // occurrence's date: the one case where the two disagree (a Sunday-night
    // prewarm of a Monday 00:00 slot sits in the previous ISO week but airs
    // in the new one) crosses the boundary between them, so re-resolve here
    // with the occurrence date and materialize the brief on disk before the
    // readFileSync below. An explicitly passed descriptionPath (CLI tools)
    // still wins over the slot's own resolution.
    if (entry.special && !descriptionPath) {
      const theme = resolveSpecialTheme(entry.special, date);
      ensureThemedBrief(theme, {
        durationMinutes,
        personas: entry.special.personas ?? [Object.keys(loadPersonas())[0]],
      });
      log(`[${id}] special slot resolves to themed show "${theme.id}" for ${date}.`);
    }
  }

  // show-descriptions/*.md live under config.dataDir now, alongside
  // station.json -- resolve any relative description path (as recorded in
  // station.json, e.g. "show-descriptions/elvis-lookback.md") against that,
  // not the code checkout.
  const resolvedDescriptionPath = path.isAbsolute(descriptionPath)
    ? descriptionPath
    : path.join(config.dataDir, descriptionPath);
  const descriptionText = fs.readFileSync(resolvedDescriptionPath, 'utf8');

  log(`Starting producer pipeline for "${id}" (${durationMinutes}min) from ${resolvedDescriptionPath}`);

  const runDir = scheduleUtil.dateDir(weekday, id, date);

  try {
    const { markdown, tracks, debug } = await runAutoProducerPipeline({ id, descriptionText, durationMinutes, date });

    // Recorded now, at finalization, not on every intermediate lookup or on
    // a failed run -- a script that never finished shouldn't burn down the
    // eligible-track pool for a retry of the same brief. Same recording rule
    // and same entry shape as always, so artist cooldown and station-wide
    // repeat exclusion keep seeing shows exactly like they always did.
    recordAutoPlayedTracks(tracks, id);

    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'script.md'), markdown);
    fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify(debug, null, 2));
    // The director resolves ratingKeys without a live metadata lookup -- the
    // full track objects are written as a sidecar next to script.md and read
    // back by director/scriptLoader.js (which keeps a Plex-resolution
    // fallback for scripts produced before the single-pipeline switch).
    fs.writeFileSync(path.join(runDir, 'tracks.json'), JSON.stringify(tracks, null, 2));
    fs.writeFileSync(
      path.join(runDir, 'context.json'),
      JSON.stringify(
        {
          id,
          weekday,
          date,
          descriptionPath: resolvedDescriptionPath,
          durationMinutes,
          repeatWindowDays: debug.brief.repeatWindowDays,
          mode: 'auto',
          generatedAt: toLocalISOString(),
          trackCount: tracks.length,
          validationOk: debug.validation.ok,
        },
        null,
        2
      )
    );

    log(`Wrote script for "${id}" to ${runDir} (${tracks.length} tracks).`);
    return { markdown, runDir, tracks };
  } catch (err) {
    fs.mkdirSync(runDir, { recursive: true });
    if (err.debug) {
      fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify(err.debug, null, 2));
    }
    fs.writeFileSync(path.join(runDir, 'error.json'), JSON.stringify({ message: err.message }, null, 2));
    log(`FAILED for "${id}" -- ${err.message}`);
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { id } = args;
  if (!id) {
    throw new Error(
      'Usage: generateScript.js --id=<showId> [--weekday=<weekday> --date=<yyyy-mm-dd>] [--description=<path/to/brief.md> --duration=<minutes>]'
    );
  }

  const { markdown } = await generateScript({
    id,
    weekday: args.weekday,
    date: args.date,
    descriptionPath: args.description,
    durationMinutes: args.duration ? parseInt(args.duration, 10) : undefined,
  });

  console.log(markdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
