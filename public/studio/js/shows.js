import { api } from './api.js';
import { startPodkastCard } from './podcast.js';

const searchEl = document.getElementById('shows-search');
const newShowButton = document.getElementById('new-show-button');
const tableBodyEl = document.getElementById('shows-table-body');
const listViewEl = document.getElementById('shows-list-view');
const editorEl = document.getElementById('show-editor-view');
const editorTitleEl = document.getElementById('show-editor-title');
const formEl = document.getElementById('show-editor-form');
const messageEl = document.getElementById('show-editor-message');
const deleteButton = document.getElementById('delete-show-button');
const backButton = document.getElementById('back-to-shows-button');
const idField = document.getElementById('field-id');

let allShows = [];
let editingId = null; // null while creating a new show

function setMessage(text, isError) {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', Boolean(isError));
}

function renderTable() {
  const query = searchEl.value.trim().toLowerCase();
  const filtered = allShows.filter(
    (s) => !query || s.title.toLowerCase().includes(query) || s.id.toLowerCase().includes(query)
  );
  tableBodyEl.innerHTML = '';
  for (const show of filtered) {
    // Plain textContent cells -- titles/ids/personas come from
    // user-editable files, so they must never round-trip through innerHTML.
    const tr = document.createElement('tr');
    const title = document.createElement('td');
    title.textContent = show.title;
    const id = document.createElement('td');
    id.className = 'mono';
    id.textContent = show.id;
    const personas = document.createElement('td');
    personas.textContent = show.personas.join(', ');
    const segments = document.createElement('td');
    segments.textContent = show.segments.join(', ');
    const duration = document.createElement('td');
    duration.className = 'mono';
    duration.textContent = show.durationMinutes ? `${show.durationMinutes}m` : '—';
    // Row click opens the editor, and so does Enter on the focused row --
    // but the real button in the trailing cell is the accessible path (a
    // table row must keep its row semantics, so it gets no role="button").
    tr.tabIndex = 0;
    tr.addEventListener('click', () => openEditor(show.id));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openEditor(show.id);
    });
    const actions = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-small';
    edit.textContent = 'Uredi';
    edit.setAttribute('aria-label', `Uredi: ${show.title}`);
    edit.addEventListener('click', (event) => {
      event.stopPropagation(); // the row's own click listener would re-open the same editor
      openEditor(show.id);
    });
    actions.appendChild(edit);
    tr.append(title, id, personas, segments, duration, actions);
    tableBodyEl.appendChild(tr);
  }
}

async function loadShows() {
  try {
    const { shows } = await api('/api/shows');
    allShows = shows;
    renderTable();
  } catch (err) {
    // Same alert-on-error pattern as requests.js -- a failed load must not
    // leave a silently stale table behind.
    window.alert('Napaka pri nalaganju oddaj: ' + err.message);
  }
}

function fillForm(fields) {
  formEl.elements['id'].value = fields.id ?? '';
  formEl.elements['title'].value = fields.title ?? '';
  document.getElementById('field-duration').value = fields.durationMinutes ?? '';
  formEl.elements['personas'].value = (fields.personas ?? []).join(', ');
  document.getElementById('field-segment-quiz').checked = (fields.segments ?? []).includes('quiz');
  document.getElementById('field-segment-weather').checked = (fields.segments ?? []).includes('weather');
  formEl.elements['repeatWindowDays'].value = fields.repeatWindowDays ?? '';
  document.getElementById('field-description').value = fields.description ?? '';
  document.getElementById('field-hosts').value = fields.hosts ?? '';
  document.getElementById('field-trackSelection').value = fields.trackSelectionText ?? '';
  document.getElementById('field-tone').value = fields.tone ?? '';
  document.getElementById('field-trackMoves').value = fields.trackMoves ?? '';
  document.getElementById('field-quiz').value = fields.quiz ?? '';
  document.getElementById('field-weather').value = fields.weather ?? '';
}

function showList() {
  editorEl.hidden = true;
  listViewEl.hidden = false;
}

function showEditor() {
  listViewEl.hidden = true;
  editorEl.hidden = false;
  window.scrollTo(0, 0);
}

async function openEditor(id) {
  editingId = id ?? null;
  setMessage('');
  showEditor();
  deleteButton.hidden = !id;
  idField.disabled = Boolean(id);
  if (id) {
    editorTitleEl.textContent = `Edit "${id}"`;
    try {
      const fields = await api(`/api/shows/${encodeURIComponent(id)}`);
      fillForm(fields);
    } catch (err) {
      // Leave the editor rather than showing a half-filled form a save
      // would then write back over the real show.
      setMessage(err.message, true);
      showList();
    }
  } else {
    editorTitleEl.textContent = 'New show';
    fillForm({});
  }
}

function readForm() {
  return {
    title: formEl.elements['title'].value.trim(),
    durationMinutes: document.getElementById('field-duration').value
      ? Number(document.getElementById('field-duration').value)
      : undefined,
    personas: formEl.elements['personas'].value.split(',').map((s) => s.trim()).filter(Boolean),
    segments: [
      document.getElementById('field-segment-quiz').checked && 'quiz',
      document.getElementById('field-segment-weather').checked && 'weather',
    ].filter(Boolean),
    repeatWindowDays: formEl.elements['repeatWindowDays'].value
      ? Number(formEl.elements['repeatWindowDays'].value)
      : undefined,
    description: document.getElementById('field-description').value,
    hosts: document.getElementById('field-hosts').value,
    trackSelectionText: document.getElementById('field-trackSelection').value,
    tone: document.getElementById('field-tone').value,
    trackMoves: document.getElementById('field-trackMoves').value,
    quiz: document.getElementById('field-quiz').value,
    weather: document.getElementById('field-weather').value,
  };
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('Saving...');
  try {
    const fields = readForm();
    if (editingId) {
      await api(`/api/shows/${encodeURIComponent(editingId)}`, { method: 'PUT', body: fields });
    } else {
      const id = idField.value.trim();
      await api('/api/shows', { method: 'POST', body: { id, ...fields } });
    }
    setMessage('Saved.');
    await loadShows();
  } catch (err) {
    setMessage(err.message, true);
  }
});

deleteButton.addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm(`Delete show "${editingId}"? It will also be removed from the schedule. This cannot be undone.`)) return;
  try {
    await api(`/api/shows/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
    showList();
    await loadShows();
  } catch (err) {
    setMessage(err.message, true);
  }
});

backButton.addEventListener('click', showList);

newShowButton.addEventListener('click', () => openEditor(null));
searchEl.addEventListener('input', renderTable);

export function startShowsView() {
  loadShows();
  startPodkastCard();
}
