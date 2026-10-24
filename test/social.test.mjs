// Tests for P4 #25 social export (src/auto/social.js):
//   A. the deterministic post set: card first, one post per rubric segment,
//      the "na sporedu" track card last,
//   B. every post fits the limit and carries the station hashtag,
//   C. long bodies truncate at a word boundary (never mid-word, never
//      dropping the hashtag),
//   D. template dashes are cleaned for the written-web shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('social', {});

const social = await import('../src/auto/social.js');

const segments = [
  { type: 'dj', persona: 'elena', slot: 'open', body: 'Poslušate Test Station.' },
  { type: 'dj', persona: 'elena', slot: 'weatherNow', body: 'Vreme: Test Station -- jasno, 12 stopinj.' },
  { type: 'dj', persona: 'elena', slot: 'newsHeadlines', body: 'Novice: prva novica.' },
  { type: 'track', artist: 'A1', title: 'T1', ratingKey: 'rk1' },
  { type: 'dj', persona: 'elena', slot: 'intro', body: 'Zdaj sledi A1.' },
  { type: 'track', artist: 'A2', title: 'T2', ratingKey: 'rk2' },
  { type: 'dj', persona: 'elena', slot: 'triviaGeneral', body: 'Ste to vedeli? Nekaj lepega iz zgodovine rocka.' },
  { type: 'track', artist: 'A3', title: 'T3', ratingKey: 'rk3' },
  { type: 'dj', persona: 'elena', slot: 'quizIntro', body: 'Kviz za pozorne poslušalce: vprašanje? Odgovor razkrijemo takoj po skladbi.' },
  { type: 'dj', persona: 'elena', slot: 'close', body: 'To je bilo vse za tokrat.' },
];

describe('social post set', () => {
  const posts = social.socialPostsFromSegments({ segments, title: 'Jutranja premiera', date: '2026-10-24', station: 'Test Station' });

  test('card first, rubric posts in air order, track card last', () => {
    const files = posts.map((p) => p.file);
    assert.equal(files[0], '01-karta.txt');
    assert.deepEqual(files.slice(1, -1), ['02-vreme.txt', '03-novice.txt', '04-zanimivost.txt', '05-kviz.txt']);
    assert.ok(files[files.length - 1].endsWith('-najave.txt'), 'najave last');
    const najave = posts[posts.length - 1].text;
    assert.match(najave, /A1 – T1 • A2 – T2 • A3 – T3/);
    assert.match(najave, /Na sporedu/);
  });

  test('card names show, date and the track count', () => {
    const card = posts[0].text;
    assert.match(card, /Jutranja premiera/);
    assert.match(card, /2026-10-24/);
    assert.match(card, /3 skladb/);
  });

  test('every post fits the limit and ends with the hashtag', () => {
    for (const post of posts) {
      assert.ok(post.text.length <= social.SOCIAL_LIMIT, `${post.file} over limit (${post.text.length})`);
      assert.ok(post.text.endsWith(social.HASHTAG), `${post.file} missing hashtag`);
    }
  });

  test('open/close/intro/recap segments never become posts', () => {
    const all = posts.map((p) => p.text).join('\n');
    assert.ok(!all.includes('Poslušate Test Station.'), 'open is not a post');
    assert.ok(!all.includes('To je bilo vse za tokrat.'), 'close is not a post');
    assert.ok(!all.includes('Zdaj sledi A1.'), 'track intro is not a post');
  });
});

describe('limit fitting + cleanup', () => {
  test('short text passes through with the hashtag appended', () => {
    const out = social.fitToLimit('Kratka objava.');
    assert.equal(out, 'Kratka objava.\n\n#RadioMarkec');
    assert.ok(out.length <= social.SOCIAL_LIMIT);
  });

  test('long text truncates at a word boundary, keeps the hashtag, stays in limit', () => {
    const long = 'Beseda '.repeat(120).trim(); // 840 chars
    const out = social.fitToLimit(long);
    assert.ok(out.length <= social.SOCIAL_LIMIT, `length ${out.length}`);
    assert.ok(out.endsWith(social.HASHTAG));
    assert.ok(out.includes('\u2026'), 'ellipsis marks the cut');
    assert.ok(!/\u2026\S/.test(out.slice(0, out.indexOf(social.HASHTAG))), 'no character glued after the ellipsis');
  });

  test('template double dashes become the typographic dash in posts', () => {
    const posts = social.socialPostsFromSegments({ segments, title: 'T', date: '2026-10-24' });
    const vreme = posts.find((p) => p.file === '02-vreme.txt');
    assert.ok(vreme.text.includes(' \u2013 '), 'cleaned dash');
    assert.ok(!vreme.text.includes(' -- '), 'no template dash left');
  });

  test('deterministic: same segments -> same posts', () => {
    const rerun = social.socialPostsFromSegments({ segments, title: 'Jutranja premiera', date: '2026-10-24', station: 'Test Station' });
    const posts = social.socialPostsFromSegments({ segments, title: 'Jutranja premiera', date: '2026-10-24', station: 'Test Station' });
    assert.deepEqual(rerun, posts);
  });
});
