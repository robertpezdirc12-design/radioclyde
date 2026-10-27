import { api } from './api.js';

// Val 28 ("samo skripte brez AI modelov"): this view used to edit the LLM
// script-review prompt and per-persona system prompts. With the AI layer
// removed, a persona is purely a roster identity -- show briefs and scripts
// may only name personas from this list, and per-persona VOICE settings
// live in config.json (autoRadio.voice.personas), not here.
const personasListEl = document.getElementById('personas-list');
const newPersonaInput = document.getElementById('new-persona-id');
const addPersonaButton = document.getElementById('add-persona');
const savePersonasButton = document.getElementById('save-personas');
const personasMessageEl = document.getElementById('personas-message');

let personas = {};

function setMessage(el, text, isError) {
  el.textContent = text;
  el.classList.toggle('error', Boolean(isError));
}

function renderPersonas() {
  personasListEl.innerHTML = '';
  const ids = Object.keys(personas).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Seznam je prazen -- show-opisi ne morejo naslavljati nobene osebe.';
    personasListEl.appendChild(empty);
    return;
  }
  for (const id of ids) {
    // Built with textContent, not innerHTML: an id containing markup must
    // never break out of the row.
    const row = document.createElement('div');
    row.className = 'persona-row';
    const header = document.createElement('div');
    header.className = 'persona-row-header';
    const name = document.createElement('strong');
    name.textContent = id;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-small';
    remove.textContent = 'Odstrani';
    remove.addEventListener('click', () => {
      delete personas[id];
      renderPersonas();
    });
    header.append(name, remove);
    row.append(header);
    personasListEl.appendChild(row);
  }
}

async function loadPersonas() {
  try {
    const data = await api('/api/personas');
    personas = data.personas ?? {};
    renderPersonas();
  } catch (err) {
    setMessage(personasMessageEl, err.message, true);
  }
}

addPersonaButton.addEventListener('click', () => {
  const id = (newPersonaInput.value ?? '').trim();
  if (!id || personas[id]) {
    newPersonaInput.value = '';
    return;
  }
  personas[id] = {};
  newPersonaInput.value = '';
  renderPersonas();
});

newPersonaInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addPersonaButton.click();
  }
});

savePersonasButton.addEventListener('click', async () => {
  setMessage(personasMessageEl, 'Shranjujem...');
  try {
    await api('/api/personas', { method: 'PUT', body: { personas } });
    setMessage(personasMessageEl, 'Shranjeno. Velja za naslednji generirani scenarij, brez ponovnega zagona.');
  } catch (err) {
    setMessage(personasMessageEl, err.message, true);
  }
});

export function startPromptsView() {
  loadPersonas();
}
