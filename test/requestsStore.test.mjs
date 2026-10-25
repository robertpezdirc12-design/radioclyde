// Listener song requests store (server/requestsStore.js) -- issue #2
// section A ("optional listener actions ... never show a false success
// state") and section B.4 (moderation). These tests pin the honesty
// contract: pending-only submissions, IP-free public projection, closed
// rate limiting, and moderation that really persists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('requests-store');

const {
  validateSubmission,
  submissionAllowed,
  appendRequest,
  readRequests,
  getRequest,
  updateRequestStatus,
  publicView,
  listRequests,
} = await import('../src/server/requestsStore.js');

describe('validateSubmission', () => {
  test('request without a title is refused', () => {
    const res = validateSubmission({ type: 'request', title: '  ' });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('naslov pesmi')));
  });

  test('dedication without a message is refused', () => {
    const res = validateSubmission({ type: 'dedication', message: '' });
    assert.equal(res.ok, false);
  });

  test('unknown type is refused', () => {
    const res = validateSubmission({ type: 'shoutout', title: 'x' });
    assert.equal(res.ok, false);
  });

  test('oversized message is refused', () => {
    const res = validateSubmission({ type: 'dedication', message: 'a'.repeat(501) });
    assert.equal(res.ok, false);
  });

  test('valid request and dedication pass', () => {
    assert.equal(validateSubmission({ type: 'request', title: 'Pesem' }).ok, true);
    assert.equal(validateSubmission({ type: 'dedication', message: 'Za mamo' }).ok, true);
  });
});

describe('append / read / moderate', () => {
  test('append returns pending entry with id; ip never appears in publicView', () => {
    const entry = appendRequest({ type: 'request', title: 'Song', artist: 'Artist', message: '', from: 'Ana' }, '203.0.113.9');
    assert.ok(entry.id);
    assert.equal(entry.status, 'pending');
    const view = publicView(entry);
    assert.equal(view.status, 'pending');
    assert.equal(view.ip, undefined);
    assert.equal(getRequest(entry.id).title, 'Song');
  });

  test('status update persists and validates transitions', () => {
    const entry = appendRequest({ type: 'dedication', message: 'lp' }, '203.0.113.10');
    const updated = updateRequestStatus(entry.id, 'approved', 'v 18. uri');
    assert.equal(updated.status, 'approved');
    assert.equal(getRequest(entry.id).note, 'v 18. uri');
    assert.equal(updateRequestStatus(entry.id, 'no-such-status').invalid, true);
    assert.equal(updateRequestStatus('missing-id', 'approved'), null);
  });

  test('listRequests sorts newest first and filters by status', () => {
    const a = appendRequest({ type: 'request', title: 'first' }, '203.0.113.11');
    const b = appendRequest({ type: 'request', title: 'second' }, '203.0.113.11');
    updateRequestStatus(a.id, 'rejected', 'ne obstaja v knjižnici');
    const all = listRequests();
    assert.equal(all[0].id, b.id);
    const rejected = listRequests({ status: 'rejected' });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].id, a.id);
    assert.equal(rejected[0].note, 'ne obstaja v knjižnici');
  });

  test('torn JSONL line is skipped, not fatal', async () => {
    const fs = await import('node:fs');
    const { requestsFilePath } = await import('../src/server/requestsStore.js');
    fs.appendFileSync(requestsFilePath(), '{broken json\n');
    assert.doesNotThrow(() => readRequests());
  });
});

