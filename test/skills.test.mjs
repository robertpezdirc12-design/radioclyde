// Tests for P7 "rubrike kot skilli" (the SKILL.md rubrique format, stolen
// from SUB/WAVE's skills drop-in):
//   A. parseSkillFrontmatter -- the restricted line-based frontmatter grammar
//      (SUB/WAVE's documented legacy fallback parser): valid multi-key,
//      quoted values, BOM, duplicate-key-last-wins, unknown keys ignored,
//      cron accepted-but-reserved, missing closing fence -> null, empty
//      frontmatter -> null (PINNED: a SKILL.md that says nothing is not a
//      skill; the code fallback wins),
//   B. parseCooldown -- '45m'/'2h'/'90s'/bare-number-=-SECONDS (a documented
//      deviation from SUB/WAVE, where bare meant minutes)/'0m' allowed
//      (PINNED: 0 disables the in-process cache)/junk -> null,
//   C. SLUG_RE -- SUB/WAVE's slug rule verbatim,
//   D. loadSkills -- temp skills dirs (map shape, malformed skipped,
//      non-matching dirs ignored, missing dir -> empty, LIVE EDITS seen by
//      the next call: the loader is deliberately uncached),
//   E. the REAL repo skills/ dir -- the byte-identical-default contract as
//      an executable assertion: all four slugs load with exactly today's
//      feeds.js literals (15m / 30m / 30m / 6h) and the same feed URLs,
//   F. rubriqueDefaults -- fallbacks when the skill layer is absent,
//      partial skills, temp-dir override, unknown key -> null (PINNED),
//   G. feeds.js end-to-end wiring -- stubbed fetch only, ZERO network: the
//      default resolution fetches the exact shipped URL, a non-RSS feed
//      degrades honestly to null (-> offline line upstream), the SKILL.md
//      cooldown drives the default TTL, and an explicit ttlMs still wins.
//
// G's last two tests TEMPORARILY rewrite skills/rtv-novice/SKILL.md (this
// file's own asset) and restore it in a finally + a process-exit hook; the
// restored bytes are re-asserted after every restore.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('skills', {});

const { parseSkillFrontmatter, parseCooldown, SLUG_RE, loadSkills, rubriqueDefaults, resetForTest } = await import(
  '../src/auto/skills.js'
);
const { fetchNewsHeadlines } = await import('../src/auto/feeds.js');

// --- fixtures -----------------------------------------------------------------

const REAL_SKILLS_DIR = path.join(repoRoot(), 'skills');
const RTV_NOVICE_PATH = path.join(REAL_SKILLS_DIR, 'rtv-novice', 'SKILL.md');

// Today's feeds.js literals, frozen here as the byte-identical-default
// contract: out of the box the SKILL.md layer must resolve to EXACTLY what
// the hardcoded defaults were before the feature existed.
const TODAY_LITERALS = {
  weather: { cooldownMs: 15 * 60_000, feed: 'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observation_si_latest.rss' },
  news: { cooldownMs: 30 * 60_000, feed: 'https://www.rtvslo.si/feeds/novice.xml' },
  sport: { cooldownMs: 30 * 60_000, feed: 'https://www.rtvslo.si/sport/rss' },
  onthisday: { cooldownMs: 6 * 60 * 60_000, feed: null },
  onthisdaymusic: { cooldownMs: 6 * 60 * 60_000, feed: null },
};

