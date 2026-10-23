// Real, cheap diagnostics primitives for the studio Diagnostics view (issue
// #2 section B.6: "readable logs and actionable errors"). Every function
// here reports what IS, never what should be: a missing file is
// { exists: false }, a failed Icecast probe is { reachable: false } with the
// actual error text -- an operator debugging a dead stream needs the failure,
// not a polite blank.
import fs from 'node:fs';

// Stats for one generated playlist (now_playing.m3u / filler.m3u): does it
// exist, when was it (re)written, how many entries does it hold. Staleness
// of these two files is exactly how the audited hourly-repeat defect
// announced itself, so the view surfaces mtimes prominently.
export function playlistStats(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { exists: false, mtime: null, entries: 0 };
  }
  let entries = 0;
  try {
    entries = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  } catch {
    // exists but unreadable mid-write -- report what we know
  }
  return { exists: true, mtime: stat.mtime.toISOString(), sizeBytes: stat.size, entries };
}

// Last `count` lines of a log file, oldest first. Missing/empty logs are an
// empty array -- for a brand-new deploy that's the truthful answer, not an
// error.
export function tailFile(file, count = 40) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
  return lines.filter((l) => l.trim()).slice(-count);
}

// Unintended repeats inside the rotation window, computed from the REAL
// aired history (history/aired.jsonl, written at track-start by
// scrobbleTrack.js -- not the production-time played.jsonl, per
// historyApi.js's comment). Groups by ratingKey; anything airing
// `minCount`+ times inside the window is listed with its titles, so the
// owner sees exactly what repeated and when. Empty result = no evidence of
// repetition, which is itself the number the issue asks to expose.
export function repeatOffenders(airedEntries, windowHours, now = Date.now(), minCount = 2) {
  const cutoff = now - windowHours * 60 * 60 * 1000;
  const byKey = new Map();
  for (const e of airedEntries) {
    if (!e?.ratingKey) continue;
    const at = new Date(e.playedAt).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    const key = String(e.ratingKey);
    if (!byKey.has(key)) {
      byKey.set(key, { ratingKey: key, artist: e.artist ?? '', title: e.title ?? '', count: 0, lastPlayedAt: 0 });
    }
    const rec = byKey.get(key);
    rec.count += 1;
    rec.lastPlayedAt = Math.max(rec.lastPlayedAt, at);
  }
  return [...byKey.values()]
    .filter((r) => r.count >= minCount)
    .sort((a, b) => b.count - a.count || b.lastPlayedAt - a.lastPlayedAt)
    .map((r) => ({ ...r, lastPlayedAt: new Date(r.lastPlayedAt).toISOString() }));
}

// One-shot Icecast reachability probe against its /status-json.xsl (the
// standard stats endpoint on every Icecast 2.x install this project's
// liquidsoap config pairs with). Short timeout, no retries: a hung Icecast
// must not hang the diagnostics endpoint. Listener count is reported ONLY
// when Icecast actually answered with one -- no invented metrics.
export async function probeIcecast(baseUrl, timeoutMs = 2500) {
  const url = `${baseUrl.replace(/\/$/, '')}/status-json.xsl`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: true, healthy: false, status: res.status, listeners: null };
    let body = null;
    try {
      body = await res.json();
    } catch {
      return { reachable: true, healthy: false, status: res.status, listeners: null, note: 'odgovor brez JSON statistike' };
    }
    const sources = Array.isArray(body?.icestats?.source) ? body.icestats.source : body?.icestats?.source ? [body.icestats.source] : [];
    const listeners = sources.reduce((acc, s) => acc + (Number(s.listeners) || 0), 0);
    return { reachable: true, healthy: true, status: res.status, listeners, mountCount: sources.length };
  } catch (err) {
    return { reachable: false, healthy: false, listeners: null, error: err?.message ?? String(err) };
  }
}