describe('status transition rules (no resurrection)', () => {
  test('approved <-> rejected stays legal (owner changing their mind)', () => {
    const entry = appendRequest({ type: 'request', title: 'flip' }, '203.0.113.21');
    updateRequestStatus(entry.id, 'approved');
    const rejected = updateRequestStatus(entry.id, 'rejected', 'a vendar ne');
    assert.equal(rejected.status, 'rejected');
    const reApproved = updateRequestStatus(entry.id, 'approved');
    assert.equal(reApproved.status, 'approved');
  });

  test('a decided request can never go back to pending', () => {
    const approved = appendRequest({ type: 'request', title: 'stay-approved' }, '203.0.113.22');
    updateRequestStatus(approved.id, 'approved');
    assert.equal(updateRequestStatus(approved.id, 'pending').invalid, true);
    const rejected = appendRequest({ type: 'request', title: 'stay-rejected' }, '203.0.113.23');
    updateRequestStatus(rejected.id, 'rejected');
    assert.equal(updateRequestStatus(rejected.id, 'pending').invalid, true);
    // and the store is unchanged by the refused transition
    assert.equal(getRequest(approved.id).status, 'approved');
    assert.equal(getRequest(rejected.id).status, 'rejected');
  });

  test('pending -> pending is still the honest "edit the note" move', () => {
    const entry = appendRequest({ type: 'request', title: 'note edit' }, '203.0.113.24');
    const updated = updateRequestStatus(entry.id, 'pending', 'lastnik: poskusimo');
    assert.equal(updated.status, 'pending');
    assert.equal(getRequest(entry.id).note, 'lastnik: poskusimo');
  });
});

describe('listRequests limit clamp', () => {
  test('negative limit returns no rows (was: slice(0,-5) dropping the NEWEST)', () => {
    appendRequest({ type: 'request', title: 'clamp-a' }, '203.0.113.25');
    appendRequest({ type: 'request', title: 'clamp-b' }, '203.0.113.25');
    assert.equal(listRequests({ limit: -5 }).length, 0);
    assert.equal(listRequests({ limit: 1 }).length, 1);
    assert.equal(listRequests({ limit: 1 })[0].title, 'clamp-b', 'newest still first');
  });

  test('huge limits are capped at 500, non-finite falls back to 500', async () => {
    const fs = await import('node:fs');
    const { requestsFilePath } = await import('../src/server/requestsStore.js');
    fs.writeFileSync(requestsFilePath(), ''); // fresh store: appending 502 is slow otherwise
    for (let i = 0; i < 502; i++) {
      appendRequest({ type: 'request', title: `cap-${i}` }, '203.0.113.26');
    }
    assert.equal(listRequests({ limit: 1_000_000 }).length, 500, 'cap holds');
    assert.equal(listRequests({}).length, 500, 'default 500 holds');
    assert.equal(listRequests({ limit: Number.NaN }).length, 500, 'NaN falls back, not empty');
    assert.equal(listRequests({ limit: Number.POSITIVE_INFINITY }).length, 500);
    assert.equal(listRequests({ limit: 1_000_000 })[0].title, 'cap-501', 'newest first within the cap');
  });
});

describe('submissionAllowed (per-IP flood control, fails closed)', () => {
  test('second submission within the cooldown window is refused', () => {
    const now = Date.now();
    appendRequest({ type: 'request', title: 'one' }, '198.51.100.1', new Date(now - 60_000));
    const res = submissionAllowed('198.51.100.1', now);
    assert.equal(res.ok, false);
    assert.match(res.reason, /minut/);
  });

  test('submission after the cooldown passes', () => {
    const now = Date.now();
    appendRequest({ type: 'request', title: 'old' }, '198.51.100.2', new Date(now - 11 * 60_000));
    assert.equal(submissionAllowed('198.51.100.2', now).ok, true);
  });

  test('pending cap blocks a flooding IP', () => {
    const now = Date.now();
    const ip = '198.51.100.3';
    for (let i = 0; i < 3; i++) {
      appendRequest({ type: 'request', title: `p${i}` }, ip, new Date(now - (60 + i) * 60_000));
    }
    const res = submissionAllowed(ip, now);
    assert.equal(res.ok, false);
    assert.match(res.reason, /obravnavi/);
  });

  test('approved requests no longer count toward the pending cap', () => {
    const now = Date.now();
    const ip = '198.51.100.4';
    for (let i = 0; i < 3; i++) {
      const e = appendRequest({ type: 'request', title: `q${i}` }, ip, new Date(now - (120 + i) * 60_000));
      updateRequestStatus(e.id, 'approved');
    }
    assert.equal(submissionAllowed(ip, now).ok, true);
  });
});
