#!/usr/bin/env node
// P4 #18 CLI -- inspect and materialize the themed show catalog
// (src/auto/showCatalog.js). Complements the weekly special slot in
// station.json: whatever the slot resolves to, this is how an operator can
// see the catalog, preview a theme's brief, or write one out by hand.
//
//   npm run themed-shows -- list
//       The whole catalog: id, title, and the structured selection lines the
//       theme will put into its brief's "## Track Selection".
//
//   npm run themed-shows -- brief <theme-id> [durationMinutes]
//       Print the rendered brief to stdout without writing anything.
//       Personas resolve like the slot does: "special.personas" is a station
//       matter, so the CLI takes the first prompts.json persona, or the
//       --personas override.
//
//   npm run themed-shows -- ensure <theme-id> [durationMinutes]
//       Write/refresh show-descriptions/themed/<id>.md (same content rule as
//       the automatic path: rewrite only when the rendered content differs)
//       and print the relative path.
//
//   npm run themed-shows -- resolve
//       For every special slot in station.json: which theme THIS week
//       resolves to, and where its brief lives.
//
// Flags: --personas=elena,ryan (brief/ensure), plain config.json + dataDir
// otherwise -- same rules as every other CLI in src/cli/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(repoRoot, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`config.json not found at ${configPath}. Copy config.example.json to config.json and fill in real values.`);
  process.exit(1);
}

const argv = parseArgs(process.argv.slice(2));
const [command, themeArg, durationArg] = argv._ ?? [];

const { THEMED_SHOWS, getThemedShow, renderThemedBrief, ensureThemedBrief, themedBriefRelPath, resolveSpecialTheme } =
  await import('../auto/showCatalog.js');
const { loadSchedule } = await import('../scheduler/scheduleUtil.js');
const { loadPersonas } = await import('../scheduler/promptsUtil.js');
const { config } = await import('../config/index.js');

function personasFor() {
  const explicit = String(argv.personas ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;
  let personas = {};
  try {
    personas = loadPersonas();
  } catch {
    // prompts.json absent (fresh checkout / smoke dataDir) -- honest error below
  }
  const first = Object.keys(personas)[0];
  if (!first) {
    console.error('No personas available: define personas in prompts.json or pass --personas=<comma-list>.');
    process.exit(1);
  }
  return [first];
}

function durationFor() {
  const n = parseInt(durationArg ?? argv.duration ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

switch (command) {
  case 'list': {
    console.log(`${THEMED_SHOWS.length} themed shows in the catalog:\n`);
    for (const theme of THEMED_SHOWS) {
      console.log(`${theme.emoji}  ${theme.id}  --  ${theme.title}`);
      for (const line of theme.trackSelection) console.log(`     ${line}`);
      console.log('');
    }
    console.log('Schedule a weekly special slot in station.json, e.g.:');
    console.log('  { "id": "special", "startTime": "20:00", "durationMinutes": 60,');
    console.log(`    "special": { "themes": [${THEMED_SHOWS.slice(0, 3).map((t) => `"${t.id}"`).join(', ')}] } }`);
    break;
  }

  case 'brief': {
    const theme = getThemedShow(themeArg);
    if (!theme) {
      console.error(`Unknown themed show "${themeArg ?? ''}". Available: ${THEMED_SHOWS.map((t) => t.id).join(', ')}.`);
      process.exit(1);
    }
    process.stdout.write(renderThemedBrief(theme, { durationMinutes: durationFor(), personas: personasFor() }));
    break;
  }

  case 'ensure': {
    const theme = getThemedShow(themeArg);
    if (!theme) {
      console.error(`Unknown themed show "${themeArg ?? ''}". Available: ${THEMED_SHOWS.map((t) => t.id).join(', ')}.`);
      process.exit(1);
    }
    const rel = ensureThemedBrief(theme, { durationMinutes: durationFor(), personas: personasFor() });
    console.log(`${path.join(config.dataDir, rel)} is up to date.`);
    break;
  }

  case 'resolve': {
    const schedule = loadSchedule();
    const specials = Object.entries(schedule).flatMap(([weekday, shows]) =>
      shows.filter((s) => s.special).map((s) => ({ weekday, show: s }))
    );
    if (specials.length === 0) {
      console.log('No special slots in station.json -- add one with { "special": { "themes": [...] } }.');
      break;
    }
    for (const { weekday, show } of specials) {
      try {
        const theme = resolveSpecialTheme(show.special, new Date());
        console.log(`${weekday} ${show.startTime} -- ${theme.emoji} ${theme.title} (${themedBriefRelPath(theme.id)})`);
      } catch (err) {
        console.log(`${weekday} ${show.startTime} -- NOT RESOLVABLE: ${err.message}`);
      }
    }
    break;
  }

  default:
    console.error('Usage: npm run themed-shows -- list | brief <id> [minutes] | ensure <id> [minutes] | resolve');
    process.exit(command ? 1 : 0);
}
