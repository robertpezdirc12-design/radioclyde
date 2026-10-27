// Val 28 B4+B5: the director's speech-run finalizer. director/index.js
// collects every unbroken run of dj/live clips and used to splice them with a
// plain concat (open running into intro = correct continuous patter) -- but
// two things about that splice were robotic:
//
//   B5 (the beat): the closing "what's next" announcement ran STRAIGHT into
//   the sign-off in one physical breath -- announcement and goodbye as one
//   sentence, every show, same rhythm. A real host lets an announcement LAND:
//   0.7 s of true silence now separates a live:nextShow clip from whatever
//   follows it in the same run (the speech codec contract -- 24 kHz mono s16
//   -- so the concat demuxer stream-copies the beat in losslessly).
//
//   B4 (the level): DJ speech was the ONE audio surface with no loudness
//   alignment -- music rides liq_amplify to the station target, promos and
//   beds bake their correction into the bytes, and speech got whatever the
//   TTS engine produced (Edge routinely lands 4-8 LUFS under the music).
//   Every measured speech run now takes ONE ebur128 pass (the same
//   analyzeTrack machinery the library scan uses) and bakes the correction
//   into the occurrence's own file. config.djDrops.gain keeps its meaning --
//   as a TASTE OFFSET relative to the alignment target (1.3 = +2.3 dB hotter
//   than the music), not a raw scalar fighting the measurement.
//
// Honesty contracts (the autocue discipline, mirrored):
//   - unmeasured (ebur128/ffmpeg failure): the run airs exactly as produced,
//     logged, never skipped -- speech is never lost to a measurement;
//   - an on-target run (amplify 0.0): the file airs untouched, no re-encode;
//   - single-file runs only get an occurrence-specific copy when a bake is
//     actually needed (the dj-audio cache files themselves are never mutated).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { concatWavFiles, ensureSilenceWav, bakeGain } from '../lib/audio.js';
import { analyzeTrack, loudnessSettings } from '../lib/autocue.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

// The slot whose clip ends a complete thought: the next-show announcement is
// a finished sentence, and the next thing the host says (the sign-off) is a
// NEW thought -- that boundary earns a beat. Every other adjacency (open into
// intro, handoff into weather) is continuous patter and stays spliced.
export const SPEECH_PAUSE_AFTER_SLOT = 'live:nextShow';

// ~0.7 s: long enough to read as a deliberate beat, short enough that the
// show never feels like it stalls (researched conversational pause range).
export const SPEECH_PAUSE_SECONDS = 0.7;

// Pure: the concat input list with the B5 beat(s) inserted after every
// non-final live:nextShow clip. Returns { inputs, pauses } so the caller can
// report what happened. A null pausePath (generation failed) degrades to the
// plain splice -- the beat is presentation, never a dependency.
export function speechRunInputs(files, slots, pausePath) {
  const inputs = [];
  let pauses = 0;
  for (let i = 0; i < files.length; i += 1) {
    inputs.push(files[i]);
    if (slots[i] === SPEECH_PAUSE_AFTER_SLOT && i < files.length - 1 && pausePath) {
      inputs.push(pausePath);
      pauses += 1;
    }
  }
  return { inputs, pauses };
}

// Pure: the dB that puts speech measured at `lufs` on the music alignment
// target (config.autocue.targetLufs ?? -16, the same target every other
// surface aligns to), offset by the operator's djDrops.gain taste. Negative
// corrections never clamp (quieting is always safe); positive ones clamp at
// maxGainDb (amplifyDbFor's contract -- no limiter in the speech path).
export function speechAlignDbFor(lufs, { targetLufs, maxGainDb } = loudnessSettings(), gain = config.djDrops?.gain ?? 1) {
  const g = Number(gain);
  const gainDb = Number.isFinite(g) && g > 0 ? 20 * Math.log10(g) : 0;
  const raw = targetLufs + gainDb - lufs;
  return Math.round((raw > maxGainDb ? maxGainDb : raw) * 10) / 10;
}

// Finalizes one unbroken run of dj/live clips:
//   files: ordered clip paths; slots: parallel slot strings ('live:nextShow',
//          'recap', 'dj', ...); occurrenceDir: where the run's artifacts land;
//   makeName: () => a fresh occurrence-specific speech_NNN.wav path.
// Seams (the MCP ctx precedent): measure defaults to the real analyzeTrack,
// run to the real execFileAsync -- tests inject fakes; production callers
// pass nothing.
// Returns { path, aligned, pauses, lufs, amplify }: the path that airs, both
// honest flags, and the measurement for the transcript.
export async function finalizeSpeechRun({ files, slots, occurrenceDir, makeName, measure = analyzeTrack, run = execFileAsync }) {
  // B5: one cached pause file per occurrence dir (generated only when this
  // run actually contains a nextShow clip).
  let pausePath = null;
  if (slots.includes(SPEECH_PAUSE_AFTER_SLOT)) {
    try {
      pausePath = await ensureSilenceWav(path.join(occurrenceDir, 'speech-pause.wav'), SPEECH_PAUSE_SECONDS, { runner: run });
    } catch (err) {
      log(`speech run: beat pause se ni zgeneriral (${err?.message ?? err}) -- napoved in poslavljanje ostajata v enem dihu`);
      pausePath = null;
    }
  }
  const { inputs, pauses } = speechRunInputs(files, slots, pausePath);

  let sourcePath;
  let isOccurrenceFile;
  if (inputs.length === 1) {
    sourcePath = inputs[0];
    isOccurrenceFile = false; // may still be a cached dj-audio file -- never mutated
  } else {
    sourcePath = await concatWavFiles(inputs, makeName(), { runner: run });
    isOccurrenceFile = true;
  }

  // B4: one ebur128 pass over the whole run as it will air.
  let lufs = null;
  try {
    ({ lufs } = await measure(sourcePath));
  } catch (err) {
    log(`speech run: loudness ni izmerjena (${err?.message ?? err}) -- govori gre na eter, kot je bil proizveden`);
    return { path: sourcePath, aligned: false, pauses, lufs: null, amplify: null };
  }
  if (!Number.isFinite(lufs)) {
    return { path: sourcePath, aligned: false, pauses, lufs: null, amplify: null };
  }
  const amplify = speechAlignDbFor(lufs);
  if (amplify === 0) {
    // Already on target: the bytes air untouched (no needless re-encode of a
    // measured-good file -- the promoProducer discipline, mirrored).
    return { path: sourcePath, aligned: false, pauses, lufs, amplify: 0 };
  }
  // A single cached clip that needs a bake gets its own occurrence-specific
  // copy (the cache itself stays pristine for same-day repeats); a concat
  // output is baked in place (tmp + rename -- ffmpeg must never read and
  // write the same file).
  const targetPath = isOccurrenceFile ? sourcePath : makeName();
  const tmp = `${targetPath}.align-${process.pid}`;
  try {
    await bakeGain(sourcePath, tmp, amplify, { runner: run });
    fs.renameSync(tmp, targetPath);
    return { path: targetPath, aligned: true, pauses, lufs, amplify };
  } catch (err) {
    log(`speech run: poravnava glasnosti ni uspela (${err?.message ?? err}) -- govori grejo ne poravnani`);
    return { path: sourcePath, aligned: false, pauses, lufs, amplify };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
