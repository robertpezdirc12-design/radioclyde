// Studio Analytics: audience time-series from the listener sampling ledger
// (analytics/listenerSamples.js) + per-track impact joined against the real
// aired history (analytics/listenerImpact.js). Same honest-failure rules as
// the Diagnostics view: the current count appears only when Icecast actually
// answers, gaps stay gaps, and an empty/thin ledger is an explicit state the
// UI can name -- never a fabricated number.
import { config } from '../config/index.js';
import { readSamples, maxLedgerEntries, samplesLedgerPath } from '../analytics/listenerSamples.js';
import { buildSeries, trackImpact, peakListeners } from '../analytics/listenerImpact.js';
import { readAiredEntries } from './historyApi.js';
import { probeIcecast } from './diagnosticsUtil.js';

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function registerStudioAnalyticsApi(fastify) {
  fastify.get('/api/analytics', async (request) => {
    const now = Date.now();
    const hours = clampInt(request.query?.hours, 1, 168, 24);
    const from = now - hours * 60 * 60 * 1000;

    // One ledger read, two consumers: the chart window is `hours`, the impact
    // window is config.analytics.impactWindowHours (default 7d) and may be
    // longer, so impact gets the full unfiltered list and applies its own.
    const allSamples = readSamples();
    const windowSamples = allSamples.filter((s) => {
      const t = new Date(s.ts).getTime();
      return Number.isFinite(t) && t >= from && t <= now;
    });

    // ~480 points max regardless of window: 24h -> 3min buckets, 7d -> 21min.
    const bucketMs = Math.max(60_000, Math.ceil((hours * 60 * 60 * 1000) / 480 / 60_000) * 60_000);
    const series = buildSeries(windowSamples, { from, to: now, bucketMs });

    const impact = trackImpact(readAiredEntries(), allSamples, {
      windowHours: config.analytics?.impactWindowHours ?? 168,
      minSamples: config.analytics?.impactMinSamples ?? 2,
      minCoverage: config.analytics?.impactMinCoverage ?? 0.5,
      now,
    });

    const current = await probeIcecast(`http://${config.icecast.sourceHost}:${config.icecast.port}`);

    const gapSamples = allSamples.filter((s) => s.listeners === null).length;
    return {
      generatedAt: new Date(now).toISOString(),
      sampler: {
        intervalMinutes: config.analytics?.sampleIntervalMinutes ?? 1,
        maxEntries: maxLedgerEntries(),
        ledgerPath: samplesLedgerPath().split('/').slice(-2).join('/'), // relative to dataDir for display
      },
      current, // probeIcecast: { reachable, healthy, listeners|null, ... }
      ledger: {
        samples: allSamples.length,
        gapSamples,
        oldestTs: allSamples[0]?.ts ?? null,
        newestTs: allSamples[allSamples.length - 1]?.ts ?? null,
      },
      series,
      // Peak honors the requested window (chart + summary share it) plus the
      // ledger-wide value -- the "all-time" answer is only as old as retention
      // (maxEntries), and the UI says so instead of implying "forever".
      peak: peakListeners(windowSamples),
      peakAllTime: peakListeners(allSamples),
      impact,
    };
  });
}
