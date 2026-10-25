// Rubrike kot skilli (SUB/WAVE steal, no-AI): every deterministic auto-mode
// service segment (vreme / novice / šport / obzorje) can carry its cadence
// (cooldown) -- and, where the reader is a generic RSS client, its feed URL --
// in an operator-editable skills/<slug>/SKILL.md file with a tiny frontmatter,
// so an operator changes cadence without touching code.
//
//   skills/arso-vreme/SKILL.md     -> rubric key 'weather'
//   skills/rtv-novice/SKILL.md     -> rubric key 'news'
//   skills/rtv-sport/SKILL.md      -> rubric key 'sport'
//   skills/wikidata-dan/SKILL.md   -> rubric keys 'onthisday' + 'onthisdaymusic'
//
// SKILL.md format (SUB/WAVE's RESTRICTED frontmatter -- the line-based
// fallback grammar its loader documents, not real YAML; deliberately no new
// dependency):
//
//   ---
//   name: ARSO vreme
//   cooldown: 15m
//   feed: https://meteo.arso.gov.si/...rss...
//   ---
//   Body: free Slovenian operator-facing text (what the rubrique airs, where
//   the data comes from, what happens when the source is dead).
//
// Grammar rules (every one of them is pinned in test/skills.test.mjs):
//   - frontmatter = flat `key: value` lines between two `---` lines;
//   - allowed keys: name (1..60 chars), cooldown (see parseCooldown), feed
//     (http/https URL, no spaces), cron (OPTIONAL and RESERVED -- accepted,
//     parsed, ignored; radioclyde's airing cadence lives in station.json /
//     the scheduler, not in the skill);
//   - unknown keys are ignored (forward-compat, same as SUB/WAVE);
//   - values may be double/single-quoted (matching pair is stripped);
//   - a UTF-8 BOM is stripped;
//   - duplicate keys: LAST wins;
//   - a missing closing `---` makes the file malformed -> the loader returns
//     null and the skill is skipped -- honest, never a crash;
//   - a structurally valid block with ZERO usable keys counts as empty ->
//     null (pinned decision: a SKILL.md that says nothing is not a skill; the
//     code fallback in rubriqueDefaults wins).
//
// Honesty rules: skills live IN THE REPOSITORY (shipped with the code), so
// unlike SUB/WAVE there is no untrusted import path and no .pending + sha256
// trust gate -- the deviation is documented in docs/skills.md. A missing or
// invalid skill never breaks a show: rubriqueDefaults falls back to the same
// literals feeds.js hardcoded before this layer existed, so out-of-the-box
// behavior is byte-identical.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SUB/WAVE's slug rule verbatim: lowercase, starts alphanumeric, then
// alphanumeric/hyphen, at most 49 chars. The directory name under skills/
// must match or the skill is ignored.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

// The shipped load root, resolved from this module so it works regardless of
// process.cwd() (the scheduler, the web server and tests all boot from
// different working directories).
const DEFAULT_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

// ---------------------------------------------------------------------------
// cooldown parsing
// ---------------------------------------------------------------------------

// '15m' -> 900000, '2h' -> 7200000, '90s' -> 90000, '45' -> 45000.
// A bare number means SECONDS -- a deliberate, documented deviation from
// SUB/WAVE, where a bare number meant minutes; seconds are the least
// surprising unit for a bare literal and the docs say so loudly. Junk
// (empty, negative, unknown unit, non-numeric) -> null: the caller then
// falls back to its own literal instead of guessing what the operator meant.
// '0m' (0 ms) is ALLOWED and pinned: it disables the in-process cache --
// every fetch call hits the source. That is honest (the operator asked for
// it), and the fetchers only run a handful of times per hour.
export function parseCooldown(str) {
  if (typeof str !== 'string') return null;
  const match = /^(\d+)([smh]?)$/.exec(str.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] || 's'; // bare number = seconds (documented)
  return n * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3600_000);
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter
// ---------------------------------------------------------------------------

// The closing fence must exist: `---` ... `---`. SUB/WAVE's fence regex
// verbatim (minus the body capture -- the body is operator prose and nothing
// in radioclyde consumes it programmatically).
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

// SUB/WAVE's legacy line parser, verbatim in spirit: blank lines and `#`
// comments are skipped, the line splits on the FIRST colon, a matching pair
// of quotes around the value is stripped, and a repeated key simply
// overwrites the earlier one (LAST wins). Lines without a colon are ignored.
function parseFrontmatterLines(block) {
  const data = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) data[key] = val;
  }
  return data;
}

const NAME_MAX = 60;
const FEED_RE = /^https?:\/\/\S+$/; // http/https URL, no spaces