// A scratch skills root under this test file's dataDir (gitignored via
// data/) -- every test that needs one builds it fresh.
function freshSkillsDir(name) {
  const dir = path.join(repoRoot(), 'data', 'test-skills', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(dir, slug, content) {
  fs.mkdirSync(path.join(dir, slug), { recursive: true });
  fs.writeFileSync(path.join(dir, slug, 'SKILL.md'), content);
}

const skillFile = (frontmatter, body = 'Proza za operaterja.') => `---\n${frontmatter}\n---\n${body}\n`;

const rssFor = (titles) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>${titles
    .map((t) => `<item><title>${t}</title></item>`)
    .join('')}</channel></rss>`;

// Zero-network fetch stub (the honestOffline/weatherOffline pattern).
function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Belt-and-braces restore for the rtv-novice mutation tests: a -9 kill is
// out of reach, but any exit path that skipped the finally still puts the
// shipped bytes back.
let rtvNoviceOriginal = null;
process.on('exit', () => {
  if (rtvNoviceOriginal != null) {
    try {
      fs.writeFileSync(RTV_NOVICE_PATH, rtvNoviceOriginal);
    } catch {
      /* best effort */
    }
  }
});

// --- A. parseSkillFrontmatter --------------------------------------------------

describe('parseSkillFrontmatter (the restricted SUB/WAVE grammar)', () => {
  test('valid multi-key frontmatter parses name/cooldown/feed', () => {
    const parsed = parseSkillFrontmatter(
      skillFile('name: ARSO vreme\ncooldown: 15m\nfeed: https://meteo.arso.gov.si/example.rss')
    );
    assert.deepEqual(parsed, {
      name: 'ARSO vreme',
      cooldownMs: 900000,
      feed: 'https://meteo.arso.gov.si/example.rss',
      cron: undefined,
    });
  });

  test('values may be double- or single-quoted (matching pair stripped)', () => {
    const parsed = parseSkillFrontmatter(
      skillFile(`name: "RTV šport"\ncooldown: '30m'\nfeed: "https://example.si/feed.xml"`)
    );
    assert.equal(parsed.name, 'RTV šport');
    assert.equal(parsed.cooldownMs, 1800000);
    assert.equal(parsed.feed, 'https://example.si/feed.xml');
  });

  test('a UTF-8 BOM is stripped, not fatal', () => {
    const parsed = parseSkillFrontmatter(`\uFEFF${skillFile('name: RTV novice\ncooldown: 30m')}`);
    assert.equal(parsed.name, 'RTV novice');
    assert.equal(parsed.cooldownMs, 1800000);
  });

  test('duplicate keys: the LAST one wins', () => {
    const parsed = parseSkillFrontmatter(skillFile('cooldown: 15m\ncooldown: 2h'));
    assert.equal(parsed.cooldownMs, 7200000);
  });

  test('missing closing --- -> null (the file is ignored, never a crash)', () => {
    assert.equal(parseSkillFrontmatter('---\nname: ARSO vreme\ncooldown: 15m\n'), null);
    assert.equal(parseSkillFrontmatter('name: ARSO vreme\ncooldown: 15m\n---\n'), null);
  });

  test('empty frontmatter -> null (PINNED: a SKILL.md that says nothing is not a skill)', () => {
    assert.equal(parseSkillFrontmatter('---\n---\nProza.\n'), null);
    assert.equal(parseSkillFrontmatter('---\n\n---\nProza.\n'), null);
    // comments and blank lines carry no keys either -> still empty -> null
    assert.equal(parseSkillFrontmatter('---\n# samo komentar\n\n---\nProza.\n'), null);
  });

  test('unknown keys are ignored (forward-compat), known keys still parsed', () => {
    const parsed = parseSkillFrontmatter(
      skillFile('label: Vreme\nname: Vreme\ncooldown: 15m\ntags: late-night, factual\nfeed: http://example.si/vreme.rss\nfeedMaxItems: 10')
    );
    assert.equal(parsed.name, 'Vreme');
    assert.equal(parsed.cooldownMs, 900000);
    assert.equal(parsed.feed, 'http://example.si/vreme.rss');
    assert.equal(parsed.cron, undefined);
  });

  test('cron is ACCEPTED and returned but RESERVED (radioclyde airs by station.json)', () => {
    const parsed = parseSkillFrontmatter(skillFile('name: Wikidata dan\ncooldown: 6h\ncron: 0 */2 * * *'));
    assert.equal(parsed.cron, '0 */2 * * *');
    // and the loader-level contract: cron never reaches the loaded shape
    const dir = freshSkillsDir('cron-reserved');
    writeSkill(dir, 'cron-skill', skillFile('name: Kronska rubrika\ncooldown: 6h\ncron: 0 */2 * * *'));
    const loaded = loadSkills(dir).get('cron-skill');
    assert.deepEqual(Object.keys(loaded).sort(), ['cooldownMs', 'feed', 'name']);
  });

  test('invalid values drop the key, they never fail the whole file', () => {
    const parsed = parseSkillFrontmatter(
      skillFile(`name: ${'x'.repeat(61)}\ncooldown: kadarkoli\nfeed: ni-url`)
    );
    assert.equal(parsed.name, undefined); // > 60 chars -> dropped
    assert.equal(parsed.cooldownMs, null); // junk -> null (fallback wins downstream)
    assert.equal(parsed.feed, undefined); // not an http(s) URL -> dropped
  });

  test('a value may itself contain colons (split on the FIRST colon only)', () => {
    const parsed = parseSkillFrontmatter(skillFile('name: "Novice: RTV"\ncooldown: 30m'));
    assert.equal(parsed.name, 'Novice: RTV');
  });
});

// --- B. parseCooldown ----------------------------------------------------------

describe('parseCooldown', () => {
  test('the duration literal table', () => {
    assert.equal(parseCooldown('15m'), 900000);
    assert.equal(parseCooldown('45m'), 2700000);
    assert.equal(parseCooldown('2h'), 7200000);
    assert.equal(parseCooldown('90s'), 90000);
  });

  test("a bare number means SECONDS ('45' -> 45000) -- documented deviation from SUB/WAVE (bare = minutes there)", () => {
    assert.equal(parseCooldown('45'), 45000);
    assert.equal(parseCooldown('0'), 0);
  });

  test("'0m' -> 0 is ALLOWED (PINNED: it disables the in-process cache -- honest, the operator asked for it)", () => {
    assert.equal(parseCooldown('0m'), 0);
    assert.equal(parseCooldown('0h'), 0);
  });

  test('surrounding whitespace is trimmed', () => {
    assert.equal(parseCooldown(' 45m '), 2700000);
    assert.equal(parseCooldown('\t2h\n'), 7200000);
  });

  test('junk -> null (never a guess about what the operator meant)', () => {
    assert.equal(parseCooldown('abc'), null);
    assert.equal(parseCooldown(''), null);
    assert.equal(parseCooldown('-5m'), null);
    assert.equal(parseCooldown('2d'), null); // no day unit in the restricted grammar
    assert.equal(parseCooldown('4m30s'), null);
    assert.equal(parseCooldown('m'), null);
    assert.equal(parseCooldown(undefined), null);
    assert.equal(parseCooldown(45), null); // numbers are not a valid literal
  });
});

// --- C. SLUG_RE ----------------------------------------------------------------

describe('SLUG_RE (SUB/WAVE verbatim)', () => {
  test('valid slugs', () => {
    for (const slug of ['a', 'arso-vreme', 'rtv-novice', 'wikidata-dan', 'x-123', 'a'.repeat(49)]) {
      assert.ok(SLUG_RE.test(slug), `${slug} must match`);
    }
  });

  test('invalid slugs', () => {
    for (const slug of ['', '-abc', 'ABC', 'a_b', 'a.b', 'a b', 'a/b', 'šport', 'a'.repeat(50)]) {
      assert.ok(!SLUG_RE.test(slug), `${slug} must NOT match`);
    }
  });
});

// --- D. loadSkills (temp dirs) -------------------------------------------------

describe('loadSkills against temp skills dirs', () => {
  test('loads a valid skill with the {name, cooldownMs, feed} shape', () => {
    const dir = freshSkillsDir('basic');
    writeSkill(dir, 'moja-rubrika', skillFile('name: Moja rubrika\ncooldown: 45m\nfeed: https://example.si/f.rss'));
    const map = loadSkills(dir);
    assert.equal(map.size, 1);
    assert.deepEqual(map.get('moja-rubrika'), {
      name: 'Moja rubrika',
      cooldownMs: 2700000,
      feed: 'https://example.si/f.rss',
    });
  });

  test('a missing name defaults to the folder (SUB/WAVE rule)', () => {
    const dir = freshSkillsDir('no-name');
    writeSkill(dir, 'imena-ni', skillFile('cooldown: 15m'));
    assert.equal(loadSkills(dir).get('imena-ni').name, 'imena-ni');
  });

  test('a malformed SKILL.md is skipped, its valid sibling still loads', () => {
    const dir = freshSkillsDir('mixed');
    writeSkill(dir, 'pokvarjena', '---\nname: Pokvarjena\ncooldown: 15m\n'); // no closing fence
    writeSkill(dir, 'dobra', skillFile('name: Dobra\ncooldown: 30m'));
    const map = loadSkills(dir);
    assert.equal(map.size, 1);
    assert.ok(map.has('dobra'));
    assert.ok(!map.has('pokvarjena'));
  });

  test('non-matching directory names are ignored', () => {
    const dir = freshSkillsDir('slugs');
    writeSkill(dir, 'Velike-Crke', skillFile('name: A\ncooldown: 1m'));
    writeSkill(dir, 'podcrtaj_prvi', skillFile('name: B\ncooldown: 1m'));
    writeSkill(dir, '-vodi', skillFile('name: C\ncooldown: 1m'));
    writeSkill(dir, 'dobra-rubrika', skillFile('name: D\ncooldown: 1m'));
    const map = loadSkills(dir);
    assert.deepEqual([...map.keys()], ['dobra-rubrika']);
  });

  test('a missing dir yields an empty Map (honest, never a crash)', () => {
    const map = loadSkills(path.join(repoRoot(), 'data', 'test-skills', 'ne-obstaja'));
    assert.equal(map.size, 0);
  });

  test('slug-named FILES and dirs without SKILL.md contribute nothing', () => {
    const dir = freshSkillsDir('shapes');
    fs.writeFileSync(path.join(dir, 'ni-mapa'), 'skillFile-like content'); // a file, not a dir
    fs.mkdirSync(path.join(dir, 'brez-skill-md'), { recursive: true }); // dir without SKILL.md
    writeSkill(dir, 'prava', skillFile('name: Prava\ncooldown: 1m'));
    const map = loadSkills(dir);
    assert.deepEqual([...map.keys()], ['prava']);
  });

  test('LIVE EDITS: an edited SKILL.md is seen by the next loadSkills call (no per-process cache -- PINNED)', () => {
    const dir = freshSkillsDir('live-edit');
    const file = path.join(dir, 'urejena', 'SKILL.md');
    writeSkill(dir, 'urejena', skillFile('name: Urejena\ncooldown: 15m'));
    assert.equal(loadSkills(dir).get('urejena').cooldownMs, 900000);
    fs.writeFileSync(file, skillFile('name: Urejena\ncooldown: 2h'));
    assert.equal(loadSkills(dir).get('urejena').cooldownMs, 7200000);
    fs.rmSync(path.join(dir, 'urejena'), { recursive: true, force: true });
    assert.equal(loadSkills(dir).size, 0);
  });

  test("resetForTest() is exported and callable (stable seam -- deliberately a no-op while there's no cache)", () => {
    assert.equal(typeof resetForTest, 'function');
    resetForTest(); // must not throw
  });
});

// --- E. the real repo skills/ dir (byte-identical-default contract) -------------

describe('the REAL repo skills/ dir: shipped defaults equal the old feeds.js literals', () => {
  test('all four slugs load with today\'s exact cooldowns (15m / 30m / 30m / 6h)', () => {
    const map = loadSkills(REAL_SKILLS_DIR);
    assert.deepEqual([...map.keys()].sort(), ['arso-vreme', 'rtv-novice', 'rtv-sport', 'wikidata-dan']);
    assert.equal(map.get('arso-vreme').cooldownMs, TODAY_LITERALS.weather.cooldownMs);
    assert.equal(map.get('rtv-novice').cooldownMs, TODAY_LITERALS.news.cooldownMs);
    assert.equal(map.get('rtv-sport').cooldownMs, TODAY_LITERALS.sport.cooldownMs);
    assert.equal(map.get('wikidata-dan').cooldownMs, TODAY_LITERALS.onthisday.cooldownMs);
  });

  test('feed URLs equal the old constants; wikidata-dan carries NO feed key', () => {
    const map = loadSkills(REAL_SKILLS_DIR);
    assert.equal(map.get('arso-vreme').feed, TODAY_LITERALS.weather.feed);
    assert.equal(map.get('rtv-novice').feed, TODAY_LITERALS.news.feed);
    assert.equal(map.get('rtv-sport').feed, TODAY_LITERALS.sport.feed);
    assert.equal(map.get('wikidata-dan').feed, undefined); // SPARQL is not an RSS feed
  });

  test('rubriqueDefaults (default dir) resolves every rubric key to the old literals', () => {
    for (const [key, literal] of Object.entries(TODAY_LITERALS)) {
      assert.deepEqual(rubriqueDefaults(key), { cooldownMs: literal.cooldownMs, feed: literal.feed }, key);
    }
  });

  test('feeds.js wires every rubric key through rubriqueDefaults (source-level pin, getTemplates precedent)', () => {
    const src = fs.readFileSync(path.join(repoRoot(), 'src', 'auto', 'feeds.js'), 'utf8');
    for (const key of ['weather', 'news', 'sport', 'onthisday', 'onthisdaymusic']) {
      assert.ok(src.includes(`rubriqueDefaults('${key}')`), `feeds.js must resolve '${key}' via rubriqueDefaults`);
    }
    // no fetcher may keep a hardcoded destructuring TTL default anymore
    assert.ok(!/ttlMs\s*=\s*\d/.test(src), 'a hardcoded ttlMs default survived the skills wiring');
    // the generic RSS readers keep the old URL constants as their ?? fallbacks
    assert.ok(src.includes('defaults.feed ?? RTV_NEWS_RSS'), 'news feed fallback must stay the RTV constant');
    assert.ok(src.includes('defaults.feed ?? RTV_SPORT_RSS'), 'sport feed fallback must stay the RTV constant');
  });
});

// --- F. rubriqueDefaults -------------------------------------------------------

describe('rubriqueDefaults (resolution + fallbacks)', () => {
  test('unknown rubrique key -> null (PINNED: no such rubrique, no defaults to invent)', () => {
    assert.equal(rubriqueDefaults('trivia'), null);
    assert.equal(rubriqueDefaults('kviz'), null);
    assert.equal(rubriqueDefaults(''), null);
    assert.equal(rubriqueDefaults(undefined), null);
  });

  test('a missing skills dir -> the hardcoded fallbacks (the code default still wins over absence)', () => {
    const dir = path.join(repoRoot(), 'data', 'test-skills', 'prazno-ne-obstaja');
    for (const [key, literal] of Object.entries(TODAY_LITERALS)) {
      assert.deepEqual(rubriqueDefaults(key, dir), { cooldownMs: literal.cooldownMs, feed: literal.feed }, key);
    }
  });

  test('a temp skills dir overrides cooldown and feed for its rubric key', () => {
    const dir = freshSkillsDir('override');
    writeSkill(dir, 'rtv-novice', skillFile('name: RTV novice\ncooldown: 45m\nfeed: https://example.si/novice.xml'));
    writeSkill(dir, 'arso-vreme', skillFile('name: ARSO vreme\ncooldown: 90s'));
    assert.deepEqual(rubriqueDefaults('news', dir), { cooldownMs: 2700000, feed: 'https://example.si/novice.xml' });
    // a skill without a feed key falls back PER FIELD (cooldown from file, feed from code)
    assert.deepEqual(rubriqueDefaults('weather', dir), {
      cooldownMs: 90000,
      feed: TODAY_LITERALS.weather.feed,
    });
  });

  test('a junk cooldown in the skill falls back to the code literal (never a guess)', () => {
    const dir = freshSkillsDir('junk-cooldown');
    writeSkill(dir, 'rtv-novice', skillFile('name: RTV novice\ncooldown: kadarkoli'));
    assert.deepEqual(rubriqueDefaults('news', dir), { cooldownMs: TODAY_LITERALS.news.cooldownMs, feed: TODAY_LITERALS.news.feed });
  });

  test('onthisday and onthisdaymusic share the wikidata-dan skill', () => {
    const dir = freshSkillsDir('shared');
    writeSkill(dir, 'wikidata-dan', skillFile('name: Wikidata dan\ncooldown: 2h'));
    assert.deepEqual(rubriqueDefaults('onthisday', dir), { cooldownMs: 7200000, feed: null });
    assert.deepEqual(rubriqueDefaults('onthisdaymusic', dir), { cooldownMs: 7200000, feed: null });
  });
});

// --- G. feeds.js end-to-end wiring (stubbed fetch, ZERO network) ----------------

describe('feeds.js wiring (zero network: globalThis.fetch stubbed)', () => {
  test('default resolution fetches the exact shipped RTV novice URL (byte-identical at the HTTP layer)', async () => {
    const { calls, restore } = stubFetch(() => ({ ok: true, text: async () => rssFor(['Prva naslovnica', 'Druga naslovnica']) }));
    try {
      const value = await fetchNewsHeadlines(); // no ttlMs, no limit: the default resolution path
      assert.equal(value.source, 'rtv');
      assert.equal(value.count, 2);
      assert.ok(value.headlines.includes('Prva naslovnica'));
      assert.deepEqual(calls, ['https://www.rtvslo.si/feeds/novice.xml']);
    } finally {
      restore();
    }
  });

  test('a non-RSS feed degrades honestly: null (-> offline line upstream), never invented headlines', async () => {
    const { calls, restore } = stubFetch(() => ({ ok: true, text: async () => '<html><body>to ni RSS</body></html>' }));
    try {
      const value = await fetchNewsHeadlines({ limit: 7 }); // fresh cache key for this test
      assert.equal(value, null);
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  test('the SKILL.md cooldown drives the default TTL end-to-end (rtv-novice temporarily set to 1s)', async () => {
    const original = fs.readFileSync(RTV_NOVICE_PATH, 'utf8');
    rtvNoviceOriginal = original; // exit-hook safety net until the finally runs
    try {
      fs.writeFileSync(RTV_NOVICE_PATH, original.replace('cooldown: 30m', 'cooldown: 1s'));
      const { calls, restore } = stubFetch(() => ({ ok: true, text: async () => rssFor(['Naslovnica']) }));
      try {
        await fetchNewsHeadlines({ limit: 2 }); // no ttlMs -> the skill's 1s must apply
        await sleep(1150); // safely past the 1s cooldown
        await fetchNewsHeadlines({ limit: 2 });
        assert.equal(calls.length, 2, 'a 1s SKILL.md cooldown must expire the cache between the calls (30m would not)');
      } finally {
        restore();
      }
    } finally {
      fs.writeFileSync(RTV_NOVICE_PATH, original);
      rtvNoviceOriginal = null;
      assert.equal(fs.readFileSync(RTV_NOVICE_PATH, 'utf8'), original, 'the shipped SKILL.md must be restored byte-identically');
    }
  });

  test('an EXPLICIT ttlMs still beats the SKILL.md cooldown (param > skill > code literal)', async () => {
    const original = fs.readFileSync(RTV_NOVICE_PATH, 'utf8');
    rtvNoviceOriginal = original; // exit-hook safety net until the finally runs
    try {
      fs.writeFileSync(RTV_NOVICE_PATH, original.replace('cooldown: 30m', 'cooldown: 1s'));
      const { calls, restore } = stubFetch(() => ({ ok: true, text: async () => rssFor(['Naslovnica']) }));
      try {
        await fetchNewsHeadlines({ limit: 5, ttlMs: 60_000 }); // explicit beats the skill's 1s
        await sleep(1150);
        await fetchNewsHeadlines({ limit: 5, ttlMs: 60_000 });
        assert.equal(calls.length, 1, 'the explicit 60s TTL must win over the 1s SKILL.md cooldown');
      } finally {
        restore();
      }
    } finally {
      fs.writeFileSync(RTV_NOVICE_PATH, original);
      rtvNoviceOriginal = null;
      assert.equal(fs.readFileSync(RTV_NOVICE_PATH, 'utf8'), original, 'the shipped SKILL.md must be restored byte-identically');
    }
  });
});
