// External scrobbling -- Last.fm + ListenBrainz, ported from SUB/WAVE's
// controller/src/broadcast/{scrobble,scrobble-pure}.ts (which the research
// pass verified is pure HTTP/JSON -- no AI anywhere in the path). Design kept
// verbatim from SUB/WAVE where radioclyde's shape allows it:
//
//  - Eligibility is Last.fm's own rule (see scrobble-pure.ts): a track
//    scrobbles only when it is longer than 30 s AND was heard for at least
//    half its duration or at least 4 minutes.
//  - now-playing goes on the INCOMING track (the moment it starts), the
//    scrobble SUBMIT goes on the OUTGOING track at the transition, stamped
//    with when that track STARTED -- Last.fm's timestamp contract.
//  - The listener gate fails CLOSED: an unknown or zero listener count skips
//    everything (polluting a real profile during a monitoring blip is worse
//    than missing entries).
//  - Fire-and-forget: 5 s timeout per call, no retry queue, failures only
//    become {ok:false, message} result objects and log lines.
//
// One deliberate deviation from SUB/WAVE (documented in docs/scrobbling.md):
// auth. SUB/WAVE drives the browser web-auth flow (getToken -> operator
// authorizes -> getSession) because it has an admin UI to host it; radioclyde
// is headless, so this module uses Last.fm's auth.getMobileSession with
// username+password ONCE, caches the returned session key to
// dataDir/lastfm-session.json (0600, atomic tmp+rename), and prefers that
// cache over minting again -- after the first run the password can be deleted
// from config.json entirely.
//
// Zero new npm dependencies: node:crypto's md5 for the api_sig, node:fs for
// the session cache, global fetch for both APIs, and every seam (fetch, clock,
// session file, logger) is injectable so the tests run with zero network.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

// ---------- constants (SUB/WAVE production values, named + commented) ----------

// Last.fm's rule: the track itself must be longer than 30 s. A 30 s (or
// shorter) track NEVER scrobbles, however long it aired. Provenance:
// SUB/WAVE scrobble-pure.ts MIN_DURATION_SEC.
export const MIN_DURATION_SEC = 30;

// ...and it must have been heard for at least half its duration OR at least
// 240 s ("four minutes"), whichever comes first. Provenance: SUB/WAVE
// scrobble-pure.ts MIN_ELAPSED_FLOOR_SEC.
export const MIN_ELAPSED_FLOOR_SEC = 240;

const TIMEOUT_MS = 5000;
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const LISTENBRAINZ_DEFAULT_BASE = 'https://api.listenbrainz.org/1';
// Same self-naming convention as the LRCLIB client (docs/lyrics.md); Last.fm
// and ListenBrainz both ask API clients to identify themselves.
const USER_AGENT = 'radioclyde/1.0 (+https://github.com/robertpezdirc12-design/radioclyde)';

// ---------- pure decisions (no I/O, no clock of their own) ----------

