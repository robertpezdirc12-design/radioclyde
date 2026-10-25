// LRC text -> the line shape the "Besedila" panel (public/app.js) reads from
// GET /api/lyrics/current: { synced, lines: [{ startMs, text }] }. LRCLIB
// serves its synced lyrics as LRC, so this is the one parse of it
// (lyrics/lyricsService.js); plainLyrics bodies go through plainLines().
//
//   [00:12.34]a line              one stamp
//   [00:12.34][01:02.00]chorus    several: the line repeats at each
//   [offset:+250]                 a file-wide shift. LRC's convention (also
//                                 Navidrome's structuredLyrics.offset):
//                                 positive makes lines appear SOONER
//                                 (startMs - offset), negative later
//   [ar:Artist] [ti:Title]        metadata tags, dropped
//   <00:12.80>word                word-level stamps, stripped to plain text
//
// A stamped line whose text is empty or an instrumental marker (a "rest":
// empty, a bare note glyph, "(instrumental)", "[au: instrumental]") stays in
// with startMs kept and text '' -- the panel renders it as the "instrumentalni
// del" rest, which is exactly where the singing stops. An unstamped plain-text
// line is kept untimed (startMs null -- the panel never highlights it); an
// unstamped marker drops instead, because a rest with no timestamp can never
// become the current line, so it would say nothing. Untimed lines sort to the
// END: unknown timing means unknown position.

const LEAD_STAMP = /^\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
const WORD_STAMP = /<\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?>/g;
// Bracketed metadata tags: [ar:] [ti:] [au:] [by:] [re:] [ve:] [length:] and
// friends -- a leading "[" + short tag + ":" + anything + "]". Timestamps
// never match this (their head is digits, not letters).
const META_TAG = /^\[[a-zA-Z]{1,10}:[^\]]*\]$/;
// Anchored, so a song that merely sings the word "instrumental" is not caught
// (SUB/WAVE's exact pattern).
const INSTRUMENTAL_RE = /^\s*[[(]?\s*(?:au\s*:\s*)?instrumental\s*[)\]]?\s*$/i;

function stampMs(m) {
  const min = Number(m[1]);
  const sec = Number(m[2]);
  // The fraction's digit count is its unit: .5 tenths, .50 hundredths,
  // .500 milliseconds -- padding to 3 digits and reading as ms covers all.
  const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
  return (min * 60 + sec) * 1000 + frac;
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** True when a line text marks an instrumental rest: empty, only note
 *  glyphs (a doubled/tripled "♪ ♪ ♪" is still just a rest), or the explicit
 *  "(instrumental)" / "[au: instrumental]" marker spellings. */
export function isRestMarker(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (INSTRUMENTAL_RE.test(t)) return true;
  return /^[♪♫]+$/.test(t.replace(/\s+/g, ''));
}

/** Timed lyrics from LRC text, or null when it carries no stamped line. */
export function parseLrc(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let offsetMs = 0;
  const timed = [];
  const untimed = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const offset = OFFSET_TAG.exec(line);
    if (offset) {
      offsetMs = Number(offset[1]);
      continue;
    }
    const stamps = [];
    let rest = line;
    for (let m = LEAD_STAMP.exec(rest); m; m = LEAD_STAMP.exec(rest)) {
      stamps.push(stampMs(m));
      rest = rest.slice(m[0].length);
    }
    // Metadata tags and unstamped text both land here.
    if (!stamps.length) {
      if (META_TAG.test(line) || isRestMarker(line)) continue;
      untimed.push({ startMs: null, text: collapse(line) });
      continue;
    }
    const words = collapse(rest.replace(WORD_STAMP, ''));
    for (const startMs of stamps) timed.push({ startMs, text: isRestMarker(words) ? '' : words });
  }
  if (!timed.length) return null;
  // Sorted because a repeated chorus stamps one line at several points, and
  // stable so two lines at the same instant keep the file's order.
  const shifted = timed
    .map((l) => ({ startMs: Math.max(0, l.startMs - offsetMs), text: l.text }))
    .sort((a, b) => a.startMs - b.startMs);
  return { synced: true, lines: [...shifted, ...untimed] };
}

/** Untimed lyrics from plain text, or null when there is nothing to show.
 *  Rest markers drop here: in a plain body there is no clock to make them
 *  current, and an all-marker body is metadata, not lyrics. */
export function plainLines(text) {
  if (typeof text !== 'string') return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isRestMarker(l))
    .map((l) => ({ startMs: null, text: l }));
  return lines.length ? { synced: false, lines } : null;
}

/** The best lyrics an LRCLIB record (or a stored cache entry shaped like one)
 *  can offer, following the precedence synced > instrumental > plain:
 *    - a parseable syncedLyrics body wins;
 *    - an instrumental track has no words by definition -- one rest line at
 *      0 ms (the panel shows the "instrumentalni del" rest for the whole
 *      track) is the honest answer, and it is why the instrumental rank
 *      exists at all -- as a miss it would be indistinguishable from "not
 *      found";
 *    - else the plain body, untimed.
 *  null when the record carries no lyrics at all. */
export function recordToLyrics(record) {
  if (!record || typeof record !== 'object') return null;
  const synced =
    typeof record.syncedLyrics === 'string' && record.syncedLyrics.trim() ? parseLrc(record.syncedLyrics) : null;
  if (synced) return synced;
  if (record.instrumental === true) return { synced: true, lines: [{ startMs: 0, text: '' }] };
  return plainLines(record.plainLyrics);
}
