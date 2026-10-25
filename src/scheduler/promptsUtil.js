// Persona system prompts + the script-review system prompt, stored in
// dataDir/prompts.json and re-read fresh on every call -- same no-caching
// pattern scheduleUtil.js already uses for station.json. This is what lets a
// studio admin edit either without restarting the process: they used to live
// in config.json, which is only ever read once at process boot.
import fs from 'node:fs';
import { config } from '../config/index.js';
import { withLock } from '../lib/lock.js';

function readPromptsFile() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.promptsFile, 'utf8'));
  } catch {
    // Fail-open, not a 500: on a fresh deploy dataDir/prompts.json doesn't
    // exist yet, and every consumer already treats "no personas / no
    // script-review block" as "use the defaults" (loadPersonas's ?? {},
    // loadScriptReview's ?? default) -- the honest-empty contract. A later
    // save then recreates the file from this empty base. (The write side is
    // atomic tmp+rename below, so a torn file is not a realistic state; the
    // realistic failure is simply ENOENT.)
    return {};
  }
}

function atomicWrite(data) {
  const tmpPath = `${config.paths.promptsFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, config.paths.promptsFile);
}

// { personaId: { voiceFile, systemPrompt } }
export function loadPersonas() {
  return readPromptsFile().personas ?? {};
}

// { enabled, systemPrompt }
export function loadScriptReview() {
  return readPromptsFile().scriptReview ?? { enabled: true, systemPrompt: null };
}

export async function savePersonas(personas) {
  await withLock(config.paths.promptsLockPath, async () => {
    const current = readPromptsFile();
    atomicWrite({ ...current, personas });
  });
}

export async function saveScriptReview(systemPrompt) {
  await withLock(config.paths.promptsLockPath, async () => {
    const current = readPromptsFile();
    atomicWrite({ ...current, scriptReview: { ...(current.scriptReview ?? {}), systemPrompt } });
  });
}
