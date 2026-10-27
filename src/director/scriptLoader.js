// Reads and validates a show's script.md, resolving every referenced
// ratingKey so parseScript's duration-tolerance check uses each track's real
// length. Shared by directShow() (the near-air-time pass) and
// prewarmAudio.js's downtime pass -- both need the exact same validated
// parse of a show/date's script.md before doing anything with it.
import fs from 'node:fs';
import path from 'node:path';
import * as scheduleUtil from '../scheduler/scheduleUtil.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { parseScript } from '../script/format.js';
import { getTrackByRatingKey } from '../plex/tracks.js';

// The producer writes the full selected track objects as a tracks.json
// sidecar next to script.md (see producer/generateScript.js), and this
// loader reads that back so validation and the director get the exact same
// knownRatingKeys map without a live metadata lookup.
//
// Val 28: sidecar-first, with a Plex-resolution fallback for scripts
// produced BEFORE the single-pipeline switch by the old AI producer (which
// resolved ratingKeys against Plex at direct time). A no-sidecar script is
// a legacy script -- it keeps playing exactly the way it was produced,
// instead of hard-failing shows that were already scheduled when the switch
// landed. Freshly produced scripts always carry the sidecar, so the Plex
// fallback is migration glue, not a live path.
function loadTrackSidecar(showDateDir) {
  const sidecarPath = path.join(showDateDir, 'tracks.json');
  const tracks = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  return new Map(tracks.map((t) => [String(t.ratingKey), t]));
}

export async function loadValidatedScript({ id, weekday, date }) {
  const showDateDir = scheduleUtil.dateDir(weekday, id, date);
  const scriptPath = path.join(showDateDir, 'script.md');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`No script.md found at ${scriptPath} -- run "npm run generate-script -- --id=${id}" first.`);
  }
  const markdown = fs.readFileSync(scriptPath, 'utf8');

  let knownRatingKeys;
  if (fs.existsSync(path.join(showDateDir, 'tracks.json'))) {
    knownRatingKeys = loadTrackSidecar(showDateDir);
  } else {
    // Legacy script (pre single-pipeline): resolve ratingKeys against Plex,
    // exactly the way it was directed when it was produced.
    knownRatingKeys = new Map();
    const ratingKeys = [...new Set([...markdown.matchAll(/^ratingKey:\s*(\S+)/gm)].map((m) => m[1]))];
    for (const ratingKey of ratingKeys) {
      knownRatingKeys.set(ratingKey, await getTrackByRatingKey(ratingKey));
    }
  }

  const parsed = parseScript(markdown, { personas: loadPersonas(), knownRatingKeys });
  if (!parsed.ok) {
    throw new Error(`script.md at ${scriptPath} failed validation: ${parsed.issues.join(' | ')}`);
  }
  return { parsed, scriptPath, showDateDir, knownRatingKeys };
}
