// Studio "Ankete" view -- the owner half of the listener polls (P4 #25):
// open and close the poll, watch the honest tally live, and read the frozen
// history, instead of curling the API by hand.
//
// Route note: the polls backend (src/server/pollsApi.js) lives on the ROOT
// /api surface, not under /studio/api/* -- GET /api/polls/active is the
// listener page's public read, and the owner actions (POST /api/polls,
// POST /api/polls/close, GET /api/polls/history) sit on the same surface,
// gated on the STUDIO credentials (pollsApi.js's requireStudioOwner). That
// is why this module cannot use the shared api.js helper (it prefixes every
// path with /studio): it speaks plain same-origin fetch with the same
// Content-Type discipline, and the browser's cached Basic-auth credentials
// ride these requests the same way they ride the listener page's /api
// calls. On the intended deployment (owner on a trusted network --
// config.web.trustedNetworks bypasses the public listener-auth hook
// entirely) the studio credentials reach the owner gate directly. From an
// untrusted network the listener-auth hook in front only lets listener
// credentials through, so the owner gate answers 403 with its Slovenian
// message -- surfaced verbatim below; curl over SSH remains the out-of-band
// fallback, exactly as before this view existed.
//
// Model (src/server/pollsStore.js): ONE active poll at a time. Opening a
// new poll closes the previous one and freezes its tally into history --
// the form warns about this BEFORE submitting whenever a poll is open. The
// active summary is {id, question, options, votes, total, leader,
// leaderVotes} with NO createdAt, so there is no "opened at" line to show;
// history entries are the raw store polls ({id, question, options, votes,
// createdAt, closedAt}) -- totals and winners are derived here with the
// store's own tie rule (ties resolve to the FIRST option, tally()).
// closedAt/createdAt are epoch-ms numbers, not ISO strings.
//
// Cadence: load on view entry + the Osveži button only -- the requests.js
// pattern (an owner tool does not self-poll; onAir.js is the studio's only
// self-poller). Same bind-once guard as requests.js: app.js re-runs the
// starter on every visit to this tab.

// Mirrors pollsStore.js's exported limits -- the server is the validator of
// record (its 400 errors[] are Slovenian and shown verbatim); the HTML
// maxlength attributes carry the same numbers.
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

const el = (id) => document.getElementById(id);

