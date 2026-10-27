// Tests for Val 27 "sproscen register" -- the relaxed rock register the
// default template pools now speak (the register the Markec Podkast
// persona, P5 #1, already proved on air):
//   A. anti-repetition minimums: the CORE spoken-flow pools stay fat
//      (a thin pool + hash selection is how a synthetic station repeats
//      itself -- the CADA "Thy" tell was IDENTICAL pronunciation of the
//      same line, every airing),
//   B. filler budget: at most ONE discourse marker per variant, and the
//      marker must sit right before a comma or a dash (the rime.ai
//      "sprinkle, not stack" rule; a stacked filler sounds like a bug,
//      and a filler without a prosodic anchor reads as a typo),
//   C. no parentheses anywhere in spoken text (they read as stage
//      directions, not speech -- the podcast pools already lint this),
//   D. sentence ceilings: <=18 words per sentence in the CORE flow pools
//      (open/intro/recap/beds/promos/live handoffs -- short conversational
//      sentences ARE the register), <=24 everywhere (guards against
//      future walls of text; placeholders count as one word),
//   E. (Val 28 "samo skripte brez AI modelov") the LLM register surfaces
//      are REMOVED, not patched: src/llm/, producer/moves.js and the AI
//      branch of director/liveSegments.js are gone -- live lines come from
//      the template resolver alone, so the register pins above are the ONLY
//      register that exists (the global no-AI guardrail lives in its own
//      file, test/noAiModels.test.mjs),
//   F. the shipped example config carries the relaxed Edge prosody default
//      (edgeRate "-6%", the P4 #26 knob -- pace IS naturalness),
//   G. pre-generate-clips.mjs renders through the station's pools, not a
//      hardcoded duplicate grammar (the pregenerated voice mode must
//      speak the same register as everything else).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('voice-register', {});

const { renderSlot, DEFAULT_TEMPLATES, DISCOURSE_MARKERS } = await import('../src/auto/templates.js');
const { edgeProsodyForPersona } = await import('../src/auto/edgeTts.js');

const repo = repoRoot();

// Walks DEFAULT_TEMPLATES and yields [dottedPath, variantString] pairs.
function* walk(node, prefix = '') {
  for (const [key, value] of Object.entries(node)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      for (const variant of value) yield [dotted, variant];
    } else if (value && typeof value === 'object') {
      yield* walk(value, dotted);
    }
  }
}

const allVariants = [...walk(DEFAULT_TEMPLATES)];

// ---------------------------------------------------------------------------
// A. anti-repetition minimums
// ---------------------------------------------------------------------------

const POOL_MINIMUMS = [
  ['open.default', 4],
  ['open.morning', 2],
  ['open.daytime', 2],
  ['open.evening', 2],
  ['open.night', 2],
  ['close.default', 3],
  ['close.morning', 2],
  ['close.daytime', 2],
  ['close.evening', 2],
  ['close.night', 2],
  ['intro', 5],
  ['recap.withAlbumYear', 3],
  ['recap.withYear', 3],
  ['recap.generic', 3],
  ['quizQuestion', 6],
  ['quizAnswer', 5],
  ['handoff', 3],
  ['live.time', 3],
  ['live.weather', 2],
  ['live.time-weather', 2],
  ['live.nextShow.withHost', 3],
  ['live.nextShow.noHost', 3],
  ['weatherNow.withTemp', 3],
  ['weatherNow.tempOnly', 2],
  ['weatherNow.generic', 2],
  ['newsHeadlines', 3],
  ['sportHeadlines', 3],
  ['triviaArtist', 4],
  ['triviaGeneral', 4],
  ['tease', 3],
  ['teaseQuiz', 3],
  ['teaseMid', 4],
  ['pollRunning', 3],
  ['pollResults', 3],
  ['requestShout', 4],
  ['dedicationShout', 3],
  ['promo', 4],
  ['promoHost', 4],
  ['bedWeather.withWind', 4],
  ['bedWeather.noWind', 4],
  ['bedNextShow.withHost', 4],
  ['bedNextShow.noHost', 4],
  // Val 28 A2: the station-level general clips (pregenerated mode) get the
  // same fat-pool discipline -- three hardcoded texts aired on EVERY show
  // before this.
  ['stationOpen', 4],
  ['stationClose', 4],
  ['stationHandoff', 4],
];

function poolByPath(dotted) {
  let node = DEFAULT_TEMPLATES;
  for (const part of dotted.split('.')) node = node[part];
  return node;
}

