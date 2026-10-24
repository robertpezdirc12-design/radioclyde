// Tests for P4 #22 ("Kviz" rubric) -- real question/answer content for the
// pre-existing quiz position:
//
//   A. the quiz corpus itself (integrity, uniqueness, no giveaway answers,
//      chronological order),
//   B. pickQuizQuestions (deterministic rotation, count semantics,
//      usedPrompts skip),
//   C. rubric keywords (briefQuery): "kviz"/"quiz" -> 'quiz',
//   D. collectRubricData: quiz present (incl. OFFLINE -- the corpus is the
//      one rubric that works with zero network), absent when not requested,
//   E. template rendering (quizQuestion / quizAnswer),
//   F. segment placement in buildSegmentsAuto: real content at the middle
//      track, legacy year-guess fallback without quiz data, no quiz position
//      without the brief's quiz segment.
//
// No real network anywhere: the same no-ffmpeg-no-network rule as the rest
// of the suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('quiz', {});

const { QUIZ_QUESTIONS, pickQuizQuestions } = await import('../src/auto/quizFacts.js');
const { parseBriefRubrics } = await import('../src/auto/briefQuery.js');
const { collectRubricData, rubricSettings } = await import('../src/auto/feeds.js');
const { renderSlot } = await import('../src/auto/templates.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');

// ---------------------------------------------------------------------------
// A. corpus integrity
// ---------------------------------------------------------------------------

describe('quiz corpus integrity (P4 #22)', () => {
  test('non-trivial corpus size', () => {
    assert.ok(QUIZ_QUESTIONS.length >= 20, `expected >= 20 questions, got ${QUIZ_QUESTIONS.length}`);
  });

  test('prompts are questions, unique, placeholder-free', () => {
    const seen = new Set();
    for (const item of QUIZ_QUESTIONS) {
      assert.ok(typeof item.prompt === 'string' && item.prompt.length >= 15, `prompt too short: ${item.prompt}`);
      assert.ok(item.prompt.endsWith('?'), `prompt must end with '?': ${item.prompt}`);
      assert.ok(!item.prompt.includes('{'), `prompt carries a placeholder: ${item.prompt}`);
      assert.ok(!seen.has(item.prompt), 'duplicate prompt in quiz corpus');
      seen.add(item.prompt);
    }
  });

  test('answers are short, clean and NOT given away by the prompt', () => {
    for (const item of QUIZ_QUESTIONS) {
      assert.ok(typeof item.answer === 'string' && item.answer.length > 0, `empty answer for: ${item.prompt}`);
      assert.ok(item.answer.length <= 60, `answer too long for one breath: ${item.answer}`);
      assert.ok(!item.answer.endsWith('.'), `answer must not carry the final period: ${item.answer}`);
      assert.ok(!item.answer.includes('?'), `answer must not be a question: ${item.answer}`);
      assert.ok(!item.answer.includes('{'), `answer carries a placeholder: ${item.answer}`);
      assert.ok(!item.prompt.toLowerCase().includes(item.answer.toLowerCase()), `giveaway: "${item.answer}" is inside the prompt: ${item.prompt}`);
    }
  });

  test('entries stay sorted by anchor year (chronological rotation)', () => {
    for (let i = 1; i < QUIZ_QUESTIONS.length; i++) {
      assert.ok(
        QUIZ_QUESTIONS[i - 1].year <= QUIZ_QUESTIONS[i].year,
        `year order broken at index ${i}: ${QUIZ_QUESTIONS[i - 1].year} > ${QUIZ_QUESTIONS[i].year}`
      );
      assert.ok(Number.isInteger(QUIZ_QUESTIONS[i].year) && QUIZ_QUESTIONS[i].year > 1900 && QUIZ_QUESTIONS[i].year <= 2100);
    }
  });
});

// ---------------------------------------------------------------------------
// B. pickQuizQuestions
// ---------------------------------------------------------------------------

