// Listener song requests + dedications (issue #2 section A, "optional
// listener actions ... where supported by the existing backend"). This module
// is the whole backend for that: validation, a light per-IP rate limit, and
// an append-only JSONL store the studio then moderates (approve/reject via
// studioRequestsApi.js).
//
// Honesty rules the issue demands, encoded here so the API can't fake it:
// - a submission returns status "pending" and NOTHING else -- approval is a
//   separate, explicit owner action, never implied;
// - a rejected request keeps its rejection note, so the listener status check
//   can truthfully say why;
// - there is no public listing endpoint -- a listener only ever sees the one
//   request they hold the id for (no scraping other people's messages).
//
// Storage mirrors the aired-history pattern: one JSON object per line,
// append-only for submissions; a status update rewrites the file once via
// tmp+rename (atomic on local filesystems), which is safe at the volumes a
// personal station sees.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';

export const REQUEST_TYPES = new Set(['request', 'dedication']);
export const STATUSES = new Set(['pending', 'approved', 'rejected']);

// Anti-spam floor, deliberately conservative: a personal station does not
// need a queue engine, it needs "one person cannot flood the owner's list".
// Configurable for a busy station via config.web.requests overrides.
const DEFAULTS = {
  minIntervalMinutes: 10, // between two submissions from the same IP
  maxPendingPerIp: 3, // pending requests one IP may hold at once
  maxMessageLength: 500,
  maxTitleLength: 200,
  maxNameLength: 80,
};

export function requestLimits() {
  return { ...DEFAULTS, ...(config.web?.requests ?? {}) };
}

export function requestsFilePath() {
  return config.paths.requestsFile;
}

// Returns { ok: true } or { ok: false, errors: [...] } -- every message in
// Slovenian, since the listener form (and its error text) is the only consumer.
export function validateSubmission(body) {
  const limits = requestLimits();
  const errors = [];
  const type = String(body?.type ?? 'request');
  if (!REQUEST_TYPES.has(type)) errors.push('Neznana vrsta zahtevka.');
  if (type === 'dedication' && !String(body?.message ?? '').trim()) {
    errors.push('Posvetilo brez sporočila ni mogoče.');
  }

  const title = String(body?.title ?? '').trim();
  if (title.length > limits.maxTitleLength) errors.push(`Naslov je predolg (največ ${limits.maxTitleLength} znakov).`);
  if (type === 'request' && !title) errors.push('Zapiši naslov pesmi.');

  const artist = String(body?.artist ?? '').trim();
  if (artist.length > limits.maxTitleLength) errors.push(`Izvajalec je predolg (največ ${limits.maxTitleLength} znakov).`);

  const message = String(body?.message ?? '').trim();
  if (message.length > limits.maxMessageLength) {
    errors.push(`Sporočilo je predolgo (največ ${limits.maxMessageLength} znakov).`);
  }

  const from = String(body?.from ?? '').trim();
  if (from.length > limits.maxNameLength) errors.push(`Podpis je predolg (največ ${limits.maxNameLength} znakov).`);

  return errors.length ? { ok: false, errors } : { ok: true };
}

// True when this IP may submit right now, given the store's current contents.
// Both gates fail CLOSED: if the file can't be read the submission is refused
// (a flood is exactly the situation where losing a few messages beats losing
// the limit).
export function submissionAllowed(ip, now = Date.now()) {
  const limits = requestLimits();
  const all = readRequests();
  const mine = all.filter((r) => r.ip === ip);
  const lastAt = mine.reduce((acc, r) => Math.max(acc, new Date(r.createdAt).getTime() || 0), 0);
  if (lastAt && now - lastAt < limits.minIntervalMinutes * 60 * 1000) {
    return { ok: false, reason: `Naslednji zahtevek lahko oddaš čez ${limits.minIntervalMinutes} minut.` };
  }
  const pending = mine.filter((r) => r.status === 'pending');
  if (pending.length >= limits.maxPendingPerIp) {
    return { ok: false, reason: `Imaš že ${limits.maxPendingPerIp} zahtevkov v obravnavi.` };
  }
  return { ok: true };
}

export function appendRequest({ type, title, artist, message, from }, ip, now = new Date()) {
  const entry = {
    id: `${now.getTime().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    type,
    title: String(title ?? '').trim(),
    artist: String(artist ?? '').trim(),
    message: String(message ?? '').trim(),
    from: String(from ?? '').trim(),
    ip,
    status: 'pending',
    note: '',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const file = requestsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

// Torn/unparseable lines are skipped, not fatal -- same contract as
// fillerRotation.recentFillerPlays, because concurrent appends can only
// interleave whole lines on a local filesystem.
export function readRequests() {
  let lines = [];
  try {
    lines = fs.readFileSync(requestsFilePath(), 'utf8').split('\n');
  } catch {
    return []; // no requests yet
  }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

export function getRequest(id) {
  return readRequests().find((r) => r.id === id) ?? null;
}

// Listener-visible projection: the IP and internal bookkeeping never leave
// the server. `note` IS included -- an honest rejection explains itself.
export function publicView(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    type: entry.type,
    status: entry.status,
    note: entry.note ?? '',
    title: entry.title,
    artist: entry.artist,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// Owner moderation: set status (+ optional note) and persist atomically.
// Returns the updated entry, null when the id is unknown, or
// { invalid: true } when the status value is unknown OR the transition is
// refused: a request that already left 'pending' can never go BACK to it
// (no resurrection). Re-pending a decided request would re-open moderation
// on it -- an approved one may already sit on Liquidsoap's request queue or
// have aired, and re-pending also re-counts it toward the listener's
// pending cap -- and the shipped studio UI offers no such button anyway
// (Approve/Reject only; changing one's mind between those two stays legal,
// which is why approved <-> rejected is NOT blocked).
export function updateRequestStatus(id, status, note = '') {
  if (!STATUSES.has(status)) return { invalid: true };
  const all = readRequests();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  if (status === 'pending' && all[idx].status !== 'pending') return { invalid: true };
  all[idx] = {
    ...all[idx],
    status,
    note: String(note ?? '').slice(0, 300),
    updatedAt: new Date().toISOString(),
  };
  const file = requestsFilePath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
  return all[idx];
}

// Studio listing: newest first, capped. IPs are shown to the owner (spam
// triage is exactly what they're for) but stripped of anything beyond the
// raw string the store already held.
export function listRequests({ status, limit = 500 } = {}) {
  // Clamp BOTH ways, mirroring historyApi.getRecentHistory: the old bare
  // slice(0, limit) let ?limit=-5 through as slice(0,-5), which drops the
  // NEWEST rows (inverted semantics for a "show me fewer" request) and let
  // huge values bypass the 500 cap the default implies. A negative limit
  // now honestly means "no rows".
  const safe = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), 500)) : 500;
  let all = readRequests().reverse();
  if (status && STATUSES.has(status)) all = all.filter((r) => r.status === status);
  return all.slice(0, safe);
}
