import fs from 'node:fs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single-writer coordination for the station's read-modify-write state
// files (prompts.json, track_ratingkeys.json) across OS processes: the
// scheduler, the web server and CLI tools each run as separate processes,
// so an in-process mutex can't coordinate between them -- this uses a
// lock *file* instead. (History: the machinery was born to serialize the
// old single-GPU Chatterbox TTS, where concurrent requests either queued
// up badly or timed out outright -- 6 of 8 parallel requests timed out in
// testing; the lock outlived the AI layer it was built for.)
export async function withLock(lockPath, fn, { retryMs = 500, timeoutMs = 120000, staleMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        // A lock file left behind by a crashed process would otherwise
        // block the next writer forever -- clear it if it's older than any
        // realistic single write.
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between the failed open and this stat -- fine, retry.
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock at ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    fs.unlinkSync(lockPath);
  }
}
