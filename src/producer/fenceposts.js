// Val 28 C1: fencepost variety -- the deterministic talk map both script
// builders share. Every show used to talk at EVERY fencepost (intro before
// each track, recap after each track, always) -- the most audible sequencing
// robotism the station had: a real rock DJ lets two songs run back-to-back
// sometimes, and "every talk break has a task" (researched show-prep
// practice) means not every boundary owes the mic anything.
//
// The map is a pure function of (seed, trackCount, hasQuiz, hasWeather):
//   - silent boundaries: roughly 1 in 4 boundaries (a deterministic ~30%
//     per-boundary coin, floored at one and capped at ~1/3) drop BOTH the
//     recap before them and the intro after them -- a genuine back-to-back
//     pair, chosen deterministically from the seed (same show + same date
//     -> the same map; a regenerated script never disagrees with its own
//     cached audio). Trivia sprinkles are NOT gated: a fact about the artist
//     straight into the song is a natural break in its own right, and the
//     P4 #17 cadence (every 3rd track) stays intact;
//   - protected boundaries: the quiz pair (the reveal boundary and the
//     question boundary) and the weather-handoff boundary are NEVER silent
//     -- those are promises the script makes (a quiz question must meet its
//     reveal, the handoff must precede the weather it promises);
//   - no two adjacent silent boundaries (three tracks without a word is a
//     different station);
//   - midTeaseIndex: shows with >= 6 tracks get ONE mid-show tease (at the
//     quiz position when a quiz exists, else the halfway track) -- the
//     top-of-show tease alone left the second half un-teased.
//
// Consumed by src/auto/scriptBuilder.js (templates) -- since Val 28 the
// only script builder; its former AI twin consumed the same map before the
// AI layer was removed, which is why the quiz/weather placement math is
// shared shape, not a copy.
const SILENT_COIN_PERCENT = 30;

export function decideFenceposts({ seed, trackCount, hasQuiz = false, hasWeather = false }) {
  const n = Math.max(0, Math.trunc(trackCount));
  const silentBoundaries = new Set();
  let midTeaseIndex = null;
  // Short shows (<= 3 tracks) stay dense: there is no room to skip a
  // boundary without the show feeling like a jukebox with commentary.
  if (n < 4) return { silentBoundaries, midTeaseIndex };

  const quizIndex = hasQuiz ? Math.floor(n / 2) : -1;
  const weatherAfterIndex = hasWeather ? Math.floor((n * 2) / 3) : -1;
  const protectedSet = new Set();
  if (hasQuiz) {
    protectedSet.add(quizIndex); // the reveal boundary (dropping it loses the answer)
    if (quizIndex - 1 >= 0) protectedSet.add(quizIndex - 1); // the question boundary
  }
  if (weatherAfterIndex >= 0 && weatherAfterIndex <= n - 1) {
    protectedSet.add(weatherAfterIndex); // the handoff boundary (recap must meet its weather)
  }

  const eligible = [];
  for (let b = 0; b <= n - 1; b += 1) {
    if (!protectedSet.has(b)) eligible.push(b);
  }

  // A deterministic per-boundary coin (~30%): the expected density lands at
  // the ~1-in-4 target while the SHAPE varies freely seed to seed -- a
  // strided walk from one offset would collapse onto a handful of shapes
  // (measured: 24 seeds of a 12-track show drew just 4 distinct maps).
  const picked = [];
  for (const b of eligible) {
    if (fnv1a(`${seed}|${b}`) % 100 < SILENT_COIN_PERCENT) picked.push(b);
  }
  // Adjacency sweep in index order: no two neighboring boundaries silent.
  const nonAdjacent = [];
  for (const b of picked) {
    if (!nonAdjacent.some((s) => Math.abs(s - b) <= 1)) nonAdjacent.push(b);
  }
  // Density floor: every show with >= 4 tracks gets at least one pair.
  if (nonAdjacent.length === 0 && eligible.length > 0) {
    nonAdjacent.push(eligible[fnv1a(`${seed}|first`) % eligible.length]);
  }
  // Density cap (the jukebox guard): at most ~1/3 of boundaries silent.
  const cap = Math.ceil(n / 3);
  for (const b of nonAdjacent.slice(0, cap)) silentBoundaries.add(b);

  if (n >= 6) {
    const idx = hasQuiz ? quizIndex : Math.floor(n / 2);
    // Never collide with the top-of-show tease (which sits before track 0):
    // a mid tease at index < 2 would stack two teases within one breath.
    if (idx >= 2 && idx <= n - 1) midTeaseIndex = idx;
  }
  return { silentBoundaries, midTeaseIndex };
}

// FNV-1a, the same hash templates.js's variant selection uses -- duplicated
// here (not imported) because templates.js keeps it module-private by design;
// the values are identical and both are pinned by their own tests.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
