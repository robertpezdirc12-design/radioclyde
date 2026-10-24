// Listener polls ("anketa", P4 #25) -- the whole backend for the poll
// feature the research pass ranked third: professional stations run polls
// and report honest tallies on air; the quiz corpus gave us the questions
// habit, this gives the audience the channel. One ACTIVE poll at a time
// (radio's natural shape: the host opens it, talks about it during the
// show, closes it), voting counts anonymous tallies per option.
//
// Storage mirrors requestsStore.js: a single JSON file rewritten atomically
// via tmp+rename. Read path fails OPEN -- a missing or corrupt file means
// "no active poll", never a broken show (the same skip-not-fail contract
// every rubric follows). The on-air rubric reads this store directly, so
// polls work with zero network, exactly like the quiz corpus.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_OPTION_LENGTH = 80;

export function pollsFilePath() {
  return config.paths.pollsFile;
}

function emptyStore() {
  return { active: null, closed: [] };
}

// Fails open: any read problem = empty store. The rubric and the API both
// live with "no poll" rather than an exception.
export function readStore() {
  try {
    const raw = fs.readFileSync(pollsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return { active: parsed.active ?? null, closed: Array.isArray(parsed.closed) ? parsed.closed : [] };
  } catch {
    return emptyStore();
  }
}

export function writeStore(store) {
  const file = pollsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

// Tally helper shared by the store and the API shape: always the honest
// totals, never percentages of nothing. Leader ties resolve to the FIRST
// option (deterministic, and the air line says "vodi" about that option
// without claiming exclusivity).
export function tally(poll) {
  const votes = poll.votes ?? [];
  const total = votes.reduce((sum, n) => sum + (Number(n) || 0), 0);
  let leaderIndex = -1;
  let leaderVotes = 0;
  votes.forEach((count, index) => {
    if ((Number(count) || 0) > leaderVotes) {
      leaderVotes = Number(count) || 0;
      leaderIndex = index;
    }
  });
  return {
    total,
    leader: leaderIndex >= 0 ? poll.options[leaderIndex] : null,
    leaderVotes,
  };
}

// Returns { ok: true, errors } shape like requestsStore.validateSubmission --
// every message in Slovenian, since the studio form is the only consumer.
export function validatePollInput(body) {
  const errors = [];
  const question = String(body?.question ?? '').trim();
  if (!question) errors.push('Anketa brez vprašanja ni možna.');
  if (question.length > MAX_QUESTION_LENGTH) {
    errors.push(`Vprašanje je predolgo (največ ${MAX_QUESTION_LENGTH} znakov).`);
  }

  const options = Array.isArray(body?.options) ? body.options.map((o) => String(o ?? '').trim()) : [];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    errors.push(`Anketa potrebuje ${MIN_OPTIONS}-${MAX_OPTIONS} možnosti.`);
  }
  if (options.some((o) => !o)) errors.push('Možnosti ne smejo biti prazne.');
  if (options.some((o) => o.length > MAX_OPTION_LENGTH)) {
    errors.push(`Možnost je predolga (največ ${MAX_OPTION_LENGTH} znakov).`);
  }
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
    errors.push('Možnosti se ne smejo ponavljati.');
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

// Opens a new poll, closing the previous active one (single-active model).
// Votes of a closed poll are frozen -- history stays honest.
export function createPoll({ question, options }, now = Date.now()) {
  const store = readStore();
  if (store.active) {
    store.closed.push({ ...store.active, closedAt: now });
    store.active = null;
  }
  const poll = {
    id: `poll-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    question: String(question).trim(),
    options: options.map((o) => String(o).trim()),
    votes: options.map(() => 0),
    createdAt: now,
  };
  store.active = poll;
  writeStore(store);
  return poll;
}

// The shape the on-air rubric consumes (feeds.js -> scriptBuilder.js):
// null when nothing is open, otherwise question + honest tally summary.
export function activePollSummary() {
  const { active } = readStore();
  if (!active) return null;
  const { total, leader, leaderVotes } = tally(active);
  return {
    id: active.id,
    question: active.question,
    options: active.options,
    votes: active.votes,
    total,
    leader,
    leaderVotes,
  };
}

// Casts one anonymous vote for an option of the ACTIVE poll. No identity
// tracking by design: a personal station's poll is a mood gauge, not an
// election -- the API layer adds a light per-IP rate limit on top.
export function votePoll(id, optionIndex) {
  const store = readStore();
  const poll = store.active;
  if (!poll) return { ok: false, reason: 'no-active' };
  if (poll.id !== String(id ?? '')) return { ok: false, reason: 'unknown-id' };
  const index = Number(optionIndex);
  if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) {
    return { ok: false, reason: 'bad-option' };
  }
  poll.votes[index] += 1;
  writeStore(store);
  return { ok: true, tally: tally(poll) };
}

// Closes the active poll (owner action): freezes the tally into history and
// stops the on-air rubric from mentioning it.
export function closeActivePoll(now = Date.now()) {
  const store = readStore();
  if (!store.active) return { ok: false, reason: 'no-active' };
  store.closed.push({ ...store.active, closedAt: now });
  store.active = null;
  writeStore(store);
  return { ok: true };
}

export function pollHistory(limit = 10) {
  const { closed } = readStore();
  return closed.slice(-limit).reverse();
}