// text -> { name, cooldownMs, feed, cron } | null.
//   - name: the declared display name (1..60 chars); an out-of-range value
//     drops the key (lenient, like SUB/WAVE's per-field rules), it never
//     fails the whole file;
//   - cooldownMs: parsed cooldown, null when absent/junk;
//   - feed: the declared URL, undefined when absent or not an http(s) URL;
//   - cron: the raw declared string -- ACCEPTED AND IGNORED (reserved).
// Malformed (no closing `---`, or an empty block) -> null.
export function parseSkillFrontmatter(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(/^\uFEFF/, ''); // BOM
  const match = FRONTMATTER_RE.exec(stripped);
  if (!match) return null;
  const data = parseFrontmatterLines(match[1]);
  if (Object.keys(data).length === 0) return null; // empty frontmatter -> not a skill (pinned)

  const name = typeof data.name === 'string' && data.name.length >= 1 && data.name.length <= NAME_MAX ? data.name : undefined;
  const cooldownMs = data.cooldown != null ? parseCooldown(data.cooldown) : null;
  const feed = typeof data.feed === 'string' && FEED_RE.test(data.feed) ? data.feed : undefined;
  const cron = typeof data.cron === 'string' && data.cron.length > 0 ? data.cron : undefined;
  return { name, cooldownMs, feed, cron };
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

// Reads every directory entry under `dir` whose name matches SLUG_RE and that
// carries a readable SKILL.md. Unreadable/malformed entries are skipped,
// a missing dir yields an empty Map -- honest, never a crash.
//
// NO per-process cache, by design: feeds.js resolves rubrique defaults on
// every fetch (an explicit caller TTL wins over the skill, which wins over
// the code fallback), and a fresh read of four ~300-byte files is cheaper
// than any invalidation strategy -- the directory's mtime does not change
// when a SKILL.md's CONTENT is edited, so mtime-busting would serve stale
// skills. The practical consequence is the good one: an edited cooldown or
// feed takes effect on the next fetch, with no restart.
export function loadSkills(dir = DEFAULT_SKILLS_DIR) {
  const map = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return map; // missing/unreadable dir -> empty Map
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // only skills/<slug>/ directories
    if (!SLUG_RE.test(entry.name)) continue; // non-matching dir name -> ignored
    let text;
    try {
      text = fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue; // unreadable (or absent) SKILL.md -> skipped
    }
    const parsed = parseSkillFrontmatter(text);
    if (!parsed) continue; // malformed -> skipped
    // SUB/WAVE rule: a missing name defaults to the folder (slug).
    map.set(entry.name, { name: parsed.name ?? entry.name, cooldownMs: parsed.cooldownMs, feed: parsed.feed });
  }
  return map;
}

// ---------------------------------------------------------------------------
// rubrique resolution (what feeds.js consumes)
// ---------------------------------------------------------------------------

// Rubric key -> skill slug. 'onthisday' and 'onthisdaymusic' share one skill:
// both are the Wikidata "na današnji dan" pipeline (the music variant only
// adds a musician filter to the SPARQL), so they share a cadence too.
const RUBRIQUE_SKILL = {
  weather: 'arso-vreme',
  news: 'rtv-novice',
  sport: 'rtv-sport',
  onthisday: 'wikidata-dan',
  onthisdaymusic: 'wikidata-dan',
};

// The code fallbacks -- feeds.js's literal defaults as they stood before the
// SKILL.md layer existed. The code default still wins over absence: a missing
// or invalid skills/ directory must keep today's behavior byte-identical.
// The Wikidata rubriques carry NO feed fallback (a SPARQL endpoint is not an
// RSS feed); the weather feed literal is kept for fidelity but feeds.js does
// NOT consume it (the ARSO reader parses station observations out of item
// titles, so it is not a generic RSS client -- documented in docs/skills.md).
const RUBRIQUE_FALLBACKS = {
  weather: {
    cooldownMs: 15 * 60_000,
    feed: 'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observation_si_latest.rss',
  },
  news: { cooldownMs: 30 * 60_000, feed: 'https://www.rtvslo.si/feeds/novice.xml' },
  sport: { cooldownMs: 30 * 60_000, feed: 'https://www.rtvslo.si/sport/rss' },
  onthisday: { cooldownMs: 6 * 60 * 60_000, feed: null },
  onthisdaymusic: { cooldownMs: 6 * 60 * 60_000, feed: null },
};

// rubriqueDefaults('news') -> { cooldownMs, feed } resolved from
// skills/rtv-novice/SKILL.md when it exists and parses, else the hardcoded
// fallback. A skill may carry only PART of the shape (e.g. cooldown without
// feed): each field falls back independently. An unknown rubrique key -> null
// (pinned: there is no such rubrique, so there are no defaults to invent).
// The optional `dir` parameter mirrors pruneArchives/cleanupOldShows's
// testability pattern -- feeds.js always calls this with the default dir.
export function rubriqueDefaults(rubriqueKey, dir = DEFAULT_SKILLS_DIR) {
  const fallback = RUBRIQUE_FALLBACKS[rubriqueKey];
  if (!fallback) return null;
  const slug = RUBRIQUE_SKILL[rubriqueKey];
  const skill = loadSkills(dir).get(slug);
  return {
    cooldownMs: skill?.cooldownMs ?? fallback.cooldownMs,
    feed: skill?.feed ?? fallback.feed,
  };
}

// Reset hook, kept for symmetry with src/lib/errorRing.js's clearErrorsForTest
// so tests have one stable seam. There is deliberately NOTHING to reset today
// (loadSkills is uncached by design, see above); if a memo is ever introduced,
// this is where it gets cleared, and the live-edit test in
// test/skills.test.mjs is the canary that will demand it.
export function resetForTest() {
  // intentionally empty -- no cache to reset (see loadSkills)
}
