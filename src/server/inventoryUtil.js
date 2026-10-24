// Min-inventory readiness for the studio Diagnostics view (P2 #7, WRIT-FM
// borrow -- "zdravstveno merilo zaloge" mapped to "is the next slot's content
// ready"). For each upcoming occurrence: does script.md exist, does it parse,
// and does its segment inventory meet the station's minimums. Every miss is
// reported, never invented: a missing script is { exists: false }, a broken
// script carries its parse issues, a thin script carries the inventory
// shortfalls. Same honest-failure rules as diagnosticsUtil.js.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { dateDir } from '../scheduler/scheduleUtil.js';
import { parseScript } from '../script/format.js';
import { segmentInventory } from '../script/segments.js';

// WRIT-FM's defaults (>=3 spoken breaks/slot; >=20 tracks/hour scaled to our
// 3.5-5 min library = 6 per 30 min), overridable in config.shows.inventory.
export function inventoryThresholds() {
  const inv = config.shows?.inventory ?? {};
  return {
    minSpeechSegments: inv.minSpeechSegments ?? 3,
    minTracksPer30Minutes: inv.minTracksPer30Minutes ?? 6,
  };
}

// One occurrence's readiness. Never throws -- a bad script IS the report.
export function inventoryForOccurrence({ id, weekday, date, durationMinutes }) {
  const scriptPath = path.join(dateDir(weekday, id, date), 'script.md');
  if (!fs.existsSync(scriptPath)) {
    return {
      scriptPath,
      exists: false,
      parsedOk: null,
      issues: [],
      inventory: null,
      ready: false,
      note: 'script.md not generated yet',
    };
  }

  let markdown;
  try {
    markdown = fs.readFileSync(scriptPath, 'utf8');
  } catch (err) {
    return {
      scriptPath,
      exists: true,
      parsedOk: null,
      issues: [`unreadable: ${err.message}`],
      inventory: null,
      ready: false,
    };
  }

  // Shape-only parse: no persona table (persona checks are the production
  // path's contract, not diagnostics'), no ratingKey resolution (Plex is not
  // a diagnostics dependency). Blocking production remains parseScript's
  // original job; this layer only REPORTS.
  const parsed = parseScript(markdown);
  if (!parsed.ok) {
    return { scriptPath, exists: true, parsedOk: false, issues: parsed.issues, inventory: null, ready: false };
  }

  const inventory = segmentInventory(parsed.segments, {
    durationMinutes: durationMinutes ?? parsed.durationMinutes,
    ...inventoryThresholds(),
  });
  return { scriptPath, exists: true, parsedOk: true, issues: [], inventory, ready: inventory.meets };
}
