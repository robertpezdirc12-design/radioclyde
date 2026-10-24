// Library browse + rotation health (issue #2 B.3). Rotation offenders come
// from the real aired history; the library table is the real local scan (or
// an explicit "Plex mode" note when no local dirs are configured).
import { api } from './api.js';

const el = (id) => document.getElementById(id);

function fmtDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function kv(label, value, cls = '') {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const k = document.createElement('span');
  k.className = 'kv-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = `kv-value ${cls}`;
  if (typeof value === 'string') v.textContent = value;
  else v.append(value);
  row.append(k, v);
  return row;
}

function historyRow(e) {
  const li = document.createElement('li');
  li.textContent = `${e.playedAt ? new Date(e.playedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''} — ${e.artist} — ${e.title}`;
  return li;
}

export async function loadLibrary() {
  const search = el('library-search').value.trim();
  const data = await api(`/api/library${search ? `?search=${encodeURIComponent(search)}` : ''}`);

  el('library-count').textContent = `${data.filteredTotal} of ${data.total} tracks`;
  const note = el('library-note');
  if (data.note) {
    note.textContent = data.note;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  const tbody = el('library-table-body');
  tbody.replaceChildren(
    ...data.tracks.map((t) => {
      const tr = document.createElement('tr');
      const cells = [t.artist, t.title, t.album, (t.genres ?? []).join(', '), fmtDuration(t.durationSeconds)];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c || '—';
        tr.appendChild(td);
      }
      return tr;
    })
  );
}

export async function loadRotation() {
  const data = await api('/api/rotation');
  const summary = el('rotation-summary');
  summary.replaceChildren();

  summary.append(
    kv('Rotation window', `${data.windowHours} h`),
    kv('Filler pool size', data.poolSize ?? 'not configured'),
    kv('Recently played entries', String(data.recentlyPlayed.length))
  );

  const offenders = data.offenders ?? [];
  const offenderBlock = document.createElement('div');
  offenderBlock.className = offenders.length ? 'warn-block' : 'ok-block';
  offenderBlock.textContent = offenders.length
    ? `${offenders.length} track(s) aired 2+ times inside the ${data.windowHours}h window:`
    : `No track repeated inside the ${data.windowHours}h rotation window.`;
  summary.append(offenderBlock);
  for (const o of offenders.slice(0, 10)) {
    summary.append(kv(`${o.artist} — ${o.title}`, `${o.count}× (last ${new Date(o.lastPlayedAt).toLocaleString('sl-SI')})`, o.count >= 3 ? 'bad' : 'warn'));
  }

  el('rotation-history').replaceChildren(...data.recentlyPlayed.slice(0, 15).map(historyRow));
}

// app.js re-runs startLibraryView() on every visit to this tab -- bind the
// DOM listener once so N visits don't stack N debounced reloads per keystroke.
let bound = false;

export function startLibraryView() {
  if (!bound) {
    bound = true;
    el('library-search').addEventListener('input', () => {
      clearTimeout(startLibraryView._t);
      startLibraryView._t = setTimeout(loadLibrary, 300);
    });
  }
  loadLibrary();
  loadRotation();
}
