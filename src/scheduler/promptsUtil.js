// The station's persona roster, stored in dataDir/prompts.json and re-read
// fresh on every call -- same no-caching pattern scheduleUtil.js already
// uses for station.json. This is what lets a studio admin edit the roster
// without restarting the process: it used to live in config.json, which is
// only ever read once at process boot.
//
// Val 28 ("samo skripte brez AI modelov"): the persona systemPrompt (LLM
// register guidance) and voiceFile (Chatterbox AI voice) fields are gone
// with the AI layer -- a persona is now purely a roster identity: script
// validation checks briefs/scripts against this list, show briefs name
// personas from it, and per-persona VOICE settings live in
// config.autoRadio.voice.personas (config.json, not prompts.json). Existing
// prompts.json files that still carry the old fields keep loading -- extra
// keys are simply passed through and ignored by every consumer.
import fs from 'node:fs';
import { config } from '../config/index.js';
import { withLock } from '../lib/lock.js';

function readPromptsFile() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.promptsFile, 'utf8'));
  } catch {
    // Fail-open, not a 500: on a fresh deploy dataDir/prompts.json doesn't
    // exist yet, and the consumer treats "no personas" as "use the defaults"
    // (loadPersonas's ?? {}) -- the honest-empty contract. A later save then
    // recreates the file from this empty base. (The write side is atomic
    // tmp+rename below, so a torn file is not a realistic state; the
    // realistic failure is simply ENOENT.)
    return {};
  }
}

function atomicWrite(data) {
  const tmpPath = `${config.paths.promptsFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, config.paths.promptsFile);
}

// { personaId: { ... } } -- the roster. Legacy extra fields (voiceFile,
// systemPrompt) are tolerated and passed through untouched.
export function loadPersonas() {
  return readPromptsFile().personas ?? {};
}

export async function savePersonas(personas) {
  await withLock(config.paths.promptsLockPath, async () => {
    const current = readPromptsFile();
    atomicWrite({ ...current, personas });
  });
}
