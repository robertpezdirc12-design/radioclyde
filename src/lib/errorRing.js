// In-memory ring buffer of process-level errors, for the studio Diagnostics
// view (issue #2: "recent errors" must be real, not fabricated). The web
// process already catches uncaughtException/unhandledRejection in index.js
// (a scheduler-domain crash must not take the public /stream proxy down) --
// those handlers now also feed this ring so an operator can SEE what went
// wrong without shelling into the box. Capped and cheap: the oldest entry
// falls off at MAX_ENTRIES, and recording never throws (a diagnostics aid
// that can crash the station would be worse than no diagnostics at all).
const MAX_ENTRIES = 100;

const ring = [];

export function recordError(source, error, extra = {}) {
  try {
    ring.push({
      at: new Date().toISOString(),
      source,
      message: error?.message ?? String(error ?? 'unknown error'),
      stack: error?.stack ?? null,
      ...extra,
    });
    if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES);
  } catch {
    // never let diagnostics bookkeeping throw
  }
}

export function recentErrors(limit = 20) {
  const n = Math.max(0, Math.min(limit, ring.length));
  return ring.slice(-n).reverse(); // newest first
}

export function clearErrorsForTest() {
  ring.length = 0;
}
