// As-run (izvajalno) poročilo for license-compliance reporting (P4 #27).
// One of the last uncovered rows from the P4 #24 research table ("otočna
// avtomatika: predvajalni logi, licenčna skladnost"): royalty bodies
// (SAZAS/ZKP-style) require stations to hand in what actually aired -- artist,
// title, start time, duration. This module turns history/aired.jsonl (written
// at REAL track start by plex/scrobbleTrack.js -- the honest ledger, unlike
// producer/history.js's production-time played.jsonl) into:
//   1. a CSV (semicolon-delimited, RFC 4180 quoting -- Slovenian Excel opens
//      it correctly out of the box), and
//   2. a small text summary (totals + most-played artists) that doubles as
//      the quick advertiser-facing usage overview.
//
// Pure module: no config import, every entry point takes explicit paths so
// tests can point it at fixture files. Deterministic: same ledger bytes +
// same window -> byte-identical outputs.

import fs from 'node:fs';
import path from 'node:path';

// Read a JSONL ledger fail-open: a missing file is "nothing aired yet", a
// corrupt line is skipped and counted (one hand-edited line must never make
// a compliance report unproducible).
export function readAiredFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { entries: [], corruptCount: 0, fileExists: false };
  }
  const entries = [];
  let corruptCount = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed);
      else corruptCount++;
    } catch {
      corruptCount++;
    }
  }
  return { entries, corruptCount, fileExists: true };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// playedAt is a local-ISO timestamp written by toLocalISOString(); its first
// 10 chars are the station-local date the ledger itself committed to. Window
// matching is an inclusive prefix compare on those 10 chars -- no timezone
// re-interpretation, the report faithfully mirrors the ledger's own clock.
export function filterWindow(entries, from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error(`Neveljaven datum (pričakovan yyyy-mm-dd): from="${from}" to="${to}".`);
  }
  if (from > to) {
    throw new Error(`Začetek "${from}" je za koncem "${to}" -- zamenjaj vrstni red.`);
  }
  return entries
    .filter((e) => typeof e.playedAt === 'string' && e.playedAt.length >= 10)
    .filter((e) => {
      const day = e.playedAt.slice(0, 10);
      return day >= from && day <= to; // ISO dates sort lexically
    })
    .sort((a, b) => (a.playedAt < b.playedAt ? -1 : a.playedAt > b.playedAt ? 1 : 0));
}

// One report row per track start. Missing fields stay empty cells -- an
// incomplete ledger entry must not shift columns for the rest of the report.
export function buildRows(entries) {
  return entries.map((e) => ({
    datum: typeof e.playedAt === 'string' ? e.playedAt.slice(0, 10) : '',
    ura: typeof e.playedAt === 'string' ? e.playedAt.slice(11, 19) : '',
    izvajalec: typeof e.artist === 'string' ? e.artist : '',
    naslov: typeof e.title === 'string' ? e.title : '',
    album: typeof e.album === 'string' ? e.album : '',
    trajanjeS: Number.isFinite(e.durationMs) ? Math.round(e.durationMs / 1000) : '',
    oddaja: typeof e.showId === 'string' ? e.showId : '',
  }));
}

export function buildSummary(rows) {
  const perArtist = new Map();
  const perWork = new Set();
  for (const r of rows) {
    const artist = r.izvajalec || '(neznani izvajalec)';
    perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    perWork.add(`${r.izvajalec} — ${r.naslov}`);
  }
  const artists = [...perArtist.entries()]
    .map(([artist, plays]) => ({ artist, plays }))
    .sort((a, b) => b.plays - a.plays || (a.artist < b.artist ? -1 : a.artist > b.artist ? 1 : 0));
  return {
    total: rows.length,
    uniqueWorks: perWork.size,
    uniqueArtists: perArtist.size,
    artists,
  };
}

// RFC 4180 quoting: fields that contain the delimiter, a quote or a newline
// are wrapped in quotes with inner quotes doubled. Everything else passes
// through bare so a hand-opened CSV stays readable.
export function csvField(value) {
  const s = String(value);
  return /[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows) {
  const header = 'datum;ura;izvajalec;naslov;album;trajanje_s;oddaja';
  const lines = rows.map((r) =>
    [r.datum, r.ura, r.izvajalec, r.naslov, r.album, r.trajanjeS, r.oddaja].map(csvField).join(';')
  );
  return [header, ...lines].join('\n') + '\n';
}

// Plain-text summary, Slovenian, same content the CLI echoes.
export function toSummaryText(summary, from, to) {
  const lines = [
    'Izvajalno poročilo Radio Markec',
    `Obdobje: ${from} .. ${to} (vključno)`,
    `Skupaj predvajanj: ${summary.total}`,
    `Različnih del (izvajalec — naslov): ${summary.uniqueWorks}`,
    `Različnih izvajalcev: ${summary.uniqueArtists}`,
  ];
  if (summary.artists.length > 0) {
    lines.push('', 'Največ predvajanj po izvajalcih:');
    summary.artists.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.artist} — ${a.plays}`);
    });
  }
  return lines.join('\n') + '\n';
}

// Write both artifacts next to each other and return their paths. Filenames
// carry the window so a directory of reports is self-describing.
export function writeAsrunFiles({ csv, summaryText }, outDir, from, to) {
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, `asrun-${from}-${to}.csv`);
  const summaryPath = path.join(outDir, `asrun-${from}-${to}-povzetek.txt`);
  fs.writeFileSync(csvPath, csv);
  fs.writeFileSync(summaryPath, summaryText);
  return { csvPath, summaryPath };
}