// Seconds between a parseable startedAt and nowMs, floored at 0 (a future
// start timestamp is clock skew, not negative listening). Missing or
// unparseable startedAt -> 0, so the eligibility rule fails closed.
export function elapsedSeconds(startedAt, nowMs = Date.now()) {
  if (!startedAt) return 0;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

// Last.fm's eligibility rule, SUB/WAVE's semantics exactly:
//  - no title or no artist -> false (speech/jingle entries are not plays);
//  - duration known: duration <= 30 s -> false; otherwise true iff
//    elapsed >= duration/2 OR elapsed >= 240 s;
//  - duration unknown: elapsed >= 30 s (the track played out unmeasured, so
//    elapsed stands in for the duration and only the >30 s floor applies).
export function isEligibleScrobble(track, elapsed) {
  const { title, artist, durationSec } = track ?? {};
  if (!title || !artist) return false;
  const d = Number(durationSec);
  if (Number.isFinite(d) && d > 0) {
    if (d <= MIN_DURATION_SEC) return false;
    return elapsed >= d / 2 || elapsed >= MIN_ELAPSED_FLOOR_SEC;
  }
  return elapsed >= MIN_DURATION_SEC;
}

// ---------- Last.fm wire ----------

// api_sig per Last.fm authspec 2.0: md5 over every parameter except
// `format`/`callback`, keys sorted alphabetically, each key+value
// concatenated, with the shared secret appended.
// See https://www.last.fm/api/authspec.
export function signLastfm(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  const sigStr = keys.map((k) => k + params[k]).join('') + secret;
  return createHash('md5').update(sigStr, 'utf8').digest('hex');
}

// The one shared Last.fm POST: method + api_key + sk + api_sig + format over
// urlencoded form data. Never throws -- every failure mode becomes
// {ok:false, message}. A 200 whose JSON body carries an `error` field counts
// as a failure (Last.fm embeds errors in 200s); a non-JSON 200 body is
// treated as success, exactly like SUB/WAVE's client.
export async function callLastfm(method, baseParams, creds, { fetchImpl = fetch } = {}) {
  const params = { ...baseParams, method, api_key: creds.apiKey, sk: creds.sessionKey };
  params.api_sig = signLastfm(params, creds.apiSecret);
  params.format = 'json';
  const body = new URLSearchParams(params).toString();
  try {
    const res = await fetchImpl(LASTFM_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable -- status is enough */ }
      return { ok: false, message: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
    }
    try {
      const data = await res.json();
      if (data?.error) {
        return { ok: false, message: `error ${data.error}: ${data.message || ''}`.trim() };
      }
    } catch {
      // Non-JSON body on 200 -- treat as success.
    }
    return { ok: true };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'request timed out' : (err?.message || String(err));
    return { ok: false, message };
  }
}

// The per-track parameter set both write methods share: album and duration
// only when they exist (duration in whole seconds, Last.fm's unit).
function lastfmTrackParams(track) {
  const p = {
    artist: String(track.artist || ''),
    track: String(track.title || ''),
  };
  if (track.album) p.album = String(track.album);
  const d = Number(track.durationSec);
  if (Number.isFinite(d) && d > 0) p.duration = String(Math.round(d));
  return p;
}

export function lastfmUpdateNowPlaying(track, creds, { fetchImpl = fetch } = {}) {
  return callLastfm('track.updateNowPlaying', lastfmTrackParams(track), creds, { fetchImpl });
}

export async function lastfmScrobble(track, startedAt, creds, { fetchImpl = fetch } = {}) {
  const ts = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(ts)) return { ok: false, message: 'invalid start timestamp' };
  return callLastfm('track.scrobble', { ...lastfmTrackParams(track), timestamp: String(ts) }, creds, {
    fetchImpl,
  });
}

// ---------- Last.fm mobile-session auth (headless deviation, see header) ----------

export function lastfmSessionCachePath(sessionKeyFile = null) {
  return sessionKeyFile ?? path.join(config.dataDir, 'lastfm-session.json');
}

// Tolerant read: missing, torn, or shapeless cache -> null (mint again).
function readCachedSessionKey(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = typeof parsed?.sessionKey === 'string' ? parsed.sessionKey : '';
    return key || null;
  } catch {
    return null;
  }
}

// Atomic tmp-<pid> + rename exactly like server/pollsStore.js's writeStore,
// with mode 0600 like push/vapid.js's private-key file: this file is a live
// credential for the station's Last.fm account, so the default 0644 would
// leave it readable by every account on a shared box, and a torn write would
// silently fall back to re-minting. One write, right perms, either the old
// file or the new one -- never a torn one.
function writeCachedSessionKey(file, sessionKey, username) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ sessionKey, username }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// auth.getMobileSession over the same POST + signing as the write calls (no
// `sk` -- there is no session yet). Never throws.
async function callLastfmMobileSession({ apiKey, apiSecret, username, password }, { fetchImpl = fetch } = {}) {
  if (!apiKey || !apiSecret || !username || !password) {
    return { ok: false, message: 'missing apiKey/apiSecret/username/password' };
  }
  const params = { username: String(username), password: String(password), method: 'auth.getMobileSession', api_key: apiKey };
  const body = new URLSearchParams({
    ...params,
    api_sig: signLastfm(params, apiSecret),
    format: 'json',
  }).toString();
  try {
    const res = await fetchImpl(LASTFM_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) {
      return { ok: false, message: data?.message || `HTTP ${res.status}` };
    }
    const key = data?.session?.key;
    if (!key) return { ok: false, message: 'no session key in response' };
    return { ok: true, sessionKey: key, username: data?.session?.name || '' };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'request timed out' : (err?.message || String(err));
    return { ok: false, message };
  }
}