describe('A. anti-repetition minimums (fat pools)', () => {
  for (const [dotted, min] of POOL_MINIMUMS) {
    test(`${dotted}: >= ${min} variants`, () => {
      const pool = poolByPath(dotted);
      assert.ok(Array.isArray(pool), `${dotted} is not an array pool`);
      assert.ok(pool.length >= min, `${dotted}: expected >= ${min} variants, got ${pool.length}`);
      assert.ok(new Set(pool).size === pool.length, `${dotted}: duplicate variant strings`);
    });
  }
});

// ---------------------------------------------------------------------------
// B. filler budget -- at most one discourse marker per variant
// ---------------------------------------------------------------------------

const MARKER_RE = new RegExp(`\\b(?:${DISCOURSE_MARKERS.join('|')})\\b(?:\\s*--|,)`, 'g');

describe('B. filler budget (sprinkle, not stack)', () => {
  test('DISCOURSE_MARKERS is the exported, non-empty marker list', () => {
    assert.ok(Array.isArray(DISCOURSE_MARKERS) && DISCOURSE_MARKERS.length >= 4);
    for (const marker of DISCOURSE_MARKERS) assert.match(marker, /^[A-Z][a-z]+$/);
  });

  test('every variant carries at most ONE marker, anchored to a comma or dash', () => {
    for (const [dotted, variant] of allVariants) {
      const count = (variant.match(MARKER_RE) ?? []).length;
      assert.ok(count <= 1, `${dotted}: ${count} discourse markers (max 1): ${variant}`);
    }
  });

  test('the register actually sprinkles: some variants carry a marker', () => {
    const withMarker = allVariants.filter(([, v]) => (v.match(MARKER_RE) ?? []).length === 1);
    assert.ok(withMarker.length >= 4, `expected a sprinkle of filler variants, found ${withMarker.length}`);
  });

  test('marker variants are a minority (under a third of all variants)', () => {
    const withMarker = allVariants.filter(([, v]) => (v.match(MARKER_RE) ?? []).length === 1);
    assert.ok(
      withMarker.length / allVariants.length < 0.34,
      `filler density ${(withMarker.length / allVariants.length).toFixed(2)} -- sprinkle, not stack`
    );
  });
});

// ---------------------------------------------------------------------------
// C. no parentheses in spoken text
// ---------------------------------------------------------------------------

describe('C. no parentheses in spoken text', () => {
  test('no bracket of any kind survives outside {placeholders}', () => {
    for (const [dotted, variant] of allVariants) {
      const stripped = variant.replace(/\{\w+\}/g, 'X');
      assert.ok(!/[()[\]{}]/.test(stripped), `${dotted}: brackets read as stage directions: ${variant}`);
    }
  });
});

// ---------------------------------------------------------------------------
// D. sentence ceilings (short conversational sentences ARE the register)
// ---------------------------------------------------------------------------

const CORE_POOLS = new Set(POOL_MINIMUMS.map(([dotted]) => dotted));

