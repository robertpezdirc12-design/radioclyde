// Cleanup pass regressions (src/scheduler/cleanupOldShows.js):
//  - the retentionDays refusal guard: non-numeric / null / negative values
//    used to make cutoff NaN, and `x >= NaN` is always false, so the sweep
//    deleted EVERY show dir under running/ including today's -- the exact
//    "non-numeric retentionDays silently deletes everything" defect
//  - the played.jsonl prune wiring (producer/history.js pruneOldEntries had
//    ZERO callers while the ledger was re-parsed whole on every filler regen)
//  - the requests.jsonl + closed-polls retention (the two ledgers nothing
//    pruned anywhere): age cutoff, newest-N floor, torn-line tolerance,
//    atomic tmp+rename rewrite, honest no-op on nothing-to-do
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('cleanup-retention');

const { config } = await import('../src/config/index.js');
const { cleanupOldShows, pruneRequestsLedger, pruneClosedPolls } = await import(
  '../src/scheduler/cleanupOldShows.js'
);
const { pruneOldEntries } = await import('../src/producer/history.js');

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

function todayDateKey() {
  const d = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateKeyDaysAgo(days) {
  const d = new Date(Date.now() - days * DAY);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// A running/ tree with one occurrence dir per given date under one show.
function seedRunningDir(dates) {
  const showDir = path.join(config.paths.runningDir, 'monday', 'test-show');
  fs.rmSync(config.paths.runningDir, { recursive: true, force: true });
  for (const date of dates) {
    fs.mkdirSync(path.join(showDir, date, '10-00'), { recursive: true });
    fs.writeFileSync(path.join(showDir, date, '10-00', 'playlist.m3u'), '#x\n');
  }
  return showDir;
}

function seededDirs(showDir) {
  return fs
    .readdirSync(showDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('retentionDays refusal guard (the wipe-everything defect)', () => {
  // Plain loop, not test.each: this Node line's node:test exposes no .each,
  // and each junk value deserves its own named failure anyway.
  for (const junk of ['week', null, -5, 0, Number.NaN]) {
    test(`junk retentionDays ${JSON.stringify(junk)} removes NOTHING, today included`, async () => {
      const showDir = seedRunningDir([todayDateKey(), dateKeyDaysAgo(30)]);

      const { removed } = await cleanupOldShows(junk);

      assert.equal(removed, 0);
      // Both today's AND the month-old occurrence survive the refused sweep.
      assert.deepEqual(seededDirs(showDir), [dateKeyDaysAgo(30), todayDateKey()]);
    });
  }

  test('a valid retention still removes only the genuinely old dirs', async () => {
    const showDir = seedRunningDir([todayDateKey(), dateKeyDaysAgo(30)]);

    const { removed } = await cleanupOldShows(7);

    assert.equal(removed, 1);
    assert.deepEqual(seededDirs(showDir), [todayDateKey()]);
  });

  test('junk also arrives via the config default path (config.cleanup.retentionDays)', async () => {
    const previous = config.cleanup;
    config.cleanup = { retentionDays: 'week' };
    try {
      const showDir = seedRunningDir([todayDateKey()]);
      const { removed } = await cleanupOldShows();
      assert.equal(removed, 0);
      assert.deepEqual(seededDirs(showDir), [todayDateKey()]);
    } finally {
      config.cleanup = previous;
    }
  });
});

describe('played.jsonl prune wiring (pruneOldEntries finally has a caller)', () => {
  test('the cleanup pass prunes out-of-window history entries, keeps recent ones', async () => {
    fs.rmSync(config.paths.historyFile, { force: true });
    fs.mkdirSync(path.dirname(config.paths.historyFile), { recursive: true });
    fs.writeFileSync(
      config.paths.historyFile,
      [
        JSON.stringify({ ratingKey: 'old', artist: 'a', title: 't', showId: 's', playedAt: iso(120) }),
        JSON.stringify({ ratingKey: 'new', artist: 'a', title: 't', showId: 's', playedAt: iso(1) }),
      ].join('\n') + '\n'
    );

    // Fixtures' shows.repeatWindowDays = 30 -> pruneOldEntries keeps a 2x
    // margin (60d); the 120d-old entry is outside it, the 1d-old is not.
    await cleanupOldShows(7);

    const remaining = fs.readFileSync(config.paths.historyFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(remaining.length, 1);
    assert.equal(JSON.parse(remaining[0]).ratingKey, 'new');
  });

  test('the wiring is structural: pruneOldEntries called on the cleanup cadence, next to the aired prune', () => {
    const source = fs.readFileSync(`${repoRoot()}/src/scheduler/cleanupOldShows.js`, 'utf8');
    assert.match(source, /import \{ pruneOldEntries \} from '\.\.\/producer\/history\.js';/);
    const airedCall = source.indexOf('pruneAiredHistory(config.cleanup?');
    const playedCall = source.indexOf('prunePlayedHistory();');
    const requestsCall = source.indexOf('pruneRequestsLedger();');
    assert.ok(airedCall !== -1 && playedCall !== -1, 'both prune calls present');
    assert.ok(
      Math.abs(airedCall - playedCall) < 400,
      'pruneOldEntries runs in the same cleanup pass as the aired-history prune'
    );
    assert.ok(requestsCall > playedCall, 'the requests/polls prunes live in the same pass too');
  });
});

describe('requests.jsonl retention (pruneRequestsLedger)', () => {
  function requestLine(daysAgo, id) {
    return JSON.stringify({
      id: id ?? `r-${daysAgo}`,
      type: 'request',
      title: 'T',
      artist: 'A',
      message: '',
      from: '',
      ip: '127.0.0.1',
      status: 'approved',
      note: '',
      createdAt: iso(daysAgo),
      updatedAt: iso(daysAgo),
    });
  }

  test('drops aged-out entries once past the newest-200 floor', () => {
    // 210 aged-out + 1 fresh: only 1 entry is inside the window, so the floor
    // keeps the newest 200 raw lines (199 aged + the fresh one) and drops 11
    // -- exactly the floor semantics the aired-history prune uses, mirrored
    // (a small file is never pruned below its newest 200).
    const lines = [];
    for (let i = 0; i < 210; i++) lines.push(requestLine(120, `old-${i}`));
    lines.push(requestLine(1, 'fresh'));
    fs.writeFileSync(config.paths.requestsFile, lines.join('\n') + '\n');

    const dropped = pruneRequestsLedger(90);

    assert.equal(dropped, 11);
    const kept = fs.readFileSync(config.paths.requestsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.length, 200);
    assert.equal(JSON.parse(kept[kept.length - 1]).id, 'fresh');
    // Atomic swap leaves no tmp sibling behind.
    const leftovers = fs.readdirSync(path.dirname(config.paths.requestsFile)).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('torn lines drop even when everything else is fresh (no floor rescue for garbage)', () => {
    const lines = [];
    for (let i = 0; i < 250; i++) lines.push(requestLine(2, `fresh-${i}`));
    lines.push('{torn json');
    fs.writeFileSync(config.paths.requestsFile, lines.join('\n') + '\n');

    const dropped = pruneRequestsLedger(90);

    assert.equal(dropped, 1);
    const kept = fs.readFileSync(config.paths.requestsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.length, 250);
    assert.ok(!kept.some((l) => l.includes('torn')));
  });

  test('newest-N floor: a burst of aging-out entries never erodes the last 200', () => {
    const lines = [];
    for (let i = 0; i < 250; i++) lines.push(requestLine(120, `old-${i}`));
    lines.push(requestLine(1, 'newest'));
    fs.writeFileSync(config.paths.requestsFile, lines.join('\n') + '\n');

    const dropped = pruneRequestsLedger(90, 200);

    // 251 lines, only 1 inside the window -> the floor kicks in: keep the
    // newest 200 (the fresh one + 199 oldest-ordered aged ones), drop 51.
    assert.equal(dropped, 51);
    const kept = fs.readFileSync(config.paths.requestsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.length, 200);
    assert.equal(JSON.parse(kept[kept.length - 1]).id, 'newest');
  });

  test('nothing to drop: no rewrite at all (mtime untouched), returns 0', () => {
    fs.writeFileSync(config.paths.requestsFile, [requestLine(1, 'a'), requestLine(2, 'b')].join('\n') + '\n');
    const before = fs.statSync(config.paths.requestsFile).mtimeMs;

    assert.equal(pruneRequestsLedger(90), 0);
    assert.equal(fs.statSync(config.paths.requestsFile).mtimeMs, before);
  });

  test('missing file is a no-op, not a throw', () => {
    fs.rmSync(config.paths.requestsFile, { force: true });
    assert.equal(pruneRequestsLedger(90), 0);
  });

  test('wired into the cleanup pass: aged-out requests drop on a plain cleanupOldShows() tick', async () => {
    const lines = [];
    for (let i = 0; i < 250; i++) lines.push(requestLine(120, `old-${i}`));
    lines.push(requestLine(1, 'fresh'));
    fs.writeFileSync(config.paths.requestsFile, lines.join('\n') + '\n');
    await cleanupOldShows(7);
    const kept = fs.readFileSync(config.paths.requestsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.length, 200);
    assert.equal(JSON.parse(kept[kept.length - 1]).id, 'fresh');
  });
});

describe('closed-polls retention (pruneClosedPolls)', () => {
  const poll = (id, closedDaysAgo) => ({
    id,
    question: `q ${id}`,
    options: ['a', 'b'],
    votes: [1, 2],
    createdAt: iso(closedDaysAgo + 1),
    ...(closedDaysAgo === null ? {} : { closedAt: iso(closedDaysAgo) }),
  });

  test('drops aged-out closed polls, keeps fresh + malformed ones, active untouched, atomic', () => {
    fs.writeFileSync(
      config.paths.pollsFile,
      JSON.stringify(
        { active: poll('live', null), closed: [poll('c-old', 120), poll('c-new', 2), poll('c-nodate', null)] },
        null,
        2
      )
    );

    const dropped = pruneClosedPolls(90);

    assert.equal(dropped, 1); // only the 120d-old closed poll
    const store = JSON.parse(fs.readFileSync(config.paths.pollsFile, 'utf8'));
    // Filter preserves store order -- the fresh one, then the malformed one
    // (an unparseable closedAt is KEPT, conservative like every ledger).
    assert.deepEqual(
      store.closed.map((p) => p.id),
      ['c-new', 'c-nodate']
    );
    assert.equal(store.active.id, 'live');
    const leftovers = fs.readdirSync(path.dirname(config.paths.pollsFile)).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('nothing aged out: no rewrite (mtime untouched), returns 0', () => {
    fs.writeFileSync(config.paths.pollsFile, JSON.stringify({ active: null, closed: [poll('c-new', 2)] }, null, 2));
    const before = fs.statSync(config.paths.pollsFile).mtimeMs;

    assert.equal(pruneClosedPolls(90), 0);
    assert.equal(fs.statSync(config.paths.pollsFile).mtimeMs, before);
  });

  test('missing / corrupt / wrong-shape polls.json are honest no-ops', () => {
    fs.rmSync(config.paths.pollsFile, { force: true });
    assert.equal(pruneClosedPolls(90), 0);
    fs.writeFileSync(config.paths.pollsFile, '{not json');
    assert.equal(pruneClosedPolls(90), 0);
    fs.writeFileSync(config.paths.pollsFile, JSON.stringify({ active: null }));
    assert.equal(pruneClosedPolls(90), 0); // no closed[] at all
  });

  test('wired into the cleanup pass: an aged-out closed poll drops on a plain tick', async () => {
    fs.writeFileSync(
      config.paths.pollsFile,
      JSON.stringify({ active: null, closed: [poll('c-old', 120), poll('c-new', 2)] }, null, 2)
    );
    await cleanupOldShows(7);
    const store = JSON.parse(fs.readFileSync(config.paths.pollsFile, 'utf8'));
    assert.deepEqual(store.closed.map((p) => p.id), ['c-new']);
  });
});
