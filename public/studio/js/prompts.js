import { api } from './api.js';

const scriptReviewEl = document.getElementById('script-review-prompt');
const saveScriptReviewButton = document.getElementById('save-script-review');
const scriptReviewMessageEl = document.getElementById('script-review-message');

const personasListEl = document.getElementById('personas-list');
const savePersonasButton = document.getElementById('save-personas');
const personasMessageEl = document.getElementById('personas-message');

let personas = {};

function setMessage(el, text, isError) {
  el.textContent = text;
  el.classList.toggle('error', Boolean(isError));
}

async function loadScriptReview() {
  try {
    const data = await api('/api/script-review');
    scriptReviewEl.value = data.systemPrompt ?? '';
  } catch (err) {
    setMessage(scriptReviewMessageEl, err.message, true);
  }
}

saveScriptReviewButton.addEventListener('click', async () => {
  setMessage(scriptReviewMessageEl, 'Saving...');
  try {
    await api('/api/script-review', { method: 'PUT', body: { systemPrompt: scriptReviewEl.value } });
    setMessage(scriptReviewMessageEl, 'Saved. Applies to the next script generated, no restart needed.');
  } catch (err) {
    setMessage(scriptReviewMessageEl, err.message, true);
  }
});

function renderPersonas() {
  personasListEl.innerHTML = '';
  for (const [id, persona] of Object.entries(personas).sort(([a], [b]) => a.localeCompare(b))) {
    // Built with textContent, not innerHTML: a system prompt containing
    // "</textarea>" would otherwise break out of the editor, and an id with
    // quotes could inject attributes.
    const row = document.createElement('div');
    row.className = 'persona-row';
    const header = document.createElement('div');
    header.className = 'persona-row-header';
    const name = document.createElement('strong');
    name.textContent = id;
    const voiceFile = document.createElement('span');
    voiceFile.className = 'voice-file';
    voiceFile.textContent = persona.voiceFile ?? '';
    header.append(name, voiceFile);
    const textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.dataset.personaId = id;
    textarea.value = persona.systemPrompt ?? '';
    row.append(header, textarea);
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

savePersonasButton.addEventListener('click', async () => {
  setMessage(personasMessageEl, 'Saving...');
  const updated = {};
  for (const [id, persona] of Object.entries(personas)) {
    const textarea = personasListEl.querySelector(`textarea[data-persona-id="${CSS.escape(id)}"]`);
    updated[id] = { ...persona, systemPrompt: textarea ? textarea.value : persona.systemPrompt };
  }
  try {
    await api('/api/personas', { method: 'PUT', body: { personas: updated } });
    personas = updated;
    setMessage(personasMessageEl, 'Saved. Applies to the next script generated, no restart needed.');
  } catch (err) {
    setMessage(personasMessageEl, err.message, true);
  }
});

export function startPromptsView() {
  loadScriptReview();
  loadPersonas();
}
