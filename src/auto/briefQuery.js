// Deterministic "Track Selection" brief parser -- since Val 28 the only
// brief parser (its former LLM counterpart, producer/trackSelection/
// query.js, is removed). Turns the brief's prose (plus optional structured
// `key: value` lines) into the same concrete query object the LLM's
// produce_query tool used to produce, so trackSelection/queue.js's
// buildTrackQueue() runs unchanged past this point.
//
// Design rules for this module:
//   - Same input + same genre tags => same query. No model, no judgment
//     calls: anything the code cannot resolve from the text itself is either
//     skipped (and reported) or raises a specific error telling the brief
//     author exactly what structured line to add.
//   - Negation-aware: lines like "No genre that is soundtracks, classical or
//     show tunes" contribute exclusion keywords and are removed from the
//     text BEFORE positive genre/artist matching runs, so a negated genre is
//     never picked as the show's genre.
//   - Explicit structured lines always win over prose: `- genre: Pop/Rock`
//     beats any fuzzy matching. The sample briefs show both styles; mixing
//     them is fine (structured lines are applied last).
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

// Fold to lowercase and strip diacritics so accented names and Slovenian
// caron characters match their ASCII forms during tag matching.
function fold(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokens(text) {
  return fold(text)
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'from', 'with', 'in', 'on', 'at', 'to',
  'only', 'both', 'any', 'some', 'tracks', 'track', 'songs', 'song', 'music',
  'show', 'artists', 'artist', 'albums', 'album', 'genres', 'genre', 'style',
  'styles', 'this', 'that', 'these', 'those', 'are', 'is', 'be', 'as', 'by',
  'draw', 'drawn', 'picked', 'played', 'favor', 'favoring', 'prefer',
]);

