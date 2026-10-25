// Read-only LRCLIB client (https://lrclib.net), the community synced-lyrics
// database behind the "Besedila" panel (lyrics/lyricsService.js). Keyless, but
// LRCLIB asks a client to NAME ITSELF in the User-Agent -- we do, with the
// project's repo URL.
//
// One lenient GET /api/search per lookup (artist_name + track_name +
// album_name when known + duration), NOT /api/get: an exact-signature miss
// says nothing a search cannot, and a search answers both the exact cut and
// its near-titled neighbours in one request. WE hold the result to our own
// +-2 s duration gate and NFKD-folded title/artist agreement, because a lyric
// file for a different cut (radio edit, extended mix, live) is timed against
// different audio. No lookup at all without a duration > 0 -- nothing else
// tells two cuts apart.
//
// Etiquette, straight from SUB/WAVE's measured behaviour (2026-10-24:
// LRCLIB refuses with 503 well below 1 req/s): every request goes through ONE
// promise-chain throttle gate at MIN_GAP_MS spacing of request STARTS, so a
// station with several lookups queued still sends at most ~1 req/s, and a
// rejected link never poisons the callers queued behind it. A refused request
// (503/429) is asked again exactly twice, RETRY_DELAYS_MS apart, waiting
// OUTSIDE the throttle so one stubborn song does not hold the others up; each
// wait is max(retryDelay, Retry-After) capped at RETRY_AFTER_CAP_MS. Past
// that the client THROWS -- "ask later", never a definitive miss -- while
// 404/400 are definitive: null.
//
// Every moving part (fetch, clock, sleep, gaps, timeouts, retry delays, base
// URL) is injectable so the tests never touch the real network.
const USER_AGENT = 'radioclyde/1.0 (+https://github.com/robertpezdirc12-design/radioclyde)';
export const LRCLIB_DURATION_TOLERANCE_SEC = 2;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MIN_GAP_MS = 1100; // 1 req/s with a safety margin
// Waits before the second and third try of a refused request. Retry-After,
// when LRCLIB sends one, stretches a wait up to RETRY_AFTER_CAP_MS.
const DEFAULT_RETRY_DELAYS_MS = [5000, 15000];
const RETRY_AFTER_CAP_MS = 30000;

// Case, accents and punctuation folded away, letters of every script kept: a
// Gurmukhi title must not fold to '' and then "contain" everything.
export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** "Skrillex Feat. Chief Keef, Corbin" -> "Skrillex". A bare slash is part of
 *  a name (AC/DC), so it never splits. */
export function leadArtist(artist) {
  return String(artist ?? '')
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|x|&)\s+|\s*[,;]\s*/i)[0]
    .trim();
}

/** "Superman (feat. X) [Remix]" -> "Superman [Remix]": only the credit goes. */
export function searchTitle(title) {
  return String(title ?? '')
    .replace(/\s*[([](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi, '')
    .trim();
}

function agrees(ours, theirs) {
  const a = fold(ours);
  const b = fold(theirs);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

/** The search result to use for `track`, or null when none is the same cut:
 *  within the duration tolerance AND title/lead-artist agreement, preferring
 *  synced > instrumental > plain. */
export function bestSearchMatch(results, track) {
  if (!Array.isArray(results)) return null;
  const durationSec = Number(track.durationSec);
  const same = results.filter(
    (r) =>
      Number.isFinite(Number(r?.duration)) &&
      Math.abs(Number(r.duration) - durationSec) <= LRCLIB_DURATION_TOLERANCE_SEC &&
      agrees(searchTitle(track.title), r.trackName) &&
      agrees(leadArtist(track.artist), r.artistName)
  );
  return same.find((r) => r.syncedLyrics) ?? same.find((r) => r.instrumental) ?? same.find((r) => r.plainLyrics) ?? null;
}

export function createLrclibClient({
  baseUrl = 'https://lrclib.net',
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  minGapMs = DEFAULT_MIN_GAP_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  // Serialize every request on one promise chain, spacing request STARTS, so
  // a station with several lookups queued still sends at most 1 req/s.
  let gate = Promise.resolve();
  let lastStart = 0;
  function throttled(fn) {
    const run = gate.then(async () => {
      const wait = lastStart + minGapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return fn();
    });
    // A rejected link must not poison every caller queued behind it.
    gate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // One try, inside the throttle. A refusal comes back as the wait LRCLIB
  // asked for (0 when it named none), so the retry can sleep outside the gate.
  // The timeout deadline covers establishing the response AND reading its
  // body (the timer is re-armed once headers arrive); it is unref'd so a
  // pending deadline can never keep an otherwise-idle process alive.
  function attempt(url) {
    return throttled(async () => {
      const controller = new AbortController();
      let timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: controller.signal,
        });
        // 404, and a 400 (LRCLIB refusing the question rather than failing to
        // answer it), mean it has nothing.
        if (res.status === 404 || res.status === 400) {
          await res.body?.cancel?.();
          return { answer: null };
        }
        if (res.status === 503 || res.status === 429) {
          await res.body?.cancel?.();
          const retryAfterSec = Number(res.headers?.get?.('Retry-After'));
          return {
            refusedFor: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0,
          };
        }
        if (!res.ok) throw new Error(`LRCLIB answered HTTP ${res.status}`);
        // Body deadline: re-arm the abort over res.json(), so a stalled body
        // is bounded by the same TIMEOUT_MS.
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        return { answer: await res.json() };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  // null when LRCLIB has nothing; throws on anything that is not an answer.
  async function request(params) {
    const url = `${root}/api/search?${new URLSearchParams(params)}`;
    for (let tries = 0; ; tries++) {
      const result = await attempt(url);
      if ('answer' in result) return result.answer;
      if (tries >= retryDelaysMs.length) {
        throw new Error(`LRCLIB refused the request (HTTP 503/429) ${tries + 1} times`);
      }
      const wait = Math.min(RETRY_AFTER_CAP_MS, Math.max(retryDelaysMs[tries], result.refusedFor));
      await sleep(wait); // OUTSIDE the throttle gate
    }
  }

  return {
    /** The record for `track` ({ artist, title, album, durationSec }) or null
     *  when LRCLIB has nothing for that exact cut. Throws "ask later" when
     *  LRCLIB did not answer -- the caller backs that song off instead of
     *  caching a miss. */
    async find(track) {
      const artist = String(track?.artist ?? '').trim();
      const title = String(track?.title ?? '').trim();
      const durationSec = Math.round(Number(track?.durationSec));
      if (!artist || !title || !(durationSec > 0)) return null;
      const params = {
        artist_name: leadArtist(artist),
        track_name: searchTitle(title),
        duration: String(durationSec),
      };
      // An empty album_name would filter (params are ANDed); absent is the
      // honest "unknown", so it only rides along when we actually have one.
      if (String(track.album ?? '').trim()) params.album_name = String(track.album).trim();
      const results = await request(params);
      const found = Array.isArray(results) ? bestSearchMatch(results, { artist, title, durationSec }) : null;
      return found ?? null;
    },
  };
}