describe('pickQuizQuestions rotation', () => {
  test('same seed -> same question (reproducible transcripts)', () => {
    const a = pickQuizQuestions(1, 'kvizshow|2026-10-24');
    const b = pickQuizQuestions(1, 'kvizshow|2026-10-24');
    assert.deepEqual(a, b);
    assert.equal(a.length, 1);
  });

  test('different seeds rotate across rock history (>= 12 distinct over 60 days)', () => {
    const distinct = new Set();
    for (let day = 1; day <= 60; day++) {
      const [q] = pickQuizQuestions(1, `kvizshow|2026-${String((day % 12) + 1).padStart(2, '0')}-${String((day % 28) + 1).padStart(2, '0')}`);
      distinct.add(q.prompt);
    }
    assert.ok(distinct.size >= 12, `rotation too narrow: ${distinct.size} distinct in 60 draws`);
  });

  test('count semantics: more than the corpus -> the whole corpus, zero -> empty, no repeats in one draw', () => {
    assert.equal(pickQuizQuestions(0, 's').length, 0);
    const all = pickQuizQuestions(QUIZ_QUESTIONS.length + 5, 's');
    assert.equal(all.length, QUIZ_QUESTIONS.length);
    assert.equal(new Set(all.map((q) => q.prompt)).size, all.length, 'no repeats within one draw');
  });

  test('usedPrompts are skipped (future quiz positions never repeat within a show)', () => {
    const first = pickQuizQuestions(1, 'seed-x')[0];
    const next = pickQuizQuestions(1, 'seed-x', new Set([first.prompt]));
    assert.equal(next.length, 1);
    assert.notEqual(next[0].prompt, first.prompt, 'used question must be skipped');
  });
});

// ---------------------------------------------------------------------------
// C. rubric keywords
// ---------------------------------------------------------------------------

describe('kviz rubric keywords', () => {
  test('"kviz" and "quiz" both resolve to the quiz rubric', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: vreme, kviz'), ['weather', 'quiz']);
    assert.deepEqual(parseBriefRubrics('Rubrike: quiz'), ['quiz']);
    assert.deepEqual(parseBriefRubrics('Rubrike: vreme, kviz, zanimivosti'), ['weather', 'quiz', 'trivia']);
  });

  test('unknown keywords stay ignored (existing behavior intact)', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: vreme, neznano'), ['weather']);
  });
});

// ---------------------------------------------------------------------------
// D. collectRubricData
// ---------------------------------------------------------------------------

