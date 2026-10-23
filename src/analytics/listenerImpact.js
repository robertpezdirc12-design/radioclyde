// Deterministic analytics math for the listener sampling ledger. Pure
// functions only -- file I/O lives in listenerSamples.js -- so the tests can
// pin every number exactly and the API layer stays a thin filter+shape step.
//
// THE IMPACT METRIC, STATED HONESTLY: for each aired entry (aired.jsonl,
// appended at track start by scrobbleTrack.js, carrying durationMs) we look
// at the samples inside [start, start+durationMs], drop gap samples
// (listeners: null -- Icecast didn't answer), and require BOTH enough
// samples (minSamples) AND enough time coverage (the kept samples must span
// at least minCoverage of the track's duration) before computing
// listenersStart / listenersEnd / listenersAvg and delta = end - start.
//
// Known limitations, documented rather than hidden: one-minute sampling
// can't see sub-minute listener blips; delta compares the FIRST and LAST
// kept sample, so a mid-track dip-and-recovery reads as ~0; and delta is a
// correlation, never proof of causality (a track can coincide with bedtime).
// The studio UI labels the column "Δ start→konec (na predvajanje)" and the
// skipped counters are surfaced so nobody mistakes a thin window for data.
import { toLocalISOString } from '../lib/time.js';

// Downsamples raw samples into fixed buckets for charting. A bucket's
// `listeners` is the mean of its non-null samples (1 decimal -- it IS an
// average) or null when every sample in it was a gap; `gaps` counts the null
// samples so the UI can report outage coverage truthfully. Buckets with no
// samples at all (station down, ledger pruned) are emitted as
// { listeners: null, samples: 0, gaps: 0, empty: true } so the chart shows a
// real hole instead of drawing a line across it.
export function buildSeries(samples, { from, to, bucketMs }) {
  const count = Math.max(1, Math.ceil((to - from) / bucketMs));
  const buckets = [];
  for (let i = 0; i < count; i++) {
    const start = from + i * bucketMs;
    buckets.push({ ts: toLocalISOString(new Date(start)), listeners: null, samples: 0, gaps: 0, empty: true });
  }
  for (const s of samples) {
    const t = new Date(s.ts).getTime();
    if (!Number.isFinite(t) || t < from || t > to) continue;
    const idx = Math.min(count - 1, Math.floor((t - from) / bucketMs));
    const b = buckets[idx];
    b.empty = false;
    if (s.listeners === null || s.listeners === undefined || !Number.isFinite(Number(s.listeners))) {
      b.gaps += 1;
    } else {
      b.samples += 1;
      b.listeners = (b.listeners ?? 0) + Number(s.listeners);
    }
  }
  let gaps = 0;
  for (const b of buckets) {
    if (b.samples > 0) {
      b.listeners = Math.round((b.listeners / b.samples) * 10) / 10;
    } else {
      b.listeners = null; // all-gap or no-sample bucket
    }
    gaps += b.gaps;
  }
  return { bucketMs, from: toLocalISOString(new Date(from)), to: toLocalISOString(new Date(to)), buckets, gaps };
}

// The highest non-gap listener count inside [from, to] -- the "peak" the
// listener chip and the studio Analytics summary show. Honesty rules are the
// same as everywhere in this module: gap samples (Icecast not answering) are
// ignored, not zero; a window with no valid samples returns null (the UI
// hides a null peak) rather than 0, which would claim "listeners dipped to
// zero" when it really claims "we have no measurement".
export function peakListeners(samples, { from, to } = {}) {
  let peak = null;
  for (const s of samples ?? []) {
    const t = new Date(s.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (from !== undefined && t < from) continue;
    if (to !== undefined && t > to) continue;
    const n = Number(s.listeners);
    if (s.listeners === null || s.listeners === undefined || !Number.isFinite(n)) continue;
    if (peak === null || n > peak) peak = n;
  }
  return peak;
}

// Per-track listener impact over a rolling window, aggregated across plays.
// Grouping key: ratingKey when the aired entry has one, else "artist — title"
// (local-library entries without a ratingKey must not collapse into one
// "undefined" bucket). Entries that can't be measured honestly are counted
// in `skipped` by reason, never silently dropped:
//   noDuration     -- no durationMs on the aired entry (can't build a window)
//   noData         -- every sample in the window was a gap (Icecast down)
//   tooFewSamples  -- fewer than minSamples non-gap samples
//   thinCoverage   -- enough samples, but they span < minCoverage of the track
export function trackImpact(airedEntries, samples, opts = {}) {
  const {
    windowHours = 168,
    minSamples = 2,
    minCoverage = 0.5,
    now = Date.now(),
  } = opts;

  const cutoff = now - windowHours * 60 * 60 * 1000;
  const parsed = samples
    .map((s) => ({ t: new Date(s.ts).getTime(), listeners: s.listeners }))
    .filter((s) => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);

  const skipped = { noDuration: 0, noData: 0, tooFewSamples: 0, thinCoverage: 0 };
  const byKey = new Map();

  for (const e of airedEntries ?? []) {
    const start = new Date(e.playedAt).getTime();
    if (!Number.isFinite(start) || start < cutoff || start > now) continue;
    const durationMs = Number(e.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      skipped.noDuration += 1;
      continue;
    }
    const end = start + durationMs;
    const inWindow = parsed.filter((s) => s.t >= start && s.t <= end);
    const kept = inWindow.filter((s) => Number.isFinite(Number(s.listeners)) && s.listeners !== null);
    if (kept.length === 0) {
      // A window with zero answers: if samples existed at all they were all
      // gaps (Icecast outage) -- that's noData; a window with no samples in
      // range is also unmeasurable and reported the same honest way.
      skipped.noData += 1;
      continue;
    }
    if (kept.length < minSamples) {
      skipped.tooFewSamples += 1;
      continue;
    }
    const span = kept[kept.length - 1].t - kept[0].t;
    if (span < minCoverage * durationMs) {
      skipped.thinCoverage += 1;
      continue;
    }

    const listenersStart = Number(kept[0].listeners);
    const listenersEnd = Number(kept[kept.length - 1].listeners);
    const listenersAvg = kept.reduce((acc, s) => acc + Number(s.listeners), 0) / kept.length;
    const delta = listenersEnd - listenersStart;

    const key = e.ratingKey != null ? String(e.ratingKey) : `${e.artist ?? ''} — ${e.title ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        ratingKey: e.ratingKey ?? null,
        artist: e.artist ?? '',
        title: e.title ?? '',
        plays: 0,
        deltasSum: 0,
        avgListenersSum: 0,
        lastMeasuredAt: 0,
      });
    }
    const rec = byKey.get(key);
    rec.plays += 1;
    rec.deltasSum += delta;
    rec.avgListenersSum += listenersAvg;
    rec.lastMeasuredAt = Math.max(rec.lastMeasuredAt, start);
  }

  const measured = [...byKey.values()]
    .map((r) => ({
      key: r.key,
      ratingKey: r.ratingKey,
      artist: r.artist,
      title: r.title,
      plays: r.plays,
      listenersAvg: Math.round((r.avgListenersSum / r.plays) * 10) / 10,
      avgDelta: Math.round((r.deltasSum / r.plays) * 10) / 10,
      lastMeasuredAt: new Date(r.lastMeasuredAt).toISOString(),
    }))
    .sort((a, b) => a.avgDelta - b.avgDelta || b.plays - a.plays); // biggest losses first

  return {
    windowHours,
    minSamples,
    minCoverage,
    measuredTracks: measured.length,
    skipped,
    measured,
  };
}
