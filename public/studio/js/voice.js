// Voice & station scripts status (issue #2 B.5). Read-only -- the mode is a
// config.json decision, and the view states that instead of offering a fake
// toggle. Everything shown is a filesystem/config fact from the server.
import { api } from './api.js';

const el = (id) => document.getElementById(id);

function kv(label, value, cls = '') {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const k = document.createElement('span');
  k.className = 'kv-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = `kv-value ${cls}`;
  v.textContent = value;
  row.append(k, v);
  return row;
}

function boolText(b) {
  return b ? '✓' : '—';
}

export async function loadVoice() {
  let v;
  try {
    v = await api('/api/voice');
  } catch (err) {
    // Same alert-on-error pattern as shows.js -- a failed load must not
    // leave silently stale status cards behind.
    window.alert('Napaka pri nalaganju stanja glasu: ' + err.message);
    return;
  }

  const summary = el('voice-summary');
  summary.replaceChildren(
    kv('Active mode', v.mode, 'accent'),
    kv('Known modes', v.knownModes.join(', ')),
    kv('Edge default voice', v.edge?.defaultVoice ?? '—'),
    kv('Edge fallback', v.edge?.fallback ?? '—'),
    kv('espeak default voice', v.espeak?.defaultVoice ?? '—'),
    kv('Note', v.readonlyNote, 'muted wrap')
  );

  const piper = el('voice-piper');
  // piper1-gpl voice keys live in v.piper.dataDir and may legitimately not
  // be downloaded yet (one-time piper.download_voices fetch on first use) --
  // that is a normal state, not a broken path, so it renders neutral.
  const piperModelLabel = v.piper.isKey ? `${v.piper.defaultVoice} (piper1-gpl voice key)` : v.piper.defaultVoice;
  const piperExistsValue = v.piper.modelExists ? '✓' : (v.piper.isKey ? '— (downloads on first use)' : '—');
  const piperExistsCls = v.piper.modelExists ? 'ok' : (v.piper.isKey ? '' : 'bad');
  piper.replaceChildren(
    kv('Python path', v.piper.pythonPath),
    kv('Default model', piperModelLabel),
    kv('Voice data dir', v.piper.dataDir ?? '—'),
    kv('Model file exists', piperExistsValue, piperExistsCls),
    ...Object.entries(v.piper.personas ?? {}).map(([name, p]) =>
      kv(`Persona ${name}`, `${p.piperVoice ?? 'default'} (speaker ${p.piperSpeaker ?? 'n/a'}, file ${p.modelExists === null ? 'default' : boolText(p.modelExists)})`)
    )
  );

  const clips = el('voice-clips');
  const clipRows = [kv('Clips dir', v.clips.dir), kv('Dir exists', boolText(v.clips.exists), v.clips.exists ? 'ok' : 'bad'), kv('Total clips', String(v.clips.totalClips))];
  for (const [persona, files] of Object.entries(v.clips.personas ?? {})) {
    clipRows.push(kv(`Persona ${persona}`, `${files.length} clip(s): ${files.slice(0, 6).join(', ')}${files.length > 6 ? ' …' : ''}`));
  }
  clips.replaceChildren(...clipRows);

  const pg = el('voice-pregen');
  pg.replaceChildren(
    kv('Pregenerated dir', v.pregenerated.dir),
    kv('Dir exists', boolText(v.pregenerated.exists), v.pregenerated.exists ? 'ok' : 'bad'),
    kv('General open', boolText(v.pregenerated.generalSlots?.['general_open.wav'])),
    kv('General close', boolText(v.pregenerated.generalSlots?.['general_close.wav'])),
    kv('General handoff (weather)', boolText(v.pregenerated.generalSlots?.['general_handoff_weather.wav'])),
    kv('Track-specific clips', String(v.pregenerated.trackClips ?? 0))
  );
}

export function startVoiceView() {
  loadVoice();
}
