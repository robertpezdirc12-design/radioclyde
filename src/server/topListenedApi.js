// Javna "najbolj poslušano" (P5 naslednji korak iz analize vmesnikov):
// anonimiziran izvod impact analize za poslušalsko stran. Analitika je bila
// do zdaj samo admin -- ta ruta pokaže poslušalcu, kaj postaja RES posluša,
// in ničesar ne razkrije: brez ratingKey (notranji Plex id), brez ledger
// poti, brez vzorčenih točk, brez IP/napak -- samo agregati po skladbi.
// Ista izračunska jedra kot studio Analytics (listenerImpact.trackImpact),
// torej enaka poštenost: skladba je izmerjena SAMO kadar je vzorčenje
// resnično pokrilo predvajanje (minSamples/minCoverage) -- nič ni izumljeno.
import { config } from '../config/index.js';
import { readSamples } from '../analytics/listenerSamples.js';
import { trackImpact } from '../analytics/listenerImpact.js';
import { readAiredEntries } from './historyApi.js';

// Čisto jedro (injektibilno za teste): rangira po listenersAvg (kar je
// "najbolj poslušano" -- povprečno št. poslušalcev med predvajanjem),
// neodločene loči število predvajanj, potem pa umetniško/naslov za bajtno
// deterministiko. Top 10, samo javna polja.
export function computeTopListened({ now = Date.now(), readAired = readAiredEntries, readLedger = readSamples, config: cfg = config, limit = 10 } = {}) {
  const windowHours = cfg.analytics?.impactWindowHours ?? 168;
  const impact = trackImpact(readAired(), readLedger(), {
    windowHours,
    minSamples: cfg.analytics?.impactMinSamples ?? 2,
    minCoverage: cfg.analytics?.impactMinCoverage ?? 0.5,
    now,
  });

  const tracks = [...(impact.measured ?? [])]
    .sort(
      (a, b) =>
        b.listenersAvg - a.listenersAvg ||
        b.plays - a.plays ||
        String(a.artist).localeCompare(String(b.artist)) ||
        String(a.title).localeCompare(String(b.title))
    )
    .slice(0, limit)
    // Javna površina je namenoma ozka: samo agregati, ki jih poslušalec sme
    // videti. ratingKey/key/lastMeasuredAt ostanejo studio-only.
    .map((r) => ({ artist: r.artist, title: r.title, plays: r.plays, listenersAvg: r.listenersAvg, avgDelta: r.avgDelta }));

  const unmeasured = Object.values(impact.skipped ?? {}).reduce((acc, n) => acc + (Number(n) || 0), 0);
  return {
    windowDays: Math.round(windowHours / 24),
    measured: impact.measuredTracks ?? (impact.measured ?? []).length,
    unmeasured,
    // Poštena prazna stanja: nič izmerjenega = izpisan razlog, ne tihi seznam.
    note:
      (impact.measuredTracks ?? 0) === 0
        ? 'Analitika v tem oknu še ni izmerila nobene skladbe -- vzorčenje poslušanja mora teči vsaj nekaj časa.'
        : null,
    tracks,
  };
}

export function registerTopListenedRoutes(fastify) {
  fastify.get('/api/top-listened', () => computeTopListened());
}
