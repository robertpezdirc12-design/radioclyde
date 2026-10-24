#!/usr/bin/env node
// As-run (izvajalno) poročilo export for license compliance (P4 #27): reads
// history/aired.jsonl -- the real track-start ledger -- and writes a CSV +
// text summary for the configured date window.
//
//   npm run asrun-export -- --from=2026-10-01 --to=2026-10-24 [--out=<dir>]
//
// --from/--to   inclusive window (yyyy-mm-dd), compared against the ledger's
//               own station-local date prefix; --from alone or --to alone
//               is fine (the missing bound falls back to today).
// --out         override the output dir (default <dataDir>/asrun)
//
// Fail-open: no ledger file (fresh deploy) still produces a valid, empty
// report -- compliance paperwork must never hard-fail the operator.
import path from 'node:path';
import { parseArgs } from '../lib/args.js';
import { config } from '../config/index.js';
import { toLocalISOString } from '../lib/time.js';
import {
  readAiredFile,
  filterWindow,
  buildRows,
  buildSummary,
  toCsv,
  toSummaryText,
  writeAsrunFiles,
} from '../auto/asrun.js';

const args = parseArgs(process.argv.slice(2));

const today = toLocalISOString().slice(0, 10);
const from = args.from ? String(args.from) : today;
const to = args.to ? String(args.to) : today;

try {
  const { entries, corruptCount, fileExists } = readAiredFile(config.paths.airedHistoryFile);
  const windowed = filterWindow(entries, from, to);
  const rows = buildRows(windowed);
  const summary = buildSummary(rows);
  const csv = toCsv(rows);
  const summaryText = toSummaryText(summary, from, to);
  const outDir = args.out ? path.resolve(String(args.out)) : path.join(config.dataDir, 'asrun');
  const { csvPath, summaryPath } = writeAsrunFiles({ csv, summaryText }, outDir, from, to);

  if (!fileExists) {
    console.log(`(history/aired.jsonl še ne obstaja -- prazno poročilo za ${from} .. ${to})`);
  }
  if (corruptCount > 0) {
    console.log(`(preskočenih pokvarjenih vrstic: ${corruptCount})`);
  }
  console.log(`Predvajanj v oknu ${from} .. ${to}: ${summary.total} (različnih del: ${summary.uniqueWorks}, izvajalcev: ${summary.uniqueArtists})`);
  for (const a of summary.artists.slice(0, 3)) {
    console.log(`  ${a.artist}: ${a.plays}`);
  }
  console.log(`asrun export: ${csvPath}`);
  console.log(`              ${summaryPath}`);
} catch (err) {
  console.error(`asrun export failed: ${err.message}`);
  process.exit(1);
}