// "80s rock" resolves to "Pop/Rock" in the sample Plex library; token-overlap
// scoring plus a small synonym table covers the common casual style words
// without pretending to be a thesaurus.
function bestGenreMatch(text, genreTags) {
  const textTokens = new Set(tokens(text));
  let best = null;
  for (const tag of genreTags) {
    const tagTokens = tokens(tag).filter((t) => !STOPWORDS.has(t));
    if (tagTokens.length === 0) continue;
    const covered = tagTokens.filter((t) => textTokens.has(t)).length;
    if (covered <= 0) continue;
    const score = covered / tagTokens.length;
    // Rank: coverage first, then SPECIFICITY (a fully-matched single-word tag
    // like "Rock" loses to an equally-fully-matched compound tag like
    // "Pop/Rock" -- the compound carries more of the brief's meaning), then
    // the shorter tag. Keeps an "80s rock shop"-style brief from collapsing
    // onto a bare "Rock" tag when the text says both words.
    const rank = [score, tagTokens.length, -tag.length];
    if (!best || compareRank(rank, best.rank) > 0) {
      best = { tag, score, rank };
    }
  }
  return best;
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// negation / exclusion handling
// ---------------------------------------------------------------------------

const NEGATION_LINE_PATTERNS = [
  /^\s*(?:-\s*)?(?:no|not|nothing from|without|exclude(?:s|d)?|don'?t|do not|never|avoid(?:ing)?)\b/i,
  /\bno christmas\b/i,
];

const KNOWN_EXCLUSION_EXPANSIONS = [
  { match: /\bchristmas\b|\bxmas\b|\bsanta\b|\bholiday\b/i, keywords: ['christmas', 'santa', 'xmas', 'holiday'] },
  { match: /\bsoundtracks?\b|\bscores?\b/i, keywords: ['soundtrack'] },
  { match: /\bshow tunes?\b|\bmusicals?\b/i, keywords: ['show tunes', 'musical'] },
  { match: /\bcompilations?\b|"?\bvarious artists\b"?|greatest hits|\bbest of\b/i, keywords: ['greatest hits', 'best of', 'various artists', 'compilation'] },
  { match: /\blive (?:versions?|recordings?|albums?)\b/i, keywords: ['live'] },
  { match: /\bremix(es|ed)?\b/i, keywords: ['remix'] },
  { match: /\bkaraoke\b/i, keywords: ['karaoke'] },
];

// Pulls the object of a negation out of the line for keyword expansion:
// "nothing from soundtracks or compilation albums" -> soundtracks, compilations.
// The bare-phrase capture is deliberately conservative: phrases with digits or
// rule-like words (track lengths, repeat rules, genres) are NOT keywords --
// "No track longer than 5 minutes" must never ban tracks matching "track
// longer than 5".
const BARE_KEYWORD_BLOCKLIST =
  /\b(track|tracks|song|songs|artist|artists|album|albums|longer|shorter|than|minutes?|mins?|seconds?|secs?|repeat(?:ed|ing)?|genre|decade|over|under)\b/i;

function exclusionKeywordsFromLine(line) {
  const found = new Set();
  for (const { match, keywords } of KNOWN_EXCLUSION_EXPANSIONS) {
    if (match.test(line)) keywords.forEach((kw) => found.add(kw));
  }
  // Bare phrases after the negation word become literal keywords
  // (e.g. "nothing from the Now series" -> "now series").
  const bare = /(?:no|nothing from|without|exclude)\s+([^.,;]+)$/i.exec(line.trim());
  if (bare) {
    for (const piece of bare[1].split(/\s+or\s+|,/i)) {
      const cleaned = piece.replace(/^["']|["'.]+$/g, '').trim();
      if (cleaned.length >= 3 && cleaned.length <= 25 && !/\d/.test(cleaned) && !BARE_KEYWORD_BLOCKLIST.test(cleaned)) {
        found.add(cleaned.toLowerCase());
      }
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// structured `key: value` lines (highest priority)
// ---------------------------------------------------------------------------

const STRUCTURED_KEYS = {
  artist: 'artist',
  izvajalec: 'artist',
  genre: 'genre',
  zanr: 'genre',
  'z\u0161anr': 'genre',
  decade: 'decade',
  desetletje: 'decade',
  artists: 'artistList',
  izvajalci: 'artistList',
  folder: 'folder',
  mapa: 'folder',
  'album keyword': 'albumKeyword',
  'album genre': 'albumGenre',
  exclude: 'excludeKeywords',
  izkljuci: 'excludeKeywords',
  'max track length': 'maxTrackDurationSeconds',
  'min track length': 'minTrackDurationSeconds',
  // P3 #14 (LibreTime Smart Blocks): "- smart block: <name>" resolves the
  // whole Track Selection section against config.smartBlocks -- the named
  // block's criteria+limit+order replace prose parsing (producer/
  // smartBlocks.js). Diacritics folded by the same fold() used for genre
  // matching, so "pametni blok" and smart block naming stay flexible.
  'smart block': 'smartBlock',
  'pametni blok': 'smartBlock',
};

function parseDurationField(value) {
  const v = value.trim();
  const clock = /^(\d+):([0-5]\d)$/.exec(v);
  if (clock) return parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
  const min = /^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)\b/i.exec(v);
  if (min) return Math.round(parseFloat(min[1]) * 60);
  const sec = /^(\d+)\s*(?:seconds?|secs?|s)\b/i.exec(v);
  if (sec) return parseInt(sec[1], 10);
  const bare = /^(\d+)$/.exec(v);
  if (bare) return parseInt(bare[1], 10) * 60; // bare number = minutes, matching the docs' phrasing
  return null;
}

function parseStructuredLines(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
    const match = /^([a-z\u0161\u017e\u010d\u0107\u0111 ]+?)\s*:\s*(.+)$/i.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const field = STRUCTURED_KEYS[key];
    if (!field) continue;
    const value = match[2].trim();
    if (field === 'decade') {
      const decade = parseDecade(value);
      if (decade) out.decade = decade;
    } else if (field === 'excludeKeywords') {
      out.excludeKeywords = (out.excludeKeywords ?? []).concat(
        value.split(/,|;/).map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
    } else if (field === 'artistList') {
      out.artistList = (out.artistList ?? []).concat(value.split(/,|;/).map((s) => s.trim()).filter(Boolean));
    } else if (field === 'maxTrackDurationSeconds' || field === 'minTrackDurationSeconds') {
      const seconds = parseDurationField(value);
      if (seconds != null) out[field] = seconds;
    } else {
      out[field] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// prose parsing
// ---------------------------------------------------------------------------

export function parseDecade(value) {
  const v = String(value).trim();
  let m = /(?:^|\D)(\d{4})s?\b/.exec(v);
  if (m) {
    const year = parseInt(m[1], 10);
    if (year >= 1900 && year <= 2100) return String(year - (year % 10));
  }
  m = /\b(\d{2})s\b/.exec(v); // "80s", "60s"
  if (m) {
    const short = parseInt(m[1], 10);
    if (short >= 20 && short <= 99) return String(short < 30 ? 2000 + short : 1900 + short);
  }
  return null;
}

function parseProse(text, genreTags) {
  const out = { excludeKeywords: [] };
  const positiveLines = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^\s*[-*]\s*/, '').trim();
    if (!line) continue;

    // RULES first -- several of them read like negations ("Don't repeat the
    // same artist", "No track longer than 5 minutes") and must never fall
    // into the exclusion-keyword gate at the bottom of this loop.

    if (!out.maxTrackDurationSeconds) {
      const m =
        /\b(?:no tracks? )?(?:longer|over|more)\s+than\s+(\d+(?::[0-5]\d)?)\s*(?:minutes?|mins?|min)\b/i.exec(line) ||
        /\bunder\s+(\d+(?::[0-5]\d)?)\s*(?:minutes?|mins?|min)\b/i.exec(line) ||
        /\b(\d+(?::[0-5]\d)?)\s*(?:minutes?|mins?|min)\s+or\s+(?:less|under)\b/i.exec(line);
      if (m) out.maxTrackDurationSeconds = parseDurationField(m[1]);
    }
    if (!out.minTrackDurationSeconds) {
      const m =
        /\b(?:no tracks? )?shorter\s+than\s+(\d+)\s*(?:minutes?|mins?|min|seconds?|secs?)\b/i.exec(line);
      if (m) out.minTrackDurationSeconds = parseDurationField(m[1]);
      else if (/\bno short interludes\b|\bno skits?\b/i.test(line)) out.minTrackDurationSeconds = 120;
    }

    if (/\bdon'?t repeat the same artist\b|\bno repeated artists?\b|\beach track by a different artist\b/i.test(line)) {
      out.repeatArtist = false;
    }
    if (/\bdon'?t cap at one track per album\b/i.test(line)) {
      out.oneTrackPerAlbum = false;
    } else if (/\bone track per album\b|\bspread across (?:different|several|various) albums?\b/i.test(line)) {
      out.oneTrackPerAlbum = true;
    }
    if (/\bfavor(?:ing)? (?:well-known|popular)\b|\bwell-known tracks?\b|\bpopular tracks?\b/i.test(line)) {
      out.weightPopular = true;
    }
    if (/\brecently added\b|\bnew additions?\b|\bwhat'?s just arrived\b/i.test(line)) {
      out.recentlyAdded = true;
    }
    if (/\b(?:pick|choose)\s+a\s+random\s+album\b|\bone (?:whole )?random(ly[- ]pick(?:ed)?)? album\b/i.test(line)) {
      out.singleAlbum = true;
    }
    const albumKeyword = /albums?\s+(?:titled|named|with)\s+["']?([^"']+)["']?\s+in\s+(?:the\s+)?(?:album\s+)?title/i.exec(line);
    if (albumKeyword && !out.albumKeyword) out.albumKeyword = albumKeyword[1].trim();
    const folder = /only from\s+(?:the\s+)?(?:library\s+)?folder\s+["']?([^\s"']+)["']/i.exec(line);
    if (folder && !out.folder) out.folder = folder[1].trim();

    if (!out.artist) {
      // "artist: X" style was handled by structured lines; prose forms:
      // "by Elvis Presley" at line end, or "tracks by Elvis Presley".
      const m =
        /\b(?:by|from)\s+((?:[A-Z][\w'.&-]+)(?:\s+(?:[A-Z][\w'.&-]+|the|of|and))*)\s*$/.exec(line) ||
        /\btracks?\s+by\s+((?:[A-Z][\w'.&-]+)(?:\s+(?:[A-Z][\w'.&-]+|the|of|and))*)/.exec(line);
      if (m && !/decade|genre|album|folder/i.test(m[1])) out.artist = m[1].trim();
    }

    if (!out.decade) {
      const m = /\b(?:from|in|of)\s+the\s+(\d{4})s\b/i.exec(line) || /\b(\d{2}s)\b/i.exec(line);
      if (m) out.decade = parseDecade(m[1]);
    }

    // Exclusions LAST: a negation line contributes exclusion keywords and is
    // removed from positive genre matching, so "No genre that is soundtracks,
    // classical or show tunes" never picks those as the show's genre.
    if (NEGATION_LINE_PATTERNS.some((p) => p.test(line))) {
      out.excludeKeywords.push(...exclusionKeywordsFromLine(line));
      continue;
    }
    positiveLines.push(line);
  }

  if (!out.genre && genreTags.length > 0 && positiveLines.length > 0) {
    const joined = positiveLines.join(' ');
    const match = bestGenreMatch(joined, genreTags);
    if (match) {
      out.genre = match.tag;
      log(`briefQuery: genre "${match.tag}" matched from prose (score ${match.score.toFixed(2)})`);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

// Same contract the old LLM produceTrackQuery had: returns { query } whose
// shape buildTrackQueue() consumes. `genreTags` comes from
// librarySource.listGenreTagsAny() (real Plex tags, or the local library's
// own tag set) so the caller decides where metadata truth lives.
export function produceTrackQueryDeterministic({ trackSelectionText, genreTags = [], albumGenreTags = [] }) {
  if (!trackSelectionText?.trim()) {
    throw new Error('Brief has no "## Track Selection" text to parse.');
  }

  const structured = parseStructuredLines(trackSelectionText);
  const prose = parseProse(trackSelectionText, genreTags);

  const query = {
    artist: structured.artist ?? prose.artist ?? null,
    genre: structured.genre ?? prose.genre ?? null,
    decade: structured.decade ?? prose.decade ?? null,
    albumKeyword: structured.albumKeyword ?? prose.albumKeyword ?? null,
    folder: structured.folder ?? prose.folder ?? null,
    artistList: structured.artistList ?? prose.artistList ?? null,
    albumGenre: structured.albumGenre ?? null,
    recentlyAdded: structured.recentlyAdded ?? prose.recentlyAdded ?? false,
    singleAlbum: structured.singleAlbum ?? prose.singleAlbum ?? false,
    smartBlock: structured.smartBlock ?? null,
    excludeKeywords: [...new Set([...(prose.excludeKeywords ?? []), ...(structured.excludeKeywords ?? [])])],
    repeatArtist: structured.repeatArtist ?? prose.repeatArtist ?? true,
    oneTrackPerAlbum: structured.oneTrackPerAlbum ?? prose.oneTrackPerAlbum ?? false,
    weightPopular: structured.weightPopular ?? prose.weightPopular ?? false,
    maxTrackDurationSeconds: structured.maxTrackDurationSeconds ?? prose.maxTrackDurationSeconds ?? null,
    minTrackDurationSeconds: structured.minTrackDurationSeconds ?? prose.minTrackDurationSeconds ?? null,
  };

  // A block reference IS the selection: prose/structured criteria beside it
  // are ignored (the block is the operator's frozen decision -- mixing the
  // two would make "what plays" depend on which lines the brief happened to
  // carry). The caller (auto/produce.js) resolves the name against
  // config.smartBlocks and expands it there, where the honest unknown-name
  // error can list what IS defined.
  if (query.smartBlock) {
    log(`briefQuery: smart block "${query.smartBlock}" requested -- bypassing prose/structured criteria`);
    return { query };
  }

  if (query.albumGenre && albumGenreTags.length > 0 && !albumGenreTags.includes(query.albumGenre)) {
    const folded = fold(query.albumGenre);
    const close = albumGenreTags.find((t) => fold(t).includes(folded) || folded.includes(fold(t)));
    if (close) query.albumGenre = close;
    else {
      log(`briefQuery: albumGenre "${query.albumGenre}" not in library tags -- dropping`);
      query.albumGenre = null;
    }
  }

  if (query.genre && genreTags.length > 0 && !genreTags.includes(query.genre)) {
    const match = bestGenreMatch(query.genre, genreTags);
    if (match && match.score >= 0.5) {
      log(`briefQuery: structured genre "${query.genre}" resolved to real tag "${match.tag}"`);
      query.genre = match.tag;
    } else {
      throw new Error(
        `Brief's genre "${query.genre}" does not match any real tag in this library. ` +
          `Available tags: ${genreTags.join(', ')}. Use "- genre: <exact tag>" in the brief.`
      );
    }
  }

  const hasSelection =
    query.smartBlock ||
    query.artist || query.genre || query.decade || query.albumKeyword || query.folder ||
    query.artistList?.length || query.albumGenre || query.recentlyAdded;

  if (!hasSelection) {
    throw new Error(
      'Could not deterministically resolve a selection from the "## Track Selection" section. ' +
        'Add at least one explicit line, e.g. "- genre: Pop/Rock", "- artist: Elvis Presley", ' +
        '"- decade: 1980", "- artists: Name One, Name Two" or "- smart block: <name from config.smartBlocks>" ' +
        '(free themes like "female vocalists" need the explicit artist list -- there is no model here to expand them).'
    );
  }

  log(`briefQuery: query = ${JSON.stringify(query)}`);
  return { query };
}

// ---------------------------------------------------------------------------
// rubric line parsing ("Rubrike: vreme, \u0161port, obzorje")
// ---------------------------------------------------------------------------

// Show briefs can request the service segments (auto/feeds.js) with a single
// "Rubrikes:" line anywhere in the markdown. Slovenian keywords are primary;
// English aliases work too. Diacritics-insensitive, order defines air order
// (weather first is just how the caller orders the three slots).
const RUBRIC_KEYWORDS = {
  vreme: 'weather',
  weather: 'weather',
  novice: 'news',
  news: 'news',
  sport: 'sport',
  sportne: 'sport',
  obzorje: 'onthisday',
  // ASCII forms are PRIMARY in this table: parseBriefRubrics de-diacriticizes
  // the keyword BEFORE lookup, so keys carrying real diacritics never match.
  'na danasnji dan': 'onthisday',
  onthisday: 'onthisday',
  'on this day': 'onthisday',
  // P4 #17 "Zanimivosti" (auto/trivia.js + auto/rockFacts.js) and P4 #19
  // "Na današnji dan v glasbi" (feeds.js musician-filtered on-this-day).
  zanimivosti: 'trivia',
  trivia: 'trivia',
  glasba: 'onthisdaymusic',
  'na danasnji dan v glasbi': 'onthisdaymusic',
  'obzorje glasbe': 'onthisdaymusic',
  onthisdaymusic: 'onthisdaymusic',
  // P4 #22 "Kviz" (auto/quizFacts.js): real question/answer content for the
  // existing quiz position (quizIntro/quizReveal around the middle track of
  // a brief whose Segments line includes "quiz").
  kviz: 'quiz',
  quiz: 'quiz',
  // P4 #25 "Anketa" (server/pollsStore.js): the active listener poll,
  // read at air time from the local store (works offline, like the quiz).
  anketa: 'poll',
  poll: 'poll',
  glasovi: 'poll',
  // P4 #26 "Poslušalci" (server/requestsStore.js): freshly approved listener
  // requests and dedications read on air (local store, works offline).
  poslusalci: 'listeners',
  zahteve: 'listeners',
  posvecila: 'listeners',
  requests: 'listeners',
  shoutouts: 'listeners',
};

export function parseBriefRubrics(descriptionText) {
  const match = String(descriptionText ?? '').match(/^\s*Rubrike\s*:\s*(.+)$/im);
  if (!match) return [];
  // Diacritics-insensitive: \u0161->s, \u010d->c, \u017e->z before matching.
  const deDiacritic = (s) => s.replace(/[\u0161\u0160]/g, 's').replace(/[\u010d\u010c]/g, 'c').replace(/[\u017e\u017d]/g, 'z');
  const seen = new Set();
  for (const part of match[1].split(/[,;]/)) {
    const keyword = deDiacritic(part.trim().toLowerCase());
    const candidates = [keyword, keyword.split(/\s+/)[0]]; // "sportne novice" -> "sportne"
    const rubric = candidates.map((candidate) => RUBRIC_KEYWORDS[candidate]).find(Boolean);
    if (rubric) seen.add(rubric);
  }
  return [...seen];
}