// Session-key resolution, in precedence order:
//   1. a sessionKey configured in config.json (pasted by hand or kept from
//      before) -- always wins, nothing is minted or read;
//   2. the cached dataDir/lastfm-session.json -- preferred over minting, so
//      later runs make zero auth calls and the password can be deleted;
//   3. auth.getMobileSession with username+password, cached for next time.
// Returns { sessionKey, source } or null when nothing resolvable. Never
// throws; a failed cache WRITE after a successful mint is logged and ignored
// (this run still scrobbles, the next one just mints again).
export async function resolveLastfmSessionKey(
  {
    apiKey,
    apiSecret,
    sessionKey = '',
    username = '',
    password = '',
    sessionKeyFile = null,
    fetchImpl = fetch,
    log = () => {},
  } = {}
) {
  const configured = String(sessionKey ?? '').trim();
  if (configured) return { sessionKey: configured, source: 'config' };
  const file = lastfmSessionCachePath(sessionKeyFile);
  const cached = readCachedSessionKey(file);
  if (cached) return { sessionKey: cached, source: 'cache' };
  if (!username || !password) return null;
  const minted = await callLastfmMobileSession({ apiKey, apiSecret, username, password }, { fetchImpl });
  if (!minted.ok) {
    log(`scrobble: last.fm auth.getMobileSession failed: ${minted.message}`);
    return null;
  }
  try {
    writeCachedSessionKey(file, minted.sessionKey, minted.username);
  } catch (err) {
    log(`scrobble: could not cache the last.fm session key: ${err?.message ?? err}`);
  }
  return { sessionKey: minted.sessionKey, username: minted.username, source: 'minted' };
}

// ---------- ListenBrainz wire ----------

// The operator may paste the API root or the full submit endpoint into
// config; either input normalizes to a base, then '/submit-listens' is
// appended once. Empty/absent -> LB.org's own API.
export function listenbrainzApiBase(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  const base = raw.replace(/\/submit-listens\/?$/i, '').replace(/\/$/, '');
  return base || LISTENBRAINZ_DEFAULT_BASE;
}

export function listenbrainzSubmitUrl(baseUrl) {
  return `${listenbrainzApiBase(baseUrl)}/submit-listens`;
}

function listenbrainzTrackMetadata(track) {
  const md = {
    artist_name: String(track.artist || ''),
    track_name: String(track.title || ''),
  };
  if (track.album) md.release_name = String(track.album);
  const d = Number(track.durationSec);
  const additional = {};
  if (Number.isFinite(d) && d > 0) additional.duration = Math.round(d);
  additional.media_player = 'radioclyde';
  md.additional_info = additional;
  return md;
}

async function postListenbrainz(payload, creds, label, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(listenbrainzSubmitUrl(creds.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Token ${creds.userToken}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* status is enough */ }
      return { ok: false, message: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'request timed out' : (err?.message || String(err));
    return { ok: false, message };
  }
}

// playing_now has NO listened_at (the LB contract: it is a display hint, not
// a history entry); a 'single' listen carries the unix second the track
// STARTED at, mirroring Last.fm's timestamp.
export function listenbrainzPlayingNow(track, creds, { fetchImpl = fetch } = {}) {
  return postListenbrainz(
    { listen_type: 'playing_now', payload: [{ track_metadata: listenbrainzTrackMetadata(track) }] },
    creds,
    'playing_now',
    { fetchImpl }
  );
}

export async function listenbrainzSubmit(track, startedAt, creds, { fetchImpl = fetch } = {}) {
  const ts = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(ts)) return { ok: false, message: 'invalid start timestamp' };
  return postListenbrainz(
    {
      listen_type: 'single',
      payload: [{ listened_at: ts, track_metadata: listenbrainzTrackMetadata(track) }],
    },
    creds,
    'submit-listens',
    { fetchImpl }
  );
}

// ---------- orchestration ----------

