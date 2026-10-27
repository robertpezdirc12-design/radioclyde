// Synthesizes and caches a single `dj` segment's speech. A segment's text
// comes straight from script.md and never changes between same-day repeats
// of a show, so its audio is deterministic -- cached once per script (keyed
// by segment position within it) under <showDateDir>/dj-audio/, and reused
// by every same-day airing *and* by prewarmAudio.js's downtime pass, instead
// of resynthesizing byte-identical audio each time.
//
// Val 28 ("samo skripte brez AI modelov"): the Chatterbox branch (a
// self-hosted AI TTS model, serialized behind a station lock file)
// is REMOVED -- the no-model voices are the only synthesis path:
// clips / edge / piper / sapi / espeak / none (auto/voice.js), keyed by
// `slot` (open/intro/recap/... or live:<kind>) with `text` for the speaking
// providers. djDrops.gain is applied inside the voice layer (clips stay
// untouched -- they are the operator's own recordings).
import fs from 'node:fs';
import path from 'node:path';
import { synthesizeNoModelSpeech } from '../auto/voice.js';

export async function synthesizeSpeechToPath(persona, text, filePath, slot = 'dj', seed = '', track = null) {
  const startedAt = Date.now();
  const spoke = await synthesizeNoModelSpeech({ persona, slot, text, outPath: filePath, seed, track });
  if (!spoke) return { skipped: true, ttsDurationMs: 0 };
  return { skipped: false, ttsDurationMs: Date.now() - startedAt };
}

export async function getCachedDjAudio(djAudioDir, segmentIndex, persona, text, slot = 'dj', seed = '', track = null) {
  const cachedPath = path.join(djAudioDir, `dj_${String(segmentIndex).padStart(3, '0')}.wav`);
  if (fs.existsSync(cachedPath)) {
    return { filePath: cachedPath, ttsDurationMs: 0, cached: true, skipped: false };
  }
  const { ttsDurationMs, skipped } = await synthesizeSpeechToPath(persona, text, cachedPath, slot, seed, track);
  // A skipped segment (voice mode "none", or a missing clip) must not leave
  // a zero-byte file at the cache path -- that would be treated as a valid
  // cached clip on every later occurrence and go on air as silence.
  if (skipped && !fs.existsSync(cachedPath)) {
    return { filePath: null, ttsDurationMs, cached: false, skipped: true };
  }
  return { filePath: cachedPath, ttsDurationMs, cached: false, skipped: false };
}
