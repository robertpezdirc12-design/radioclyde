// Per-artist trivia for the "Zanimivosti" rubric (P4 #17) -- the ONLINE half
// of the rubric (the offline half is the rockFacts.js corpus). Deterministic,
// keyless, no language model: for the artist about to play the station fetches
// real, verifiable facts and renders them through a fixed Slovenian template.
//
//   MusicBrainz ws/2 (1 request/s + mandatory User-Agent):
//     artist search -> Group + life-span.begin year + country + genre tags,
//     composed into ONE safe sentence ("Skupina Queen, iz Združenega
//     kraljestva, je nastala leta 1970"). Solo artists (type "Person") are
//     deliberately left to the fallback below -- MB begin dates for persons
//     mix career and birth dates, and inventing grammar around that would
//     risk wrong sentences on air.
//   sl.wikipedia REST summary (fallback):
//     the page extract's FIRST sentence, and only when it fits a spoken
//     aside (<= 24 words, the all-pools sentence ceiling) -- CUTTING ONLY,
//     never restructuring (docs/show-generation-research.md §3.1's no-surgery
//     discipline stands: no clause rewriting, no grammar invention). A first
//     sentence that runs past the budget drops the segment whole rather than
//     trimming mid-grammar -- a mangled sentence on air is worse than no
//     trivia (the P4 #29 instinct). Sentence boundaries respect Slovenian
//     date ordinals ("5. september" is NOT a boundary -- a period followed by
//     a lowercase word never ends a sentence).
//
// Contracts mirrored from auto/feeds.js: hard timeout on every fetch,
// null-on-failure (a factless artist simply gets no trivia segment), and an
// in-process TTL cache so prewarm + director + retries never hammer the
// sources. MusicBrainz calls are additionally serialized with a >= 1 s gap
// (their documented per-IP rate limit), even when several artists are
// fetched in parallel.
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { pickGeneralRockFacts } from './rockFacts.js';

const log = createLogger('station');

const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const WIKIPEDIA_SL_SUMMARY = 'https://sl.wikipedia.org/api/rest_v1/page/summary';
// Same station user agent the feeds module has used since the rubrics landed
// (feeds.js API User-Agent intentionally NOT rebranded -- engineering id).
const USER_AGENT = 'RadioClyde-autoRadio/1.0 (self-hosted radio automation; deterministic templates)';
const MUSICBRAINZ_MIN_GAP_MS = 1000;
// The spoken-aside budget for a wikipedia fact -- the same 24-word ceiling
// every template-pool sentence obeys (test/voiceRegister.test.mjs block D).
export const SPOKEN_SENTENCE_MAX_WORDS = 24;

export function foldArtist(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// MusicBrainz country codes -> Slovenian genitive, so the fact builder can
// say "iz {country}" without grammar guesses. Codes outside the table simply
// omit the country part of the sentence.
export const COUNTRY_GENITIVE_SLOVENIAN = {
  AR: 'Argentine', AU: 'Avstralije', AT: 'Avstrije', BE: 'Belgije',
  BA: 'Bosne in Hercegovine', BR: 'Brazilije', CA: 'Kanade', HR: 'Hrvaške',
  CZ: 'Češke', DK: 'Danske', FI: 'Finske', FR: 'Francije',
  DE: 'Nemčije', GR: 'Grčije', HU: 'Madžarske', IS: 'Islandije',
  IE: 'Irske', IT: 'Italije', JP: 'Japonske', MX: 'Mehike',
  NL: 'Nizozemske', NZ: 'Nove Zelandije', NO: 'Norveške', PL: 'Poljske',
  PT: 'Portugalske', RU: 'Rusije', RS: 'Srbije', SI: 'Slovenije',
  ES: 'Španije', SE: 'Švedske', CH: 'Švice', TR: 'Turčije',
  GB: 'Združenega kraljestva', US: 'ZDA',
};

// Pure (network-free) fact builder -- the testable core. Returns ONE full
// sentence WITHOUT a trailing period (the template pool adds punctuation),
// or null when MusicBrainz carries nothing safe to say.
export function buildArtistFactFromMusicBrainz(mbArtist) {
  if (!mbArtist || typeof mbArtist !== 'object' || mbArtist.type !== 'Group') return null;
  const name = typeof mbArtist.name === 'string' ? mbArtist.name.trim() : '';
  if (!name) return null;

  const beginYear = parseInt(String(mbArtist['life-span']?.begin ?? '').slice(0, 4), 10);
  const country = COUNTRY_GENITIVE_SLOVENIAN[mbArtist.country] ?? null;
  const genres = (Array.isArray(mbArtist.tags) ? mbArtist.tags : [])
    .filter((tag) => typeof tag?.name === 'string' && tag.name.length > 0 && tag.name.length <= 24 && (tag.count ?? 0) > 0)
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 2)
    .map((tag) => tag.name);

  if (Number.isFinite(beginYear) && beginYear > 1000) {
    return country
      ? `Skupina ${name}, iz ${country}, je nastala leta ${beginYear}`
      : `Skupina ${name} je nastala leta ${beginYear}`;
  }
  if (country) return `Skupina ${name} prihaja iz ${country}`;
  if (genres.length > 0) return `Skupina ${name} igra predvsem ${genres.join(' in ')}`;
  return null;
}

