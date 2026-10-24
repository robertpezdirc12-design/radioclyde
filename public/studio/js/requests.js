// Requests & dedications moderation (issue #2 B.4). Approve/reject writes
// through to requestsStore.js -- the listener's status endpoint then shows
// exactly what was set here, so what the owner decides is what the listener
// sees. The Queue button (P2 #8) pushes an approved request onto
// Liquidsoap's request.queue (radio.liq id "requests"); the response mirrors
// the note the backend writes, so an honest outcome is visible in both
// places without a refresh round trip.
import { api } from './api.js';

const el = (id) => document.getElementById(id);

function statusBadge(status) {
  const span = document.createElement('span');
  span.className = `status-pill status-${status}`;
  span.textContent = status;
  return span;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function moderate(id, status) {
  const note = window.prompt(`Note for the listener (optional, shown on status check) -- ${status}:`, '');
  if (note === null) return; // cancelled
  try {
    await api(`/api/requests/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status, note } });
    load();
  } catch (err) {
    window.alert(err.message);
  }
}

async function queue(id) {
  try {
    const outcome = await api(`/api/requests/${encodeURIComponent(id)}/queue`, { method: 'POST' });
    window.alert(
      outcome.ok
        ? `V vrsti (Liquidsoap request #${outcome.requestId}) -- zaigra na naslednji meji skladbe: ${outcome.track.artist} - ${outcome.track.title}`
        : outcome.error
    );
    load();
  } catch (err) {
    window.alert(err.message);
  }
}

function row(r) {
  const tr = document.createElement('tr');

  const when = document.createElement('td');
  when.textContent = fmtWhen(r.createdAt);

  const type = document.createElement('td');
  type.textContent = r.type === 'dedication' ? 'Dedication' : 'Request';

  const track = document.createElement('td');
  track.textContent = [r.artist, r.title].filter(Boolean).join(' — ') || '—';

  const message = document.createElement('td');
  message.textContent = r.message || '—';

  const from = document.createElement('td');
  from.textContent = r.from || '—';

  const ip = document.createElement('td');
  ip.textContent = r.ip || '—';

  const status = document.createElement('td');
  status.appendChild(statusBadge(r.status));
  if (r.note) {
    const note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = r.note;
    status.appendChild(note);
  }

  const actions = document.createElement('td');
  if (r.status !== 'approved') {
    const approve = document.createElement('button');
    approve.className = 'btn btn-small';
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => moderate(r.id, 'approved'));
    actions.appendChild(approve);
  }
  if (r.status !== 'rejected') {
    const reject = document.createElement('button');
    reject.className = 'btn btn-small btn-danger';
    reject.type = 'button';
    reject.style.marginLeft = '6px';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => moderate(r.id, 'rejected'));
    actions.appendChild(reject);
  }
  if (r.status === 'approved' && r.title) {
    const queueBtn = document.createElement('button');
    queueBtn.className = 'btn btn-small';
    queueBtn.type = 'button';
    queueBtn.style.marginLeft = '6px';
    queueBtn.textContent = 'Queue';
    queueBtn.title = 'Push onto Liquidsoap\'s request queue -- airs at the next track boundary';
    queueBtn.addEventListener('click', () => queue(r.id));
    actions.appendChild(queueBtn);
  }

  tr.append(when, type, track, message, from, ip, status, actions);
  return tr;
}

export async function loadRequests() {
  const status = el('requests-filter').value;
  const { requests } = await api(`/api/requests${status ? `?status=${status}` : ''}`);
  el('requests-table-body').replaceChildren(...requests.map(row));
  el('requests-empty').hidden = requests.length > 0;
}

// app.js re-runs startRequestsView() on every visit to this tab -- bind the
// DOM listeners once so N visits don't fire N identical requests per click.
let bound = false;

export function startRequestsView() {
  if (!bound) {
    bound = true;
    el('requests-filter').addEventListener('change', loadRequests);
    el('requests-refresh').addEventListener('click', loadRequests);
  }
  loadRequests();
}