// Owner-tool fetch for the root /api polls surface. Same JSON-body
// discipline as js/api.js, but it surfaces the polls backend's {ok:false,
// errors[]} answer instead of dropping it on a bare status line.
async function rootApi(path, { method = 'GET', body } = {}) {
  const headers = {};
  let payload;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, { method, headers, body: payload });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty body -- fine for some responses
  }
  if (!res.ok) {
    const message =
      (Array.isArray(data?.errors) && data.errors.length > 0 && data.errors.join(' ')) ||
      data?.error ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

// Slovenian pluralization for 'glas': 1 glas, 2 glasova (dual), 3-4 glasovi,
// 5+ glasov -- the same helper the listener page's polls panel uses.
function votesLabel(n) {
  if (n === 1) return '1 glas';
  const mod100 = n % 100;
  if (mod100 === 2) return `${n} glasova`;
  if (mod100 === 3 || mod100 === 4) return `${n} glasovi`;
  return `${n} glasov`;
}

// requests.js's date shape: works for ISO strings and epoch-ms numbers
// (closedAt is a number) alike.
function fmtWhen(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value ?? '—')
    : d.toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// The store's tally() rule, derived client-side for HISTORY rows (the API
// only computes total/leader for the ACTIVE summary): honest totals, ties
// resolve to the FIRST option, no winner while nothing has any votes.
function tallyOf(poll) {
  const votes = Array.isArray(poll?.votes) ? poll.votes.map((n) => Number(n) || 0) : [];
  const total = votes.reduce((sum, n) => sum + n, 0);
  let leaderIndex = -1;
  let leaderVotes = 0;
  votes.forEach((count, index) => {
    if (count > leaderVotes) {
      leaderVotes = count;
      leaderIndex = index;
    }
  });
  const options = Array.isArray(poll?.options) ? poll.options : [];
  return {
    total,
    leader: leaderIndex >= 0 && leaderIndex < options.length ? options[leaderIndex] : null,
    leaderVotes,
  };
}

let activePoll = null; // last loaded active summary (null while none is open)

function setMessage(text, isError) {
  const message = el('polls-message');
  message.textContent = text ?? '';
  message.classList.toggle('error', Boolean(isError));
}

function setFormMessage(text, isError) {
  const message = el('polls-form-message');
  message.textContent = text ?? '';
  message.classList.toggle('error', Boolean(isError));
}

// One option of the ACTIVE poll: text, thin tally bar (the studio's own
// .progress-bar/.progress-fill pair from the On Air view), count + share.
function activeOptionRow(poll, index) {
  const votes = Number(poll.votes?.[index]) || 0;
  const total = Number(poll.total) || 0;
  const pct = total > 0 ? Math.round((votes / total) * 100) : 0;

  const row = document.createElement('div');
  row.className = 'poll-option-row';

  const label = document.createElement('p');
  label.className = 'poll-option-label';
  label.textContent = poll.options[index];
  row.appendChild(label);

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  bar.setAttribute('aria-hidden', 'true'); // the count line already says the numbers
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  row.appendChild(bar);

  const count = document.createElement('p');
  count.className = 'poll-count';
  count.textContent = `${votesLabel(votes)} · ${pct} %`;
  row.appendChild(count);
  return row;
}

function renderActive(poll) {
  activePoll = poll ?? null;
  const box = el('polls-active');
  box.replaceChildren();
  const valid =
    poll && typeof poll.question === 'string' && poll.question && Array.isArray(poll.options) && poll.options.length > 0;
  el('polls-active-empty').hidden = Boolean(valid);
  el('polls-close').hidden = !valid;
  if (!valid) return;

  const question = document.createElement('h3');
  question.className = 'poll-question';
  question.textContent = poll.question;
  box.appendChild(question);

  const options = Array.isArray(poll.options) ? poll.options : [];
  box.append(...options.map((_, index) => activeOptionRow(poll, index)));

  const total = document.createElement('p');
  total.className = 'poll-total';
  total.textContent = `Skupaj: ${votesLabel(Number(poll.total) || 0)}`;
  box.appendChild(total);
}

function renderHistory(closed) {
  const list = el('polls-history');
  const rows = Array.isArray(closed) ? closed : [];
  list.replaceChildren(
    ...rows.map((poll) => {
      const { total, leader } = tallyOf(poll);
      const li = document.createElement('li');
      const main = document.createElement('span');
      // "question · zmagovalec: option (N glasov)" -- no winner line while
      // nobody voted at all, the tally stays honest.
      main.textContent = leader
        ? `${poll.question} · zmagovalec: ${leader} (${votesLabel(total)})`
        : `${poll.question} · ${votesLabel(total)}`;
      const when = document.createElement('span');
      when.className = 'time';
      when.textContent = fmtWhen(poll.closedAt);
      li.append(main, when);
      return li;
    })
  );
  el('polls-history-empty').hidden = rows.length > 0;
}

async function loadPolls() {
  // Two independent reads: a failing history must not take the active card
  // down with it (and vice versa) -- each gets its own honest alert, the
  // requests.js load pattern.
  try {
    const data = await rootApi('/api/polls/active');
    renderActive(data?.poll ?? null);
  } catch (err) {
    window.alert('Napaka pri nalaganju ankete: ' + err.message);
  }
  try {
    // Owner-gated; the store itself caps the list at the last 10 closed
    // polls, newest first -- whatever arrives is what gets rendered.
    const data = await rootApi('/api/polls/history');
    renderHistory(data?.closed ?? []);
  } catch (err) {
    window.alert('Napaka pri nalaganju zgodovine anket: ' + err.message);
  }
  // Opening a new poll auto-closes the active one (pollsStore.createPoll) --
  // warn BEFORE the owner submits, not after.
  el('polls-replace-hint').hidden = !activePoll;
}

async function closePoll() {
  const poll = activePoll;
  if (!poll) return;
  // The studio's destructive-confirm shape (shows.js's delete): quoted
  // subject, consequence, irreversibility.
  if (!window.confirm(`Zaprem anketo "${poll.question}"? Rezultat se zamrzne v zgodovino, on-air napoved pa utihne. Tega ni mogoče razveljaviti.`)) {
    return;
  }
  try {
    const outcome = await rootApi('/api/polls/close', { method: 'POST' });
    if (outcome && outcome.ok === false) {
      // {ok:false, reason:'no-active'} -- it was already closed between the
      // load and this click; the re-render below shows the honest state.
      setMessage('Anketa je bila medtem že zaprta.');
    } else {
      setMessage('Anketa zaprta.');
    }
    await loadPolls();
  } catch (err) {
    setMessage(err.message, true);
  }
}

// ---------- new poll form ----------

function optionInputRow() {
  const row = document.createElement('div');
  row.className = 'poll-option-field';

  const label = document.createElement('label');
  label.textContent = 'Možnost';
  const input = document.createElement('input');
  input.type = 'text';
  // Mirrors pollsStore.js MAX_OPTION_LENGTH (80); the server re-validates.
  input.maxLength = 80;
  label.appendChild(input);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-small';
  remove.textContent = 'Odstrani';
  remove.addEventListener('click', () => {
    row.remove();
    syncOptionRows();
  });

  row.append(label, remove);
  return row;
}

// Renumber the labels/aria-labels and toggle the add/remove affordances:
// remove buttons only above the 2-option floor, "+ dodaj možnost" only
// below the 6-option ceiling (pollsStore.js's MIN/MAX_OPTIONS).
function syncOptionRows() {
  const rows = [...el('polls-options').children];
  rows.forEach((row, index) => {
    const label = row.querySelector('label');
    const remove = row.querySelector('button');
    label.firstChild.textContent = `Možnost ${index + 1}`;
    remove.setAttribute('aria-label', `Odstrani možnost ${index + 1}`);
    remove.hidden = rows.length <= MIN_OPTIONS;
  });
  el('polls-add-option').hidden = rows.length >= MAX_OPTIONS;
}

function resetPollForm() {
  el('polls-question').value = '';
  const box = el('polls-options');
  box.replaceChildren(optionInputRow(), optionInputRow());
  syncOptionRows();
}

let submitting = false; // one create round-trip at a time (double-clicks share one ask)

async function submitPoll(event) {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  setFormMessage('Odpiram...');
  try {
    const question = el('polls-question').value.trim();
    const options = [...el('polls-options').querySelectorAll('input')].map((input) => input.value.trim());
    await rootApi('/api/polls', { method: 'POST', body: { question, options } });
    setFormMessage('Anketa je odprta.');
    resetPollForm();
    // The new poll is active NOW (the previous one, if any, was frozen by
    // the same POST) -- re-render the active card and the history together.
    await loadPolls();
  } catch (err) {
    // 400: the server's own Slovenian errors[], verbatim.
    setFormMessage(err.message, true);
  } finally {
    submitting = false;
  }
}

// app.js re-runs startPollsView() on every visit to this tab -- bind the
// DOM listeners once so N visits don't fire N identical requests per click.
let bound = false;

export function startPollsView() {
  if (!bound) {
    bound = true;
    el('polls-form').addEventListener('submit', submitPoll);
    el('polls-add-option').addEventListener('click', () => {
      el('polls-options').appendChild(optionInputRow());
      syncOptionRows();
      const inputs = el('polls-options').querySelectorAll('input');
      inputs[inputs.length - 1].focus();
    });
    el('polls-close').addEventListener('click', closePoll);
    el('polls-refresh').addEventListener('click', loadPolls);
    resetPollForm();
  }
  loadPolls();
}