// ---------------------------------------------------------------------------
// fetch + cache helpers
// ---------------------------------------------------------------------------

// MusicBrainz allows 1 request/s per IP. Parallel Promise.all callers are
// serialized through this chain (a plain "sleep until lastMbAt + gap" would
// race: every caller would compute the same remaining wait and fire
// together), so request STARTS stay >= 1 s apart no matter how many artists
// are being trivia-fetched at once.
let musicBrainzChain = Promise.resolve();
let lastMusicBrainzAt = 0;

function withMusicBrainzSpacing(task) {
  const run = musicBrainzChain.then(async () => {
    const wait = lastMusicBrainzAt + MUSICBRAINZ_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastMusicBrainzAt = Date.now();
    return task();
  });
  musicBrainzChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function fetchMusicBrainzArtist(artist, timeoutMs) {
  return withMusicBrainzSpacing(async () => {
    const url = `${MUSICBRAINZ_API}/artist?query=${encodeURIComponent(`artist:"${artist}"`)}&fmt=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from MusicBrainz`);
    const json = await res.json();
    return json?.artists?.[0] ?? null;
  });
}

// Fallback: the FIRST sentence of the sl.wikipedia extract, budget-checked
// for a spoken aside. The extract is normalized (whitespace collapse, ONE
// trailing punctuation char dropped -- the template adds it back) but never
// restructured.
//
// Entity guard: a name like "Bush" resolves to the plant just as happily as
// to the band, so the page must be a normal article (not a disambiguation
// page) AND its normalized title must fold-match the artist we asked about --
// anything else is not a fact about THIS artist and returns null instead of
// risking a wrong sentence on air.
//
// Val 28 A3: the whole-extract contract used to speak entire encyclopedia
// paragraphs verbatim -- the most formal, least conversational text the
// station owns. The cut is a pure selection: FIRST complete sentence only,
// kept only when it fits the 24-word spoken-aside budget (the same ceiling
// test/voiceRegister.test.mjs enforces on every pool sentence). Budget miss
// -> null (honest drop); abbreviations like "5. september" never split a
// sentence (a boundary needs a period followed by whitespace + an uppercase
// word, or end-of-text).
export function firstSpokenSentence(extract, { maxWords = SPOKEN_SENTENCE_MAX_WORDS } = {}) {
  const text = String(extract ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // First sentence end: [.!?] followed by whitespace + an UPPERCASE start
  // (Unicode -- Č/Š/Ž included) or end-of-text. A period before a lowercase
  // word ("5. september", "npr. beseda") is an abbreviation dot, not a
  // boundary.
  const boundary = /[.!?](?=\s+[\p{Lu}]|\s*$)/u.exec(text);
  const candidate = boundary ? text.slice(0, boundary.index) : text;
  const words = candidate.split(' ').filter((w) => /\S/.test(w));
  if (words.length === 0) return null;
  if (words.length > maxWords) return null;
  // Same trailing-punctuation strip the whole-extract path always did -- the
  // template pool adds the final period back (triviaArtist/triviaGeneral).
  return candidate.replace(/[.\s]+$/, '');
}

async function fetchWikipediaSlSummary(artist, expectedFold, timeoutMs) {
  const url = `${WIKIPEDIA_SL_SUMMARY}/${encodeURIComponent(artist)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from sl.wikipedia`);
  const json = await res.json();
  if (json?.type === 'disambiguation') {
    log(`trivia/artist: "${artist}" je na sl.wikipedia razločevalna stran -- segment spusti.`);
    return null;
  }
  const title = String(json?.titles?.normalized ?? json?.title ?? '');
  if (foldArtist(title) !== expectedFold) {
    log(`trivia/artist: "${artist}" je na sl.wikipedia stran "${title}" -- naslov se ne ujema, segment spusti.`);
    return null;
  }
  const extract = String(json?.extract ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!extract) return null;
  const spoken = firstSpokenSentence(extract);
  if (!spoken) {
    // Two honest drops share this branch: a first sentence past the spoken
    // budget, and a degenerate extract with no measurable words. Either way
    // the segment vanishes rather than airing encyclopedia prose.
    log(`trivia/artist: "${artist}" -- prvi stavek wikipedia izvlečka je predolg za govorno vmesno besedo ali brez besed -- segment spusti.`);
    return null;
  }
  return { artist, source: 'wikipedia-sl', text: spoken };
}