function sentencesOf(variant) {
  return variant
    .replace(/\{\w+\}/g, ' X ')
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Words, not tokens: a lone ":" or "," between spaces is punctuation, not a
// word -- counting it inflated the ceilings and punished colon-heavy radio
// phrasing ("Vreme na {station}: ...").
function wordsOf(sentence) {
  return sentence.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

describe('D. sentence ceilings', () => {
  test('core flow pools: every sentence <= 18 words', () => {
    for (const [dotted, variant] of allVariants) {
      if (!CORE_POOLS.has(dotted)) continue;
      for (const sentence of sentencesOf(variant)) {
        const words = wordsOf(sentence);
        assert.ok(
          words <= 18,
          `${dotted}: sentence runs ${words} words (core ceiling 18): "${sentence}"`
        );
      }
    }
  });

  test('every pool: every sentence <= 24 words', () => {
    for (const [dotted, variant] of allVariants) {
      for (const sentence of sentencesOf(variant)) {
        const words = wordsOf(sentence);
        assert.ok(words <= 24, `${dotted}: sentence runs ${words} words (hard ceiling 24): "${sentence}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// E. (Val 28) the LLM register surfaces are REMOVED, not patched
// ---------------------------------------------------------------------------

describe('E. LLM surfaces removed (samo skripte brez AI modelov)', () => {
  test('liveSegments.js delegates straight to the template resolver -- no llm/ import, no model call', () => {
    const live = fs.readFileSync(path.join(repo, 'src', 'director', 'liveSegments.js'), 'utf8');
    assert.ok(!live.includes('llm/'), 'no llm/ import may remain in the live path');
    assert.ok(!live.includes('complete('), 'no model completion call may remain');
    assert.match(live, /resolveLiveLineAuto/, 'the template resolver is the only path');
  });

  test('producer/moves.js (the LLM move generator) no longer exists', () => {
    assert.ok(!fs.existsSync(path.join(repo, 'src', 'producer', 'moves.js')), 'moves.js must be gone');
    assert.ok(!fs.existsSync(path.join(repo, 'src', 'llm')), 'the src/llm/ module must be gone');
  });
});

// ---------------------------------------------------------------------------
// F. shipped example config: the relaxed Edge prosody default
// ---------------------------------------------------------------------------

describe('F. example config relaxed prosody', () => {
  test('config.example.json ships voice.edgeRate = "-6%"', () => {
    const example = JSON.parse(fs.readFileSync(path.join(repo, 'config.example.json'), 'utf8'));
    assert.equal(example.autoRadio?.voice?.edgeRate, '-6%');
    assert.equal(example.autoRadio?.voice?.edgeVoice, 'sl-SI-RokNeural');
  });

  test('edgeProsodyForPersona passes set keys through, empty config stays empty', () => {
    // fixtures config has no prosody keys -> empty prosody (the P4 #26
    // contract: only keys actually set are sent)
    assert.equal(edgeProsodyForPersona('nobody'), undefined);
  });
});

// ---------------------------------------------------------------------------
// G. pre-generate-clips.mjs renders through the station pools
// ---------------------------------------------------------------------------

describe('G. pregenerated track clips speak the station grammar', () => {
  test('pre-generate-clips.mjs routes intro/recap through renderSlot', () => {
    const src = fs.readFileSync(path.join(repo, 'pre-generate-clips.mjs'), 'utf8');
    assert.match(src, /renderSlot\('intro'/, 'intro clips render through the pools');
    assert.match(src, /renderSlot\('recap'/, 'recap clips render through the pools');
    assert.ok(
      !src.includes('`Sledi ${title} izvajalca ${artist}`'),
      'the hardcoded intro duplicate grammar must be gone'
    );
    assert.ok(
      !src.includes('`To je bila skladba ${title} izvajalca ${artist}`'),
      'the hardcoded recap duplicate grammar must be gone'
    );
  });

  // Val 28 A2: the three station-level general clips render through the
  // station pools with a date-seeded rotation + sidecar, instead of three
  // hardcoded texts that aired verbatim on every show.
  test('Val 28 A2: general clips render through stationOpen/stationClose/stationHandoff', () => {
    const src = fs.readFileSync(path.join(repo, 'pre-generate-clips.mjs'), 'utf8');
    assert.match(src, /slot:\s*'stationOpen'/, 'open general clip uses the stationOpen pool');
    assert.match(src, /slot:\s*'stationClose'/, 'close general clip uses the stationClose pool');
    assert.match(src, /slot:\s*'stationHandoff'/, 'handoff general clip uses the stationHandoff pool');
    assert.ok(
      !src.includes("text: 'Dobrodo\u0161li na Radio Markec. U\u017eivajte v glasbi.'"),
      'the hardcoded general texts must be gone (variant 1 of the pool keeps the old wording)'
    );
    // Date-seeded rotation + sidecar contract: same-day re-run is a no-op.
    assert.match(src, /general\|\$\{clip\.name\}\|\$\{generalDateKey\}/, 'seed carries the local date');
    assert.match(src, /\.txt/, 'sidecar .txt remembers what the wav speaks');
  });

  test('renderSlot still renders deterministically for a fixed seed', () => {
    const a = renderSlot('intro', { values: { artist: 'A', title: 'T' }, seed: 'det' });
    const b = renderSlot('intro', { values: { artist: 'A', title: 'T' }, seed: 'det' });
    assert.equal(a, b);
    assert.ok(!a.includes('{') && !a.includes('undefined'));
  });

  test('Val 28 A2: station pools render fully substituted and stay deterministic', () => {
    for (const slot of ['stationOpen', 'stationClose', 'stationHandoff']) {
      const a = renderSlot(slot, { values: { station: 'Radio Markec' }, seed: 'same-day' });
      const b = renderSlot(slot, { values: { station: 'Radio Markec' }, seed: 'same-day' });
      assert.equal(a, b);
      assert.ok(!a.includes('{') && !a.includes('undefined'), `${slot} fully substituted`);
    }
    // stationOpen names the station in every variant; the close/handoff pools
    // legitimately keep station-less variants (the old fixed texts survive as
    // variant 1 -- register continuity, not regression).
    for (let i = 0; i < 8; i++) {
      const open = renderSlot('stationOpen', { values: { station: 'Radio Markec' }, seed: `probe-${i}` });
      assert.ok(open.includes('Radio Markec'), 'every stationOpen variant names the station');
    }
  });
});
