// Tests for P4 #26 "Poslusalci" rubric -- freshly approved listener requests
// and dedications read on air:
//   A. rubric keywords (briefQuery): slovenian + english aliases,
//   B. collectListenerShout honesty gates: approved-only, freshness window,
//      limit, dedication truncation, empty/corrupt store fail-open,
//   C. offline collection (local file, no network),
//   D. segment rendering + taxonomy (requestShout/dedicationShout).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('listeners', {});

const { parseBriefRubrics } = await import('../src/auto/briefQuery.js');
const { collectListenerShout, collectRubricData, rubricSettings } = await import('../src/auto/feeds.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { classifySegment } = await import('../src/script/segments.js');
const requestsStore = await import('../src/server/requestsStore.js');

const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60_000);

async function approve(entryId) {
  const out = requestsStore.updateRequestStatus(entryId, 'approved');
  assert.ok(!out.invalid, `approval of ${entryId} must succeed`);
}

describe('listeners rubric keywords', () => {
  test('slovenian + english aliases resolve to the listeners rubric', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: vreme, poslusalci'), ['weather', 'listeners']);
    assert.deepEqual(parseBriefRubrics('Rubrike: zahteve'), ['listeners']);
    assert.deepEqual(parseBriefRubrics('Rubrike: posvecila'), ['listeners']);
    assert.deepEqual(parseBriefRubrics('Rubrike: requests'), ['listeners']);
    assert.deepEqual(parseBriefRubrics('Rubrike: shoutouts'), ['listeners']);
  });
});

