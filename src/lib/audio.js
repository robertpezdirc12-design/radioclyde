import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Every speech clip the voice layer produces carries the same codec
// (pcm_s16le, 24000Hz, mono -- the normalize pass in auto/voice.js
// guarantees it), so a plain concat-demuxer stream copy (no re-encode) is
// safe and lossless here.
export async function getDurationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return parseFloat(stdout);
}

export async function concatWavFiles(filePaths, outputPath, { runner = execFileAsync } = {}) {
  const listPath = `${outputPath}.list.txt`;
  const listContent = filePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  fs.writeFileSync(listPath, listContent);
  try {
    await runner('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  } finally {
    fs.unlinkSync(listPath);
  }
  return outputPath;
}

// Val 28 B5: N seconds of true silence in the speech codec contract
// (24 kHz mono s16 -- the normalized output every dj/live clip already
// carries, so the concat demuxer stream-copies it in losslessly).
// Cached by the caller (one pause file per occurrence dir); the runner seam
// is the same test injection the rest of this module grows.
export async function ensureSilenceWav(outPath, seconds, { runner = execFileAsync } = {}) {
  try {
    const st = fs.statSync(outPath);
    if (st.isFile() && st.size > 44) return outPath; // canonical header alone
  } catch {
    // not there yet -- generated below
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await runner(
    'ffmpeg',
    [
      '-y',
      '-v', 'error',
      '-f', 'lavfi',
      '-i',
      `anullsrc=duration=${seconds}:sample_rate=24000:channel_layout=mono`,
      '-c:a', 'pcm_s16le',
      outPath,
    ],
    { timeout: 60_000, windowsHide: true }
  );
  return outPath;
}

// Val 28 B4: bake a fixed dB gain into a WAV as pcm_s16le. The caller owns
// in-place safety (write to a tmp path, rename over the target -- ffmpeg
// must never read and write the same file). '-f wav' is LOAD-BEARING for
// the same reason promoProducer's '-f mp3' is: callers bake into tmp names
// whose extension is NOT .wav (the align-<pid> suffix), and ffmpeg picks the
// muxer from the output filename's extension -- without the explicit format
// the real ffmpeg dies with "Error opening output files" (the Val 21
// lesson, re-learned live in Val 28's own E2E).
export async function bakeGain(inputPath, outputPath, db, { runner = execFileAsync } = {}) {
  await runner(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', inputPath, '-filter:a', `volume=${db}dB`, '-c:a', 'pcm_s16le', '-f', 'wav', outputPath],
    { timeout: 60_000, windowsHide: true }
  );
  return outputPath;
}

// Fades the last `fadeSeconds` of `inputPath` to silence, writing the result
// to `outputPath`. Used for the jingle's fade-down (director/index.js)
// instead of a runtime Liquidsoap fade.out() -- confirmed live 2026-07-29
// that fade.out() at low (<~0.5s) durations silences the *entire* track, not
// just the tail, in this Liquidsoap build (2.2.4-1+dev), which made it unsafe
// to use as the "no fade" default for every non-jingle entry. Baking the
// fade into the file sidesteps that bug entirely.
export async function applyFadeOut(inputPath, outputPath, fadeSeconds) {
  const duration = await getDurationSeconds(inputPath);
  const start = Math.max(duration - fadeSeconds, 0);
  await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-filter:a', `afade=t=out:st=${start}:d=${fadeSeconds}`, outputPath]);
  return outputPath;
}

// tmpDir is caller-provided (director/index.js passes config.dataDir) rather
// than read from config directly -- this module has no config/domain
// knowledge of its own, same as the other lib/ helpers.
export async function applyGain(inputBuffer, gain, tmpDir) {
  if (!gain || gain === 1) return inputBuffer;
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpIn = path.join(tmpDir, `.gain-in-${stamp}.wav`);
  const tmpOut = path.join(tmpDir, `.gain-out-${stamp}.wav`);
  fs.writeFileSync(tmpIn, inputBuffer);
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', tmpIn, '-filter:a', `volume=${gain}`, tmpOut]);
    return fs.readFileSync(tmpOut);
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}
