// Synthesizes and caches a single `dj` segment's speech. A segment's text
// comes straight from script.md and never changes between same-day repeats
// of a show, so its Chatterbox output is deterministic -- cached once per
// script (keyed by segment position within it) under
// <showDateDir>/dj-audio/, and reused by every same-day airing *and* by
// prewarmAudio.js's downtime pass, instead of resynthesizing byte-identical
// audio each time.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { withLock } from '../lib/lock.js';
import { applyGain } from '../lib/audio.js';
import { loadPersonas } from '../scheduler/promptsUtil.js';
import { synthesizeVoice } from './tts.js';
import { autoRadioEnabled, synthesizeNoModelSpeech } from '../auto/voice.js';

// In autoRadio mode the same cache layout serves the no-model voice layer.
// `slot` (open/intro/recap/... or live:<kind>) is what clips mode keys its
// files by; sapi/espeak only speak `text`. Cached returns stay identical in
// shape to the Chatterbox path ({ filePath, ttsDurationMs, cached }).
export async function synthesizeSpeechToPath(persona, text, filePath, slot = 'dj', seed = '', track = null) {
  if (autoRadioEnabled()) {
    const startedAt = Date.now();
    const spoke = await synthesizeNoModelSpeech({ persona, slot, text, outPath: filePath, seed, track });
    if (!spoke) return { skipped: true, ttsDurationMs: 0 };
    return { skipped: false, ttsDurationMs: Date.now() - startedAt };
  }
  const voiceFile = loadPersonas()[persona]?.voiceFile;
  if (!voiceFile) throw new Error(`Unknown persona "${persona}" -- no voiceFile in config.`);
  const startedAt = Date.now();
  const audio = await withLock(config.paths.chatterboxLockPath, () => synthesizeVoice(text, voiceFile));
  const ttsDurationMs = Date.now() - startedAt;
  const amplified = await applyGain(audio, config.djDrops.gain, config.dataDir);
  fs.writeFileSync(filePath, amplified);
  return { skipped: false, ttsDurationMs };
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