const artistTriviaCache = new Map(); // fold(name) -> { at, value }

// One artist -> one fact ({ artist, source, text }) or null. Cached per
// artist for the TTL so multiple shows across one process never re-fetch.
export async function fetchArtistTrivia(artist, { timeoutMs = 10_000, ttlMs = 24 * 60 * 60_000 } = {}) {
  const key = foldArtist(artist);
  if (!key) return null;
  const hit = artistTriviaCache.get(key);
  if (hit && Date.now() - hit.at <= ttlMs) return hit.value;
  if (hit) artistTriviaCache.delete(key);

  let value = null;
  try {
    // MB errors are SOFT: an HTTP failure / timeout on MusicBrainz must not
    // kill the wikipedia fallback (the chain is MB fact -> wiki extract,
    // not "MB or nothing"); only a wikipedia failure nulls the artist.
    let mbText = null;
    try {
      const mbArtist = await fetchMusicBrainzArtist(artist, timeoutMs);
      // Entity guard, MusicBrainz side: the top search hit must BE the artist
      // we asked about (folded-name equality) -- otherwise the fact would
      // describe a different band that merely scores better on the query.
      const mbMatch = mbArtist && foldArtist(mbArtist.name) === key ? mbArtist : null;
      mbText = buildArtistFactFromMusicBrainz(mbMatch);
    } catch (mbErr) {
      log(`trivia/artist: MusicBrainz za "${artist}" ni odgovoril (${mbErr.message}) -- posku\u0161am sl.wikipedia.`);
    }
    value = mbText
      ? { artist, source: 'musicbrainz', text: mbText }
      : await fetchWikipediaSlSummary(artist, key, timeoutMs);
  } catch (err) {
    log(`trivia/artist: "${artist}" brez zanimivosti (${err.message}) -- segment spusti.`);
    return null;
  }
  if (value) artistTriviaCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// unified collection -- what auto/produce.js calls after track selection
// ---------------------------------------------------------------------------

function triviaSettings() {
  const cfg = config.autoRadio?.rubrics ?? {};
  return {
    maxArtists: cfg.triviaMaxArtists ?? 6,
    generalCount: cfg.triviaGeneralCount ?? 3,
    timeoutSeconds: cfg.timeoutSeconds ?? 10,
  };
}

// Builds the rubric's data package: one fact per unique show artist (in
// tracklist order, capped for politeness) + `generalCount` facts from the
// local rock corpus. OFFLINE BEHAVIOR (deliberately different from the other
// rubrics): the network half is skipped, but the corpus half still works --
// general rock trivia never needs the network. `seed` (typically
// `${showId}|${date}`) rotates the corpus across days deterministically.
export async function collectArtistTrivia({ tracks = [], offline = false, seed = 'trivia' } = {}) {
  const settings = triviaSettings();
  const uniqueArtists = [];
  const seen = new Set();
  for (const track of tracks) {
    const key = foldArtist(track?.artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueArtists.push(track.artist);
  }
  const artistFacts = offline
    ? []
    : (await Promise.all(
        uniqueArtists
          .slice(0, settings.maxArtists)
          .map((artist) => fetchArtistTrivia(artist, { timeoutMs: settings.timeoutSeconds * 1000 }))
      )).filter(Boolean);
  return {
    artistFacts,
    generalFacts: pickGeneralRockFacts(settings.generalCount, seed),
  };
}
