#!/usr/bin/env node
// Social export for one produced show (P4 #25): reads script.md and writes
// a deterministic set of ready-to-post Slovenian one-liners into
// <dir>/social/ (or --out). The rubric bodies ARE the posts -- the same
// lines the TTS speaks on air, cleaned of template dashes and fitted under
// the length limit with the station hashtag.
//
//   npm run social-export -- --dir=<showDir> [--out=<dir>]
//
// Deterministic: same inputs -> byte-identical outputs.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../lib/args.js';
import { parseScript } from '../script/format.js';
import { socialPostsFromSegments } from '../auto/social.js';

const args = parseArgs(process.argv.slice(2));
const dir = args.dir;

if (!dir) {
  console.error('Usage: npm run social-export -- --dir=<showDir> [--out=<dir>]');
  process.exit(1);
}

const scriptPath = path.join(dir, 'script.md');
if (!fs.existsSync(scriptPath)) {
  console.error(`social export failed: no script.md in ${dir} -- run the producer (or preview-auto-show) first.`);
  process.exit(1);
}

const markdown = fs.readFileSync(scriptPath, 'utf8');
const { segments, title } = parseScript(markdown);

const outDir = args.out ? path.resolve(String(args.out)) : path.join(dir, 'social');
fs.mkdirSync(outDir, { recursive: true });

const posts = socialPostsFromSegments({ segments, title: title ?? path.basename(dir), date: new Date().toISOString().slice(0, 10) });
for (const post of posts) {
  fs.writeFileSync(path.join(outDir, post.file), post.text);
}
console.log(`social export: ${posts.length} posts -> ${outDir}`);
for (const post of posts) console.log(`  ${post.file} (${post.text.length})`);
