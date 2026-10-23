// Reads and validates a show's script.md, resolving every referenced
// ratingKey against Plex first so parseScript's duration-tolerance check
// uses each track's real length. Shared by directShow() (the near-air-time
// pass) and prewarmAudio.js's downtime pass -- both need the exact same
// validated parse of a show/date's script.md before doing anything with it.
import fs from 'node:fs';
import path from 'node:path';
import * as scheduleUtil from '../scheduler/scheduleUtil.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { parseScript } from '../script/format.js';
import { getTrackByRatingKey } from '../plex/tracks.js';
import { autoRadioEnabled } from '../auto/voice.js';

// Auto-radio mode has no Plex to resolve ratingKeys against -- the producer
// writes the full selected track objects as a tracks.json sidecar next to
// script.md (see producer/generateScript.js), and this loader reads that
// back so validation and the director get the exact same knownRatingKeys
// map the Plex path builds.
function loadTrackSidecar(showDateDir) {
  const sidecarPath = path.join(showDateDir, 'tracks.json');
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(
      `No tracks.json sidecar at ${sidecarPath} -- autoRadio scripts need it to resolve ratingKeys without Plex.`
    );
  }
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
  if (autoRadioEnabled()) {
    knownRatingKeys = loadTrackSidecar(showDateDir);
  } else {
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
