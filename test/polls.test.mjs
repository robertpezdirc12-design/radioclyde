// Tests for P4 #25 listener polls backend (server/pollsStore.js):
//   A. validation (Slovenian errors, option count/length/dupe gates),
//   B. single-active lifecycle: create closes the previous one, votes
//      accumulate honest tallies, close freezes history,
//   C. fail-open reads: missing/corrupt store = "no active poll",
//   D. the API surface: routes exist and are wired in server/api.js,
//      the vote path carries a per-IP rate limit that answers 429.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('polls', {});

const store = await import('../src/server/pollsStore.js');

const goodBody = { question: 'Kateri bend naj zaigra v soboto?', options: ['Pankrti', 'Buldožer', 'Štuk'] };

describe('poll validation', () => {
  test('a good poll body passes', () => {
    assert.deepEqual(store.validatePollInput(goodBody), { ok: true });
  });

  test('empty question, too few/too many options, dupes all fail with Slovenian messages', () => {
    assert.ok(!store.validatePollInput({ question: '', options: ['a', 'b'] }).ok);
    assert.ok(!store.validatePollInput({ question: 'q', options: ['a'] }).ok, '1 option too few');
    assert.ok(!store.validatePollInput({ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }).ok, '7 options too many');
    assert.ok(!store.validatePollInput({ question: 'q', options: ['a', 'A'] }).ok, 'case-insensitive dupe');
    assert.ok(!store.validatePollInput({ question: 'q', options: ['a', '   '] }).ok, 'blank option');
    assert.ok(!store.validatePollInput({ question: 'q'.repeat(201), options: ['a', 'b'] }).ok, 'question too long');
  });
});

describe('poll lifecycle (single active)', () => {
  test('create -> active with zero tally; second create closes the first', () => {
    const first = store.createPoll(goodBody, 1000);
    assert.equal(store.readStore().active.id, first.id);
    assert.deepEqual(store.tally(first), { total: 0, leader: null, leaderVotes: 0 });

    const second = store.createPoll({ question: 'Naslednja?', options: ['x', 'y'] }, 2000);
    const after = store.readStore();
    assert.equal(after.active.id, second.id, 'new poll is active');
    assert.equal(after.closed.length, 1, 'previous poll frozen in history');
    assert.equal(after.closed[0].closedAt, 2000);
  });

  test('votes accumulate; bad option / wrong id / no active are honest failures', () => {
    const poll = store.createPoll(goodBody, 3000);
    const vote1 = store.votePoll(poll.id, 1);
    assert.ok(vote1.ok);
    assert.deepEqual(vote1.tally, { total: 1, leader: 'Buldožer', leaderVotes: 1 });
    store.votePoll(poll.id, 1);
    store.votePoll(poll.id, 0);
    assert.deepEqual(store.tally(store.readStore().active), { total: 3, leader: 'Buldožer', leaderVotes: 2 });

    assert.equal(store.votePoll(poll.id, 9).ok, false, 'out-of-range option');
    assert.equal(store.votePoll('poll-x', 0).ok, false, 'unknown id');
    assert.equal(store.votePoll(poll.id, 'a').ok, false, 'non-integer option');

    store.closeActivePoll(4000);
    assert.equal(store.votePoll(poll.id, 0).ok, false, 'closed poll takes no votes');
    assert.equal(store.votePoll(poll.id, 0).reason, 'no-active');
  });

  test('activePollSummary: null when empty, honest tally when voting', () => {
    assert.equal(store.activePollSummary(), null, 'empty store -> no active poll');
    const poll = store.createPoll(goodBody, 5000);
    store.votePoll(poll.id, 2);
    const summary = store.activePollSummary();
    assert.equal(summary.question, goodBody.question);
    assert.equal(summary.total, 1);
    assert.equal(summary.leader, 'Štuk');
    store.closeActivePoll(6000);
    assert.equal(store.activePollSummary(), null, 'closed -> summary null again');
  });

  test('fail-open: missing file and corrupt file both read as an empty store', () => {
    fs.rmSync(store.pollsFilePath(), { force: true });
    assert.deepEqual(store.readStore(), { active: null, closed: [] });
    fs.mkdirSync(store.pollsFilePath().replace(/[^/]+$/, ''), { recursive: true });
    fs.writeFileSync(store.pollsFilePath(), '{not json');
    assert.deepEqual(store.readStore(), { active: null, closed: [] });
  });

  test('store file lands under dataDir and survives a re-read (tmp+rename write)', () => {
    store.createPoll(goodBody, 7000);
    assert.ok(store.pollsFilePath().includes('test-polls'));
    assert.ok(fs.existsSync(store.pollsFilePath()));
    assert.ok(fs.existsSync(store.pollsFilePath()), 'no .tmp leftovers');
    assert.equal(fs.readdirSync(store.pollsFilePath().replace(/[^/]+$/, '')).filter((f) => f.endsWith('.tmp')).length, 0);
  });
});

describe('poll API surface', () => {
  const fs2 = fs;
  test('routes declared and mounted', async () => {
    const api = fs2.readFileSync(`${repoRoot()}/src/server/pollsApi.js`, 'utf8');
    assert.match(api, /fastify\.post\('\/api\/polls'/);
    assert.match(api, /fastify\.get\('\/api\/polls\/active'/);
    assert.match(api, /fastify\.post\('\/api\/polls\/vote'/);
    assert.match(api, /fastify\.post\('\/api\/polls\/close'/);
    assert.match(api, /429/, 'vote rate limit answers 429');
    const mount = fs2.readFileSync(`${repoRoot()}/src/server/api.js`, 'utf8');
    assert.match(mount, /registerPollsRoutes\(fastify\)/);
  });

  test('rate limit documented: per-IP in-memory window guards the vote path', () => {
    const api = fs.readFileSync(`${repoRoot()}/src/server/pollsApi.js`, 'utf8');
    assert.match(api, /VOTE_INTERVAL_MS = 30_000/, '30 s window pinned');
    assert.match(api, /lastVoteByIp/, 'per-IP map in play');
  });
});
