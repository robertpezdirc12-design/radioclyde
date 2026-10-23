#!/usr/bin/env node
// Full dry-run of the auto (no-AI) producer for one show: parses the brief
// deterministically, builds the track queue from Plex-or-local, renders the
// template script, validates it, and prints everything. Writes the same
// script.md/tracks.json/transcript.json/context.json the scheduler's
// producer would, so the output can be fed straight to
// `npm run direct-show` when you're happy with it.
//
//   npm run preview-auto-show -- <show-name> [--duration=<minutes>] [--offline]
//
//   <show-name>   resolves show-descriptions/<name>.md under dataDir (or a
//                 full/relative path to the brief file)
//   --duration    override the slot length in minutes (default 30)
//   --offline     force the local library and a stubbed weather source, so
//                 the run never touches Plex or the network -- useful for
//                 trying the pipeline before any real library is wired up
//
// Voice audio is NOT synthesized here (run `npm run direct-show` for that);
// this is the "is the tracklist and script sensible" checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { parseArgs } from '../lib/args.js';
import * as scheduleUtil from '../scheduler/scheduleUtil.js';
import { parseScript, renderScript } from '../script/format.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { parseShowBrief } from '../producer/showBrief.js';
import { buildTrackQueue } from '../producer/trackSelection/queue.js';
import { produceTrackQueryDeterministic } from '../auto/briefQuery.js';
import { listGenreTagsAny, listAlbumGenreTagsAny } from '../auto/librarySource.js';
import { artistCooldownFilter, popularityShare, timeBlockKey } from '../auto/rules.js';
import { buildSegmentsAuto } from '../auto/scriptBuilder.js';

const args = parseArgs(process.argv.slice(2));
const showName = args._?.[0];

if (!showName) {
  console.error('Usage: npm run preview-auto-show -- <show-name> [--duration=<minutes>] [--offline]');
  process.exit(1);
}

// --offline forces the local library (the source router then never contacts
// Plex). Live time/weather lines are resolved at DIRECT time, not here, so
// this preview needs no network at all.
if (args.offline) {
  config.autoRadio = {
    ...(config.autoRadio ?? {}),
    enabled: true,
    music: { ...(config.autoRadio?.music ?? {}), source: 'local' },
  };
}

const durationMinutes = args.duration ? parseInt(args.duration, 10) : 30;

const briefPath = path.isAbsolute(showName)
  ? showName
  : fs.existsSync(showName)
    ? showName
    : path.join(config.paths.showDescriptionsDir, `${showName}.md`);

if (!fs.existsSync(briefPath)) {
  console.error(`Brief not found: ${briefPath}`);
  process.exit(1);
}
const descriptionText = fs.readFileSync(briefPath, 'utf8');
const brief = parseShowBrief(descriptionText, {
  defaultRepeatWindowDays: config.scripts?.defaultRepeatWindowDays ?? 7,
});

console.log(`\n=== preview-auto-show: ${brief.title ?? showName} (${durationMinutes} min) ===`);
console.log(`brief: ${briefPath}`);
console.log(`time block: ${timeBlockKey() ?? 'n/a'}`);

// Phase A: deterministic query + queue
const [genreTags, albumGenreTags] = await Promise.all([listGenreTagsAny(), listAlbumGenreTagsAny()]);
console.log(`\n-- genre tags available: ${genreTags.slice(0, 20).join(', ')}${genreTags.length > 20 ? `, ... (${genreTags.length} total)` : ''}`);

const { query } = produceTrackQueryDeterministic({
  trackSelectionText: brief.trackSelectionText,
  genreTags,
  albumGenreTags,
});
console.log(`\n-- resolved query:\n${JSON.stringify(query, null, 2)}`);

const cooldown = artistCooldownFilter();
console.log(`\n-- artist cooldown: ${cooldown.cooldownHours}h (${cooldown.excludeArtists.size} artist(s) currently warm)`);
const popularShare = popularityShare();
console.log(`-- popularity mix: ${popularShare == null ? 'off (plain weighted shuffle)' : `${Math.round(popularShare * 100)}% popular`}`);

const trackQueueResult = await buildTrackQueue({
  ...query,
  targetDurationMinutes: durationMinutes,
  repeatWindowDays: brief.repeatWindowDays,
  excludeArtists: cooldown.excludeArtists,
  popularShare,
  decadeSpread: config.autoRadio?.rules?.decadeSpread ?? true,
});

const tracks = trackQueueResult.tracks;
console.log(
  `\n-- queue: ${tracks.length} tracks, pool ${trackQueueResult.poolSize}, ` +
    `cooldown excluded ${trackQueueResult.cooldownExcluded ?? 0}${trackQueueResult.cooldownBypassed ? ' (BYPASSED -- pool starved)' : ''}, ` +
    `music ${(trackQueueResult.estimatedMusicMs / 60000).toFixed(1)} min of ${durationMinutes} target`
);

// Phase C+D: template segments
const { segments } = buildSegmentsAuto({ tracks, brief, showId: showName, date: scheduleUtil.dateKey(new Date()) });
const markdown = renderScript({ title: brief.title || showName, durationMinutes, segments });

const knownRatingKeys = new Map(tracks.map((t) => [String(t.ratingKey), t]));
const validation = parseScript(markdown, {
  requiredDurationMinutes: durationMinutes,
  personas: loadPersonas(),
  knownRatingKeys,
});

console.log('\n=== rendered script ===\n');
console.log(markdown);
console.log('=== validation ===');
console.log(validation.ok ? 'OK' : `ISSUES: ${validation.issues.join(' | ')}`);
if (validation.warnings?.length) console.log(`WARNINGS: ${validation.warnings.join(' | ')}`);

console.log('\n=== tracklist ===');
for (const t of tracks) {
  console.log(`  ${t.artist} -- ${t.title} (${t.album ?? 'no album'}${t.year ? `, ${t.year}` : ''}) [${(t.durationMs / 60000).toFixed(1)} min]`);
}

// Write the same artifacts the scheduler's producer would, so this run can
// be directed as-is.
const runDir = scheduleUtil.dateDir(scheduleUtil.weekdayKey(new Date()), showName, scheduleUtil.dateKey(new Date()));
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'script.md'), markdown);
fs.writeFileSync(path.join(runDir, 'tracks.json'), JSON.stringify(tracks, null, 2));
console.log(`\nwrote ${path.join(runDir, 'script.md')} (+ tracks.json)`);
console.log(`next step: npm run direct-show -- --id=${showName} --weekday=<weekday> --date=<yyyy-mm-dd> --time=<HH:MM>`);
