// history/aired.jsonl reading (server/historyApi.js). Pins the per-line
// tolerance contract: one torn ledger line must cost exactly that line, not
// the whole listener history -- the same discipline requestsStore.readRequests
// already applies to requests.jsonl. Also pins the double-sided limit clamp
// (Task 11-P1: the bare .map zeroed everything on a torn line).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('history-api');

const { readAiredEntries, getRecentHistory } = await import('../src/server/historyApi.js');
const { config } = await import('../src/config/index.js');

function ledgerPath() {
  return config.paths.airedHistoryFile;
}

// Real scrobbleTrack.js entry shape (ratingKey/artist/title/album/showId/
// playedAt are the fields the projections read).
function entry(i, { ratingKey = null } = {}) {
  return {
    ratingKey,
    artist: `Artist ${i}`,
    title: `Song ${i}`,
    album: `Album ${i}`,
    showId: 'rock-vecer',
    playedAt: `2026-10-2${i}T20:00:00+02:00`,
  };
}

describe('readAiredEntries (torn-line tolerance)', () => {
  test('one torn middle line: the other lines still come back', () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      [
        JSON.stringify(entry(1)),
        '{"artist":"Torn","ti', // crash mid-append / interleaved rewrite
        JSON.stringify(entry(2, { ratingKey: 'abc123' })),
        '',
      ].join('\n')
    );
    const all = readAiredEntries();
    assert.equal(all.length, 2, 'only the torn line is lost');
    assert.equal(all[0].title, 'Song 1');
    assert.equal(all[1].title, 'Song 2');
  });

  test('missing ledger reads as empty (fresh deploy)', () => {
    fs.rmSync(path.dirname(ledgerPath()), { recursive: true, force: true });
    assert.deepEqual(readAiredEntries(), []);
    assert.deepEqual(getRecentHistory(10), []);
  });

  test('every line torn still reads as empty, never throws', () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), '{oops\n{also oops\n');
    assert.deepEqual(readAiredEntries(), []);
  });
});

describe('getRecentHistory (projection + clamp)', () => {
  test('newest first, artUrl only for entries with a ratingKey', () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      [entry(1), entry(2, { ratingKey: 'key2' }), entry(3)].map((e) => JSON.stringify(e)).join('\n') + '\n'
    );
    const recent = getRecentHistory(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].title, 'Song 3', 'newest first');
    assert.equal(recent[0].artUrl, null, 'no ratingKey -> no art URL');
    assert.equal(recent[1].artUrl, '/api/art/key2');
    assert.equal(recent[1].ip, undefined); // projection never leaks raw entry fields
  });

  test('limit is clamped both ways (0 and negative mean no entries)', () => {
    assert.equal(getRecentHistory(0).length, 0, '0 honestly means "no entries"');
    assert.equal(getRecentHistory(-5).length, 0, 'negative no longer inverts slice semantics');
    assert.equal(getRecentHistory(Number.POSITIVE_INFINITY).length, 3, 'non-finite falls back, not a dump');
    assert.equal(getRecentHistory('not-a-number').length, 3);
  });
});

describe('structural pin (source discipline)', () => {
  test('per-line try/catch present, no bare .map(JSON.parse) left', () => {
    const src = fs.readFileSync(path.join(repoRoot(), 'src', 'server', 'historyApi.js'), 'utf8');
    assert.match(src, /for \(const line of lines\)/);
    assert.match(src, /out\.push\(JSON\.parse\(line\)\)/);
    assert.doesNotMatch(src, /\.map\(\(line\) => JSON\.parse\(line\)\)/, 'bare map would re-zero history on a torn line');
  });
});