describe('collectRubricData quiz collection', () => {
  test('default quizCount is 1', () => {
    assert.equal(rubricSettings().quizCount, 1);
  });

  test('offline: quiz STILL collected (local corpus needs no network), others null', async () => {
    const data = await collectRubricData({ names: ['quiz'], offline: true, date: '2026-10-24' });
    assert.equal(data.offline, true);
    assert.equal(data.weather, null);
    assert.equal(data.quiz.questions.length, 1);
    assert.ok(data.quiz.questions[0].prompt.endsWith('?'));
  });

  test('quiz absent when the rubric is not requested', async () => {
    const data = await collectRubricData({ names: ['vreme'], offline: true, date: '2026-10-24' });
    assert.equal(data.quiz, null);
  });

  test('online path collects quiz without touching the network (no fetch calls)', async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      throw new Error('network must not be needed for the quiz rubric');
    };
    try {
      const data = await collectRubricData({ names: ['quiz'], date: '2026-10-24', seed: 'q|2026-10-24' });
      assert.equal(called, 0, 'quiz-only rubric must not fetch');
      assert.equal(data.quiz.questions.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// E. template rendering
// ---------------------------------------------------------------------------

describe('quiz template rendering', () => {
  test('quizQuestion carries the prompt + the answer-after-song promise', () => {
    const body = renderSlot('quizQuestion', { values: { question: 'Kdo je ustanovil Iron Maiden?' }, seed: 's1' });
    assert.ok(body.includes('Kdo je ustanovil Iron Maiden?'));
    assert.match(body, /(razkrijemo|povemo) takoj po skladbi/i);
    assert.ok(!body.includes('undefined'), 'no unsubstituted placeholders');
  });

  test('quizAnswer carries the answer', () => {
    const body = renderSlot('quizAnswer', { values: { answer: 'Steve Harris' }, seed: 's2' });
    assert.match(body, /(Pravilen odgovor|Re\u0161itev kviza):?/);
    assert.ok(body.includes('Steve Harris'));
    assert.ok(!body.includes('undefined'));
  });
});

// ---------------------------------------------------------------------------
// F. segment placement
// ---------------------------------------------------------------------------

const mkTracks = (count) =>
  Array.from({ length: count }, (_, i) => ({
    ratingKey: `rk${i}`,
    artist: `Artist ${i}`,
    title: `Song ${i}`,
    album: 'Album',
    year: 2001,
    durationMs: 180000,
  }));

const quizBrief = { hasQuiz: true, hasWeather: false, primaryPersona: 'elena', title: 'Kviz Show' };
const plainBrief = { hasQuiz: false, hasWeather: false, primaryPersona: 'elena', title: 'Plain Show' };

function slotSequence(segments) {
  return segments.map((s) => s.slot ?? (s.type === 'track' ? 'TRACK' : s.type));
}

describe('buildSegmentsAuto quiz placement (P4 #22)', () => {
  test('real question before the middle track, answer right after it', () => {
    const tracks = mkTracks(6);
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: quizBrief,
      showId: 'kviz-show',
      date: '2026-10-24',
      rubricData: { quiz: { questions: [{ prompt: 'Kdo je ustanovil Iron Maiden?', answer: 'Steve Harris' }] } },
    });
    const slots = slotSequence(segments);
    const qi = slots.indexOf('quizIntro');
    const qr = slots.indexOf('quizReveal');
    assert.ok(qi > 0 && qr > qi, 'quizIntro before quizReveal');
    assert.equal(segments[qi + 1].type, 'track', 'question sits right before the track');
    assert.equal(slots[qr - 1], 'TRACK', 'answer sits right after the SAME track');
    assert.ok(segments[qi].body.includes('Kdo je ustanovil Iron Maiden?'), 'question text on air');
    assert.ok(segments[qr].body.includes('Steve Harris'), 'answer text on air');
  });

  test('no quiz data -> legacy year-guess still renders in the same slots', () => {
    const tracks = mkTracks(6);
    const { segments } = buildSegmentsAuto({ tracks, brief: quizBrief, showId: 'kviz-show', date: '2026-10-24', rubricData: {} });
    const slots = slotSequence(segments);
    const qi = slots.indexOf('quizIntro');
    assert.ok(qi > 0, 'legacy quiz position still present');
    assert.match(segments[qi].body, /Uganite|Kviz \u010das/, 'legacy year-guess intro');
    assert.match(segments[slots.indexOf('quizReveal')].body, /Pravilen odgovor|Resitev kviza/, 'legacy reveal');
    assert.ok(!segments.some((s) => s.slot === 'quizIntro' && s.body.includes('Odgovor razkrijemo takoj po skladbi') && s.body.includes('? ')), 'no corpus promise without corpus data');
  });

  test('brief without the quiz segment has no quiz position even with quiz data', () => {
    const tracks = mkTracks(6);
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: plainBrief,
      showId: 'plain-show',
      date: '2026-10-24',
      rubricData: { quiz: { questions: [{ prompt: 'Kdo je ustanovil Iron Maiden?', answer: 'Steve Harris' }] } },
    });
    const slots = slotSequence(segments);
    assert.equal(slots.filter((s) => s === 'quizIntro' || s === 'quizReveal').length, 0, 'quiz needs the brief quiz segment');
  });
});