describe('collectListenerShout honesty gates', () => {
  // Store isolation: every test starts from an empty JSONL file.
  beforeEach(() => fs.rmSync(requestsStore.requestsFilePath(), { force: true }));

  test('empty store -> null (skip-not-fail)', () => {
    assert.equal(collectListenerShout(), null);
  });

  test('pending and rejected never air; approved within the window do', async () => {
    const pending = requestsStore.appendRequest({ type: 'request', title: 'PesemPending', artist: 'Skupina P', message: '', from: 'Pepi' }, '1.1.1.1');
    const rejected = requestsStore.appendRequest({ type: 'request', title: 'PesemRejected', artist: 'Skupina R', message: '', from: 'Rok' }, '1.1.1.2');
    const approved = requestsStore.appendRequest({ type: 'request', title: 'Lepi in prazni', artist: 'Pankrti', message: '', from: 'Mojca' }, '1.1.1.3');
    requestsStore.updateRequestStatus(rejected.id, 'rejected');
    await approve(approved.id);

    const data = collectListenerShout();
    assert.ok(data, 'approved entry exists -> rubric has content');
    assert.equal(data.shouts.length, 1, 'exactly the approved one');
    assert.equal(data.shouts[0].kind, 'request');
    assert.equal(data.shouts[0].artist, 'Pankrti');
    assert.equal(data.shouts[0].title, 'Lepi in prazni');
    assert.ok(!data.shouts.some((s) => s.title?.includes('Pending') || s.title?.includes('Rejected')), 'unapproved stay silent');
  });

  test('stale approvals (outside the 12 h window) do not air', async () => {
    // The store has no played flag, so freshness reads updatedAt -- the
    // approval moment. Simulating "approved long ago" means writing the
    // JSONL directly with an old updatedAt.
    const stale = requestsStore.appendRequest({ type: 'request', title: 'Staro', artist: 'Oldies', message: '', from: 'Nekoč' }, '2.2.2.2', hoursAgo(13));
    const oldDate = hoursAgo(13).toISOString();
    const rewritten = requestsStore
      .readRequests()
      .map((e) => (e.id === stale.id ? { ...e, status: 'approved', createdAt: oldDate, updatedAt: oldDate } : e));
    fs.writeFileSync(
      requestsStore.requestsFilePath(),
      rewritten.map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
    assert.equal(collectListenerShout(), null, '13 h old approval is not fresh');
    const recent = collectListenerShout({ windowHours: 24 });
    assert.ok(recent, 'but a 24 h window still sees it');
  });

  test('limit keeps the newest entries; 0 disables the rubric', async () => {
    const a = requestsStore.appendRequest({ type: 'request', title: 'Starejša', artist: 'A', message: '', from: '' }, '3.3.3.3', hoursAgo(2));
    const b = requestsStore.appendRequest({ type: 'request', title: 'Novejša', artist: 'B', message: '', from: '' }, '3.3.3.4', hoursAgo(1));
    await approve(a.id);
    await approve(b.id);

    const two = collectListenerShout({ limit: 2 });
    assert.equal(two.shouts.length, 2);
    const one = collectListenerShout({ limit: 1 });
    assert.equal(one.shouts.length, 1, 'limit respected');
    assert.equal(one.shouts[0].title, 'Novejša', 'newest first');

    assert.equal(collectListenerShout({ limit: 0 }), null, 'limit 0 disables content');
    assert.ok(rubricSettings().listenerLimit === 2 && rubricSettings().listenerWindowHours === 12, 'defaults pinned');
  });

  test('dedications arrive as kind dedication, messages truncated at 160 chars', async () => {
    const longMessage = 'Vse najboljše '.repeat(30).trim(); // ~420 chars
    const dedication = requestsStore.appendRequest({ type: 'dedication', title: '', artist: '', message: longMessage, from: 'Anja' }, '4.4.4.4');
    await approve(dedication.id);

    const data = collectListenerShout();
    const shout = data.shouts.find((s) => s.kind === 'dedication');
    assert.ok(shout, 'dedication present');
    assert.ok(shout.message.length <= 163, `truncated to <=160 + '...' (got ${shout.message.length})`);
    assert.ok(shout.message.endsWith('...'));
    assert.equal(shout.from, 'Anja');
  });

  test('corrupt store fails open to null, never breaks a show', () => {
    fs.writeFileSync(requestsStore.requestsFilePath(), 'not jsonl at all');
    assert.equal(collectListenerShout(), null);
  });
});

describe('offline collection + segments', () => {
  beforeEach(() => fs.rmSync(requestsStore.requestsFilePath(), { force: true }));

  test('collectRubricData collects listeners OFFLINE (local store, zero network)', async () => {
    const ok = requestsStore.appendRequest({ type: 'request', title: 'Tujc', artist: 'Zmelkows', message: '', from: 'Bine' }, '5.5.5.5');
    await approve(ok.id);
    const data = await collectRubricData({ names: ['listeners'], offline: true, date: '2026-10-24' });
    assert.ok(data.offline);
    assert.ok(data.listeners.shouts.length >= 1, 'local store works offline like quiz/poll');
  });

  test('buildSegmentsAuto renders requestShout + dedicationShout in listener_mailbag', () => {
    const tracks = Array.from({ length: 3 }, (_, i) => ({
      ratingKey: `rk${i}`, artist: `Artist ${i}`, title: `Song ${i}`, album: 'Al', year: 2000, durationMs: 180000,
    }));
    const listeners = {
      shouts: [
        { kind: 'request', artist: 'Pankrti', title: 'Lepi in prazni', from: 'Mojca' },
        { kind: 'dedication', message: 'Za mamo', from: 'Anja' },
      ],
    };
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: { hasQuiz: false, hasWeather: false, primaryPersona: 'elena', title: 'Zahteve Show' },
      showId: 'listeners-show',
      date: '2026-10-24',
      rubricData: { weather: null, news: null, sport: null, onThisDay: null, onThisDayMusic: null, quiz: null, poll: null, listeners },
    });
    const request = segments.find((s) => s.slot === 'requestShout');
    const dedication = segments.find((s) => s.slot === 'dedicationShout');
    assert.ok(request && dedication, 'both shout kinds rendered');
    assert.ok(request.body.includes('Pankrti') && request.body.includes('Lepi in prazni'));
    assert.ok(dedication.body.includes('Za mamo'));
    assert.equal(classifySegment(request), 'listener_mailbag');
    assert.equal(classifySegment(dedication), 'listener_mailbag');
    // Both land in the rubrica block: after open, before the first track.
    const slots = segments.map((s) => s.slot ?? (s.type === 'track' ? 'track' : null));
    assert.ok(slots.indexOf('requestShout') > slots.indexOf('open') && slots.indexOf('requestShout') < slots.indexOf('track'));
  });

  test('no listeners data -> no shout segments (backward compatible)', () => {
    const tracks = Array.from({ length: 3 }, (_, i) => ({
      ratingKey: `rk${i}`, artist: `Artist ${i}`, title: `Song ${i}`, album: 'Al', year: 2000, durationMs: 180000,
    }));
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: { hasQuiz: false, hasWeather: false, primaryPersona: 'elena', title: 'Plain' },
      showId: 'listeners-show',
      date: '2026-10-24',
      rubricData: { weather: null, news: null, sport: null, onThisDay: null, onThisDayMusic: null, quiz: null, poll: null, listeners: null },
    });
    assert.ok(!segments.some((s) => s.slot === 'requestShout' || s.slot === 'dedicationShout'));
  });
});