// One track transition, called from plex/scrobbleTrack.js the moment a new
// track starts: now-playing for the INCOMING track, the eligibility-gated
// scrobble SUBMIT for the OUTGOING track (timestamp = when the outgoing
// track started), on every enabled+credentialed backend independently.
//
// `lastfm` / `listenbrainz` are the config.scrobble.* blocks verbatim
// (enabled/apiKey/apiSecret/sessionKey/username/password and
// enabled/userToken/baseUrl); `listenerCount` is the Icecast count or
// null/undefined when unknown.
//
// NEVER throws: the listener gate fails closed, every network call is caught
// into a result object, and even an unexpected internal error becomes
// {skipped:'error'} instead of an exception into the per-track process.
// Returns a result object for logging/inspection:
//   { skipped: null|'listeners'|'no-backends'|'error', listeners, backends,
//     nowPlaying: [{backend, ok, message?}]|null, submit: [...]|null,
//     eligible: boolean|null, elapsed: number|null }
export async function submitScrobbles({
  outgoing = null,
  outgoingStartedAt = null,
  incoming = null,
  lastfm = null,
  listenbrainz = null,
  listenerCount = null,
  nowMs = Date.now(),
  fetchImpl = fetch,
  sessionKeyFile = null,
  log = () => {},
} = {}) {
  const result = { skipped: null, listeners: listenerCount ?? null, backends: [], nowPlaying: null, submit: null, eligible: null, elapsed: null };
  try {
    // Listener gate, fail-closed like the Plex gate's `listenerCount > 0`:
    // unknown (null/undefined) OR zero listeners -> skip both backends.
    if (listenerCount === null || listenerCount === undefined || !(Number(listenerCount) > 0)) {
      result.skipped = 'listeners';
      log(`scrobble: skip -- ${listenerCount ?? 'unknown'} listener(s), nothing sent (fail-closed).`);
      return result;
    }

    // Resolve each backend independently: enabled flag + its own credentials.
    // A backend without credentials is skipped with a log line, never an
    // error -- the other backend still runs.
    let lf = null;
    if (lastfm?.enabled) {
      if (!lastfm.apiKey || !lastfm.apiSecret) {
        log('scrobble: skip last.fm -- missing apiKey/apiSecret.');
      } else {
        const resolved = await resolveLastfmSessionKey({
          apiKey: lastfm.apiKey,
          apiSecret: lastfm.apiSecret,
          sessionKey: lastfm.sessionKey,
          username: lastfm.username,
          password: lastfm.password,
          sessionKeyFile,
          fetchImpl,
          log,
        });
        if (resolved?.sessionKey) {
          lf = { apiKey: lastfm.apiKey, apiSecret: lastfm.apiSecret, sessionKey: resolved.sessionKey };
        } else {
          log('scrobble: skip last.fm -- no sessionKey and no username/password to mint one.');
        }
      }
    }
    let lb = null;
    if (listenbrainz?.enabled) {
      if (listenbrainz.userToken) {
        lb = { userToken: listenbrainz.userToken, baseUrl: listenbrainz.baseUrl };
      } else {
        log('scrobble: skip listenbrainz -- missing userToken.');
      }
    }
    result.backends = [lf ? 'lastfm' : null, lb ? 'listenbrainz' : null].filter(Boolean);
    if (!lf && !lb) {
      result.skipped = 'no-backends';
      return result;
    }

    // Now-playing on the INCOMING track -- needs artist+title, so a speech
    // entry ({dj:...}) or a track without metadata sends nothing.
    if (incoming?.artist && incoming?.title) {
      log(`scrobble: now-playing -> ${result.backends.join('+')}: "${incoming.title}" — ${incoming.artist}.`);
      const np = [];
      if (lf) np.push({ backend: 'lastfm', ...(await lastfmUpdateNowPlaying(incoming, lf, { fetchImpl })) });
      if (lb) np.push({ backend: 'listenbrainz', ...(await listenbrainzPlayingNow(incoming, lb, { fetchImpl })) });
      result.nowPlaying = np;
      for (const r of np) {
        if (!r.ok) log(`scrobble: now-playing ${r.backend} failed: ${r.message}`);
      }
    }

    // Scrobble SUBMIT for the OUTGOING track, gated by Last.fm's rule.
    if (outgoing && outgoingStartedAt) {
      const elapsed = elapsedSeconds(outgoingStartedAt, nowMs);
      result.elapsed = elapsed;
      result.eligible = isEligibleScrobble(outgoing, elapsed);
      if (result.eligible) {
        log(`scrobble: submit -> ${result.backends.join('+')}: "${outgoing.title}" — ${outgoing.artist} (elapsed=${elapsed}s).`);
        const sub = [];
        if (lf) sub.push({ backend: 'lastfm', ...(await lastfmScrobble(outgoing, outgoingStartedAt, lf, { fetchImpl })) });
        if (lb) sub.push({ backend: 'listenbrainz', ...(await listenbrainzSubmit(outgoing, outgoingStartedAt, lb, { fetchImpl })) });
        result.submit = sub;
        for (const r of sub) {
          if (!r.ok) log(`scrobble: submit ${r.backend} failed: ${r.message}`);
        }
      } else {
        result.submit = [];
        const d = Number(outgoing.durationSec);
        const durDisplay = Number.isFinite(d) && d > 0 ? `${d}s` : 'unknown';
        log(`scrobble: skip submit (ineligible): "${outgoing.title ?? ''}" elapsed=${elapsed}s duration=${durDisplay}.`);
      }
    }
    return result;
  } catch (err) {
    // The per-call catches above make this nearly unreachable; it exists so
    // a bug here can never take out the per-track process that still has to
    // write now-playing metadata and push TuneIn/Discord after us.
    result.skipped = 'error';
    result.error = err?.message ?? String(err);
    log(`scrobble: internal error: ${result.error}`);
    return result;
  }
}
