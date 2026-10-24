#!/usr/bin/env node
// Podcast export for one produced show (P4 #25): reads script.md (+tracks.json
// +context.json) from a show dir and writes podcast/podcast.xml (RSS 2.0 +
// itunes) and podcast/show-notes.md next to it.
//
//   npm run podcast-export -- --dir=<showDir> [--audio=<file>] [--title=<t>]
//                             [--date=<yyyy-mm-dd>] [--link=<url>] [--out=<dir>]
//
// --dir            the produced show occurrence dir (contains script.md)
// --audio          optional finished episode audio; the feed then carries a
//                  real enclosure (size/type read from the file)
// --title/--date   override the episode card (default: script title, today)
// --link           public base URL of the station site (enclosure host)
// --out            override the output dir (default <dir>/podcast)
//
// Deterministic: same inputs -> byte-identical outputs.
import path from 'node:path';
import { parseArgs } from '../lib/args.js';
import { runPodcastExport } from '../auto/podcast.js';

const args = parseArgs(process.argv.slice(2));
const dir = args.dir;

if (!dir) {
  console.error('Usage: npm run podcast-export -- --dir=<showDir> [--audio=<file>] [--title=<t>] [--date=<yyyy-mm-dd>] [--link=<url>] [--out=<dir>]');
  process.exit(1);
}

try {
  const result = runPodcastExport({
    dir: path.resolve(String(dir)),
    audio: args.audio ? path.resolve(String(args.audio)) : null,
    title: args.title ? String(args.title) : null,
    date: args.date ? String(args.date) : null,
    link: args.link ? String(args.link) : null,
    out: args.out ? path.resolve(String(args.out)) : null,
  });
  console.log(`podcast export: ${result.feedPath}`);
  console.log(`                ${result.notesPath}`);
  console.log(`chapters: ${result.chapters.length}`);
} catch (err) {
  console.error(`podcast export failed: ${err.message}`);
  process.exit(1);
}
